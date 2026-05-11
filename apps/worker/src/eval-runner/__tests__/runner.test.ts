import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { runEvaluation } from '../runner.js';

interface FakeProc extends EventEmitter {
  stdin: { write: (s: string) => void; end: () => void };
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: NodeJS.Signals) => void;
}

function makeProc(): FakeProc {
  const p = new EventEmitter() as FakeProc;
  p.stdin = { write: vi.fn(), end: vi.fn() };
  p.stdout = new EventEmitter();
  p.stderr = new EventEmitter();
  p.kill = vi.fn();
  return p;
}

describe('runEvaluation', () => {
  it('parses score from stdout JSON on success', async () => {
    const proc = makeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const promise = runEvaluation(
      {
        evaluatorScript: 'print(1)',
        submissionFiles: [],
        inputJson: { foo: 'bar' },
        timeoutMs: 5000,
      },
      // cast spawn impl to satisfy type
      spawn as unknown as typeof import('node:child_process').spawn
    );
    // emit data and exit
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from('{"score":0.5}'));
      proc.emit('exit', 0);
    });
    const r = await promise;
    expect(r.ok).toBe(true);
    expect(r.score).toBe(0.5);
    expect(spawn).toHaveBeenCalled();
  });

  it('returns invalid JSON error when stdout is not parseable', async () => {
    const proc = makeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const promise = runEvaluation(
      {
        evaluatorScript: 'print(1)',
        submissionFiles: [],
        inputJson: {},
        timeoutMs: 5000,
      },
      spawn as unknown as typeof import('node:child_process').spawn
    );
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from('not json'));
      proc.emit('exit', 0);
    });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Invalid JSON output');
  });

  it('returns error containing stderr on non-zero exit', async () => {
    const proc = makeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const promise = runEvaluation(
      {
        evaluatorScript: '',
        submissionFiles: [],
        inputJson: {},
        timeoutMs: 5000,
      },
      spawn as unknown as typeof import('node:child_process').spawn
    );
    setImmediate(() => {
      proc.stderr.emit('data', Buffer.from('boom'));
      proc.emit('exit', 1);
    });
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toContain('boom');
  });

  it('reports timeout when SIGKILL fired', async () => {
    const proc = makeProc();
    const spawn = vi.fn().mockReturnValue(proc);
    const promise = runEvaluation(
      {
        evaluatorScript: '',
        submissionFiles: [],
        inputJson: {},
        timeoutMs: 5,
      },
      spawn as unknown as typeof import('node:child_process').spawn
    );
    // simulate kill triggering exit
    setTimeout(() => proc.emit('exit', null), 30);
    const r = await promise;
    expect(r.ok).toBe(false);
    expect(r.error).toBe('timeout');
  });
});
