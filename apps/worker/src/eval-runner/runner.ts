import { spawn, type SpawnOptions } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export interface EvalRunOptions {
  evaluatorScript: string; // python source
  submissionFiles: Record<string, string>; // file → content
  inputJson: unknown;
  /** Default 5min */
  timeoutMs?: number;
}

export interface EvalRunResult {
  ok: boolean;
  score?: number;
  output?: string;
  error?: string;
}

/**
 * Spawn override for tests (mock child_process). Real impl uses node:child_process.
 */
export type SpawnImpl = typeof spawn;

// SECURITY-TODO Phase 2: replace systemd-run with nsjail or k3s sandboxed pod
// for stronger isolation. Current implementation requires sudoers entry for
// the worker user (NOPASSWD on /usr/bin/systemd-run --scope ...).
//
// Layered defenses already present:
//   - PrivateNetwork=yes blocks egress
//   - ProtectSystem=strict + ReadWritePaths limits FS writes
//   - NoNewPrivileges + uid=nobody drop privileges
//   - MemoryLimit/CPUQuota/TasksMax bound resource usage
//   - SIGKILL timeout caps wallclock

export async function runEvaluation(
  opts: EvalRunOptions,
  spawnImpl: SpawnImpl = spawn
): Promise<EvalRunResult> {
  const workDir = await mkdtemp(join(tmpdir(), 'aiag-eval-'));
  try {
    await writeFile(join(workDir, 'evaluator.py'), opts.evaluatorScript);
    await writeFile(join(workDir, 'input.json'), JSON.stringify(opts.inputJson));
    for (const [name, content] of Object.entries(opts.submissionFiles)) {
      await writeFile(join(workDir, name), content);
    }

    return await new Promise<EvalRunResult>((resolve) => {
      const isLinux = process.platform === 'linux';
      const cmd = isLinux ? 'systemd-run' : 'python3';
      const args = isLinux
        ? [
            '--scope',
            '--quiet',
            '--uid=nobody',
            '--gid=nogroup',
            '-p',
            'MemoryLimit=1G',
            '-p',
            'CPUQuota=200%',
            '-p',
            'TasksMax=64',
            '-p',
            'NoNewPrivileges=true',
            '-p',
            'PrivateNetwork=yes',
            '-p',
            'LimitFSIZE=268435456', // 256 MB per file (RLIMIT_FSIZE in bytes)
            '-p',
            'LimitNOFILE=256',
            '-p',
            'PrivateTmp=yes',
            '-p',
            'ProtectHome=yes',
            '-p',
            'ProtectSystem=strict',
            '-p',
            `ReadWritePaths=${workDir}`,
            '/usr/bin/python3',
            `${workDir}/evaluator.py`,
          ]
        : [join(workDir, 'evaluator.py')];

      const spawnOpts: SpawnOptions = { cwd: workDir, stdio: ['pipe', 'pipe', 'pipe'] };
      const proc = spawnImpl(cmd, args, spawnOpts);
      let out = '';
      let err = '';
      let timedOut = false;

      proc.stdout?.on('data', (d: Buffer) => {
        out += d.toString();
      });
      proc.stderr?.on('data', (d: Buffer) => {
        err += d.toString();
      });

      const killer = setTimeout(() => {
        timedOut = true;
        proc.kill('SIGKILL');
      }, opts.timeoutMs ?? 5 * 60_000);

      proc.on('error', (e) => {
        clearTimeout(killer);
        resolve({ ok: false, error: e.message, output: out });
      });

      proc.on('exit', (code) => {
        clearTimeout(killer);
        if (timedOut) {
          return resolve({ ok: false, error: 'timeout', output: out });
        }
        if (code !== 0) {
          return resolve({ ok: false, error: err || `exit ${code}`, output: out });
        }
        try {
          const parsed = JSON.parse(out) as { score?: number };
          resolve({ ok: true, score: parsed.score, output: out });
        } catch {
          resolve({ ok: false, error: 'Invalid JSON output', output: out });
        }
      });

      try {
        proc.stdin?.write(JSON.stringify(opts.inputJson));
        proc.stdin?.end();
      } catch {
        // stdin may already be closed if spawn failed; the 'error'/'exit'
        // handler will resolve the promise.
      }
    });
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
