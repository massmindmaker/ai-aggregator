---
name: aiag-deploy
description: >
  Deploy AIAG (this monorepo) to the bare-metal Timeweb VPS, restart pm2,
  apply DB migrations, and troubleshoot deploys. Use whenever the user wants to
  ship/deploy/release AIAG, restart a pm2 process on the VPS (web/gateway/worker/
  tma/agent-worker), run pending Drizzle migrations on the prod Postgres, SSH into
  the VPS, or debug a failed deploy (pm2 "Process not found", SSH "banner exchange"
  timeout / fail2ban ban, bun --frozen-lockfile drift, 404-after-deploy, build fail).
  Single source of truth for the AIAG release procedure.
---

# AIAG Deploy — single source of truth

The deploy is **`gh workflow run`-triggered** (NOT push-triggered). The GitHub runner
builds the tarball, uploads it to the VPS, extracts it into `releases/<ts-sha>`, and
**atomically swaps the `current` symlink BEFORE** the pm2 reload step. The pm2 reload
step reliably **fails** (see Troubleshooting), so after a "failed" deploy **the new
code is already on the VPS** — you only need to restart the pm2 processes manually.
Migrations are **never** run by the pipeline — apply them by hand over the SSH tunnel.

---

## HARD FACTS

| Thing | Value |
|---|---|
| Host | `5.129.200.99` (Ubuntu 24.04) |
| SSH user | `root` |
| SSH alias | `aiag-vps` (in `~/.ssh/config`) |
| SSH key | `~/.ssh/timeweb_vps` |
| Reach via | VPN HTTP proxy `connect -H 127.0.0.1:10809 %h %p` (direct :22 is MITM'd → banner timeout) |
| Public URL | https://ai-aggregator.ru |
| Release layout | `/srv/aiag/<app>/{releases/<ts-sha>,current}` (`current` = symlink) |
| Shared env | `/srv/aiag/shared/.env` (loaded by pm2 ecosystem at process start) |
| pm2 processes | `web`(:3000), `gateway`(:4000), `worker`, `tma`(:3100), `agent-worker` |
| Mode | **fork mode** (this is why `pm2 reload` breaks — see below) |
| Workflow | `.github/workflows/deploy-production.yml` |
| Local deploy alt | `ops/scripts/deploy.sh` |
| Preflight | `scripts/preflight-check.ts` (RKN/DPO now warn-only; hard gate = DATABASE_URL) |
| Last fully-green pipeline | run `25673044984` (2026-05-11) — every run since fails at pm2 reload |
| Package manager | Bun (root `bun.lock`); `ops/scripts/deploy.sh` uses `npm ci` on the VPS |

---

## 0. ONE-TIME SETUP — persistent SSH tunnel (do this first, avoids fail2ban)

**Why:** every `ssh aiag-vps …` opens a fresh TCP connection through the VPN exit IP.
After many connections in a session fail2ban on the VPS bans that exit IP → handshake
dropped → "banner exchange timeout". Fix = **multiplex one tunnel** with ControlMaster
so dozens of ops reuse a single TCP/SSH connection.

Put this block in `~/.ssh/config` (replace the existing bare `aiag-vps` block):

```sshconfig
Host aiag-vps
    HostName 5.129.200.99
    User root
    IdentityFile ~/.ssh/timeweb_vps
    StrictHostKeyChecking accept-new
    # Reach the box through the always-on VPN HTTP proxy (direct :22 is MITM'd)
    ProxyCommand connect -H 127.0.0.1:10809 %h %p
    # Multiplex: open ONE master tunnel, reuse it for every subsequent op
    ControlMaster auto
    ControlPath ~/.ssh/cm-%r@%h:%p
    ControlPersist 10m
    ServerAliveInterval 30
    ServerAliveCountInterval 3
```

First run opens the master; all later `ssh aiag-vps …` / `scp` reuse it for 10 min after
the last session closes. Inspect / tear down the master:

```bash
ssh -O check aiag-vps     # is the master alive?
ssh -O exit  aiag-vps     # close it (forces a fresh tunnel next time)
```

> Windows note: `connect` (connect-proxy) and a working `ssh` must be on PATH. Run these
> from the **Bash** tool (Git-Bash/OpenSSH), not PowerShell, so `~/.ssh/config` and the
> ControlPath socket resolve. If `connect` is missing, install it or use the
> `connect.exe` shipped with Git for Windows.

---

## 1. CANONICAL ONE-SHOT DEPLOY

### (a) Pre-deploy checks (local) — catch lockfile drift + type errors BEFORE the runner

```bash
cd "C:/Users/боб/projects/aggregator"

# 1. Lockfile drift guard (the --frozen-lockfile failure). If bun.lock changes,
#    a workspace pkg was added without committing the lock → commit it.
bun install --frozen-lockfile || {
  echo "LOCKFILE DRIFT — regenerating"; bun install; git add bun.lock
  echo "Now: git commit -m 'fix(deploy): regenerate bun.lock' && git push"
}
git diff --quiet bun.lock || echo "!! bun.lock is dirty — COMMIT & PUSH before deploy"

# 2. Type-check the app(s) you're shipping (the runner does NOT gate on tsc).
bun run --cwd apps/web tsc --noEmit || echo "!! web has type errors"

# 3. Make sure master is pushed — the workflow checks out the ref, not your worktree.
git status -sb && git push
```

### (b) Trigger the deploy

```bash
cd "C:/Users/боб/projects/aggregator"
gh workflow run deploy-production.yml --ref master -f apps=web,gateway,worker
# tma / agent-worker: add them to the apps list, e.g. -f apps=tma,agent-worker
```

### (c) Watch the build + upload + swap

```bash
sleep 5
RUN=$(gh run list --workflow=deploy-production.yml --limit 1 --json databaseId -q '.[0].databaseId')
gh run watch "$RUN" --interval 10 || true   # will end 'failure' at the pm2 reload step — EXPECTED
```

When it reaches **"Atomic swap + pm2 reload"** and fails there, the tarball is already
extracted and `current` is swapped on the VPS. The new code IS deployed. Continue to (d).

### (d) Restart pm2 (the reliable command) over the persistent tunnel

```bash
# restart (NOT reload) — fork-mode-safe; --update-env re-reads /srv/aiag/shared/.env
ssh aiag-vps 'pm2 restart web gateway worker --update-env && pm2 save'
# include tma/agent-worker if you deployed them:
# ssh aiag-vps 'pm2 restart web gateway worker tma agent-worker --update-env && pm2 save'

# confirm all online:
ssh aiag-vps 'pm2 status'
```

`pm2 save` persists the process list so `pm2 resurrect` (on reboot, via the systemd
startup unit) brings them back. Always `save` after a restart that you want to survive.

### (e) Apply pending migrations (manual — pipeline does NOT run them)

Drizzle migrations live in the repo; apply them against the **prod Postgres** through the
tunnel. Two ways — prefer running the project's migrate script on the VPS against the
already-deployed `current`:

```bash
# Run drizzle migrations from the freshly-deployed release on the VPS:
ssh aiag-vps 'set -a; . /srv/aiag/shared/.env; set +a; \
  cd /srv/aiag/gateway/current && bun run db:migrate'   # <-- confirm the script name
```

If there is no `db:migrate` script, tunnel the prod Postgres to localhost and run the
migration tool locally:

```bash
# Forward VPS Postgres :5432 → local :15432 over the SAME multiplexed tunnel
ssh -fNL 15432:127.0.0.1:5432 aiag-vps
# then point DATABASE_URL at localhost:15432 and run your drizzle-kit migrate
# (confirm exact command from packages/database/package.json)
ssh -O exit aiag-vps   # close forward + master when done
```

> UNCERTAIN: exact migrate command/script name — verify in `packages/database/package.json`
> before running. Migrations are forward-only; take a `pg_dump` first if risky.

### (f) Verify

```bash
# On-box health (each app's /health on its port):
ssh aiag-vps 'for p in 3000 4000 3100; do echo -n "$p: "; curl -fsS -m 5 http://127.0.0.1:$p/health && echo; done'

# Public:
curl -fsS -m 10 https://ai-aggregator.ru/health && echo OK
```

If public 404s/502s but on-box is healthy → see Troubleshooting "404-after-deploy".

---

## 2. PERMANENT FIX — make the pipeline self-heal (no more manual restart)

Root cause: the workflow runs `pm2 reload "$APP"`. **`pm2 reload` does not work in fork
mode** — it's a cluster-mode (0-downtime) op; on fork-mode processes it errors with
`[PM2][ERROR] Process <id> not found` (stale `pm_id` after a previous reload/restart).
Fix = fall back through restart, then start-from-ecosystem.

Replace **both** `pm2 reload "\$APP" --update-env` lines in
`.github/workflows/deploy-production.yml` (the main swap + the rollback path) with a
self-healing chain:

```bash
pm2 reload "$APP" --update-env \
  || pm2 restart "$APP" --update-env \
  || pm2 start /srv/aiag/shared/ecosystem.config.js --only "$APP" --update-env
pm2 save
```

(`pm2 startOrReload <ecosystem> --update-env` is the canonical idempotent form, but it
restarts the WHOLE ecosystem; the `--only "$APP"` chain above keeps it per-app. Confirm
the ecosystem path `/srv/aiag/shared/ecosystem.config.js` on the box — UNCERTAIN.)

**This commit is blocked from pushing** until the gh token has `workflow` scope:

```bash
gh auth refresh -h github.com -s workflow      # grant workflow scope (opens browser)
git add .github/workflows/deploy-production.yml
git commit -m "fix(deploy): self-heal pm2 reload||restart||start ecosystem"
git push
```

After this lands, the deploy is truly one-command (step (d) becomes unnecessary).
Mirror the same chain into `ops/scripts/deploy.sh` (lines ~102 and ~115).

---

## 3. TROUBLESHOOTING

| Symptom | Cause | Fix |
|---|---|---|
| `pm2 reload` → `[PM2][ERROR] Process <id> not found` (even though online) | `reload` is cluster-mode-only; fork-mode processes have a stale `pm_id` | `ssh aiag-vps 'pm2 restart <apps> --update-env && pm2 save'`. Permanent: §2 self-heal chain. |
| SSH "banner exchange timeout" after many connections | fail2ban banned the VPN exit IP (TCP accepted, handshake dropped) | Use the ControlMaster tunnel (§0) so you open ONE connection. To unban: see below. |
| SSH "banner exchange timeout" on a FRESH session | direct :22 is MITM'd by the VPN | Ensure `ProxyCommand connect -H 127.0.0.1:10809 %h %p` is in the config (§0). |
| `bun install --frozen-lockfile` fails on the runner | a workspace pkg was added without committing `bun.lock` | `bun install` locally → `git add bun.lock && git commit && git push`, re-trigger. |
| Build job fails (web build / tsc) | type error or missing dep | Reproduce locally: `bun run --cwd apps/web build`; fix, push, re-trigger. (Runner does NOT gate on `bun test`/`tsc` — pre-check locally per §1a.) |
| Deploy "succeeded uploading" but site shows OLD code / 404 | pm2 reload failed → process never restarted onto new `current` symlink | Run step (d): `pm2 restart <apps> --update-env && pm2 save`. Verify with §1f. |
| App boots then crashes (preflight exit 1) | `DATABASE_URL` missing in `/srv/aiag/shared/.env` (only hard gate left) | `ssh aiag-vps 'grep -c DATABASE_URL /srv/aiag/shared/.env'`; populate, then restart. |
| New DB columns / "relation does not exist" after deploy | migrations not applied (pipeline never runs them) | Run step (e) manually. |
| Public 404/502 but on-box `/health` OK | nginx upstream / wrong port / cert | `ssh aiag-vps 'nginx -t && systemctl reload nginx'`; check `pm2 status` ports match nginx `proxy_pass`. |
| Health-check rollback loop in pipeline | reload failed AND `/health` 404 → workflow flips symlink to prev | Ignore the pipeline rollback; manually `ln -sfn /srv/aiag/<app>/releases/<new> current` then restart (d). |

### fail2ban check / unban (run on the VPS, once you have a working tunnel)

```bash
ssh aiag-vps 'fail2ban-client status sshd'                  # list jails + banned IPs
ssh aiag-vps 'fail2ban-client set sshd unbanip <VPN_EXIT_IP>'   # unban the exit IP
```

Permanently whitelist the VPN exit IP so it's never banned (create/edit
`/etc/fail2ban/jail.d/sshd.local`, never the `.conf`):

```bash
ssh aiag-vps 'cat >/etc/fail2ban/jail.d/sshd.local <<EOF
[sshd]
ignoreip = 127.0.0.1/8 ::1 <VPN_EXIT_IP>
EOF
fail2ban-client reload'
```

> Find the exit IP from the VPS side: `ssh aiag-vps 'echo $SSH_CLIENT'` (first field), or
> `last -i | head`. UNCERTAIN: the VPN exit IP is dynamic-ish — re-check if it rotates;
> ControlMaster (§0) is the durable fix, whitelisting is the belt-and-suspenders.

---

## 4. QUICK REFERENCE (copy-paste happy path)

```bash
cd "C:/Users/боб/projects/aggregator"
bun install --frozen-lockfile && git diff --quiet bun.lock || echo "commit bun.lock!"
git push
gh workflow run deploy-production.yml --ref master -f apps=web,gateway,worker
RUN=$(gh run list --workflow=deploy-production.yml -L1 --json databaseId -q '.[0].databaseId'); gh run watch "$RUN" --interval 10 || true
ssh aiag-vps 'pm2 restart web gateway worker --update-env && pm2 save && pm2 status'
# migrations (if any) → §1e
curl -fsS -m 10 https://ai-aggregator.ru/health && echo DEPLOYED
```
