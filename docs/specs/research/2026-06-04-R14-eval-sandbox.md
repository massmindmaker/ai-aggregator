# R-14 — Sandbox for the eval / contest runner

> **Research date:** 2026-06-04 · **Author:** research subagent · **Status:** advisory (contests deferred; this is an open SECURITY-TODO from `/SECURITY.md` — "eval-runner nsjail sandbox")
> **Question:** Which isolation tech runs UNTRUSTED submitted code/agents on our infra without endangering the live money path on the same box?
> **Constraints recap:** Linux VPS, Node/Bun runtime, current prod = **2GB Timeweb VPS** running 5 pm2 procs incl. the live billing/auth path (`agent-worker`, `gateway`). Untrusted code must never reach that box's kernel/network/secrets.

---

## TL;DR / Recommendation

**Do NOT run untrusted submissions on the 2GB prod box at all** — not even sandboxed. The pragmatic plan:

1. **Phase 0 (cheapest, ship-when-contests-arrive):** run eval submissions on a **separate cheap Timeweb VPS / throwaway host**, inside **gVisor (`runsc`, systrap platform)** wrapping a per-submission **throwaway OCI container** that is: non-root + user-namespaced, `--network none`, read-only rootfs, strict cgroup memory/CPU/pids caps, wall-clock timeout, no host mounts, no secrets in env. gVisor adds a second kernel-isolation layer so a container escape does not equal a host-kernel compromise.
2. **Phase 1 (if we ever take arbitrary native binaries / high volume / paid contests):** move to **Firecracker microVMs** on a **bare-metal or KVM-passthrough host** (Timeweb cloud VPS usually does NOT expose nested KVM — verify before committing). Firecracker is the strongest isolation and the cleanest "blast-radius = one VM" story, at the cost of a dedicated host with hardware virt.

**`nsjail` alone is not enough** for arbitrary untrusted code (shared host kernel; it's a configurable toolkit, not a turnkey VM boundary). **Daytona** is the fastest path to a managed feature but is effectively a hosted SaaS / heavy self-host — overkill and off-strategy for a deferred contest feature.

---

## Option comparison

Security ranking for untrusted code is well established (Fly.io workload-isolation writeup, gVisor docs, Firecracker docs):
**Firecracker (HW virt) > gVisor (userland kernel) > hardened Docker/nsjail (shared kernel) > language-runtime sandboxes.**

| Option | Isolation boundary | Per-instance overhead | Setup cost | Runs on plain VPS (no nested virt)? | Fit for us |
|---|---|---|---|---|---|
| **nsjail** | Shared host kernel (namespaces + seccomp-bpf + cgroups + rlimits) | Tiny (~process-level) | **Med–High** — it's a *toolkit*, you author the seccomp policy / mounts / limits yourself; misconfig = escape | Yes | Useful as an *inner* layer; **insufficient alone** for arbitrary code |
| **gVisor (`runsc`)** | Userland re-implemented kernel (Go) intercepts syscalls; host kernel barely touched | Sentry = small fixed + per-resource memory; "low-double-digit %" CPU hit; bad for syscall/network-heavy, fine for CPU-bound short jobs | **Low–Med** — drop-in OCI runtime (`runsc`), works under Docker/containerd | **Yes** — **systrap** platform needs only seccomp; runs on a normal VPS without nested KVM (KVM platform optional, faster on bare metal) | **Best pragmatic pick** |
| **Firecracker microVM** | Full HW virtualization (KVM); separate guest kernel; VMM ~40 syscalls in Rust | **< 5 MiB** mem overhead/VM; ~125 ms boot; 150 VMs/s/host | **High** — needs KVM, a guest kernel/rootfs build, jailer, a control plane (or Kata) | **No** — needs hardware virt; nested virt is flaky/often disabled on cloud VPS → **dedicated host** | Best isolation; reserve for Phase 1 / volume |
| **Daytona sandboxes** | Per-sandbox dedicated kernel + fs + net (OCI/Docker based), ~90 ms start | Managed; self-host is a full platform | **High** (self-host) or vendor lock-in (managed SaaS) | Self-host needs its own infra | Overkill for a deferred feature; off-strategy |
| **Throwaway container (plain Docker), hardened** | Shared host kernel | Minimal | Low | Yes | OK as the *unit of work*, but **plain containers are not a secure sandbox** for untrusted code — must be wrapped by gVisor/Firecracker |

### Key per-source facts (cited)

- **nsjail** — "lightweight process isolation tool that utilizes Linux namespaces, cgroups, rlimits and seccomp-bpf." Positioned as a **toolkit, not a turnkey sandbox**; security depends entirely on your config. Source: github.com/google/nsjail (accessed 2026-06-04).
- **gVisor** — userland kernel in Go; "low-double-digits %" perf hit; good for CPU-bound/short-lived sandboxes, poor for syscall-/network-/fs-heavy workloads; per-sandbox memory = "small, mostly fixed" + varies with open resources. Source: gvisor.dev/docs/architecture_guide/performance/ (accessed 2026-06-04).
- **gVisor platforms** — **systrap** (default since mid-2023) needs only seccomp and **runs on VMs without nested virtualization**; KVM platform is faster on bare metal; ptrace deprecated. This is what makes gVisor viable on an ordinary Timeweb VPS. Source: gvisor.dev/docs/architecture_guide/platforms/ (accessed 2026-06-04).
- **Firecracker** — "<5 MiB memory overhead" per microVM, boot to user code in ~125 ms, 150 microVMs/s/host; **requires 64-bit CPU with hardware virtualization (KVM)**. Built by AWS for Lambda/Fargate multi-tenant untrusted code. Source: firecracker-microvm.github.io (accessed 2026-06-04).
- **Spectrum/ranking** — Firecracker > gVisor > hardened Docker > runtime sandboxes; Firecracker "requires bare metal; infrastructure cost"; and the single most valuable control is **cutting network exposure**, often higher-ROI than elaborate process isolation. Source: fly.io/blog/sandboxing-and-workload-isolation (accessed 2026-06-04).
- **Daytona** — sandboxes with "dedicated kernel, filesystem, network stack," OCI/Docker-based, ~90 ms start; offered as managed cloud **and** self-host/OSS, but self-host infra is a full platform. Source: daytona.io/docs (accessed 2026-06-04).

---

## Co-existence with the 2GB prod box

**Verdict: it cannot, and should not, share the prod box.**

- The prod VPS already runs `web`, `gateway`, `tma`, `agent-worker`, `worker` on 2GB and per `/CLAUDE.md` "cannot host Hermes pods." There is no RAM headroom for an isolation layer + untrusted workloads.
- Co-tenancy violates `/SECURITY.md`: the money path (`settleRun`, `AIAG_GATEWAY_KEY`, `TMA_JWT_SECRET`, BYOK AES keys in `/srv/aiag/shared/.env`) must never be on the same kernel/host as attacker-controlled code. A single container/kernel escape on a shared box reaches those secrets.
- **gVisor** *can* technically run on a plain VPS (systrap, no nested virt) — but put it on a **separate disposable VPS**, not the prod box. The separate host needs no special hardware → matches Timeweb's standard cloud VPS.
- **Firecracker** needs hardware virt (KVM). Standard Timeweb cloud VPS typically does **not** pass through nested KVM; you'd need a **bare-metal/dedicated** plan. Verify `ls /dev/kvm` + `kvm-ok` on any candidate host before committing to Firecracker.

### Defence-in-depth checklist for the eval host (apply regardless of layer)

- Separate host, separate network segment, **no route to the prod DB / gateway / Redis**.
- Submission process: `--network none`, read-only rootfs, non-root + userns-remap, seccomp default-deny-ish, drop all caps, cgroup mem/CPU/pids caps, hard wall-clock + CPU-time timeout, no host bind mounts, **zero secrets in env**.
- Treat output as untrusted (sanitize before it touches any prod surface).
- Network exposure reduction first (Fly.io point) — most contest submissions need no egress at all.

---

## Recommended path

1. **Now (contests deferred):** keep nothing running. Document this file as the decision.
2. **When contests ship — Phase 0:** spin a **separate small Timeweb VPS**; run submissions as **gVisor (`runsc`, systrap) + hardened throwaway OCI container** per the checklist. Lowest setup cost, no special hardware, real second isolation layer. This supersedes the bare "nsjail" SECURITY-TODO (nsjail can still be the inner layer, but gVisor gives the kernel boundary nsjail lacks).
3. **If contests grow / accept native binaries / become paid — Phase 1:** add a **bare-metal/KVM host running Firecracker microVMs** (consider Kata Containers for the OCI-on-Firecracker glue). Strongest isolation, "<5 MiB"/VM, but a dedicated host is mandatory.

**Recommended isolation approach: gVisor (`runsc`, systrap platform) wrapping a hardened, network-less, read-only, throwaway OCI container, on a SEPARATE disposable VPS — never the 2GB prod box. Escalate to Firecracker microVMs on a dedicated KVM/bare-metal host only when volume or native-binary submissions demand it.**

## Sources
- github.com/google/nsjail — accessed 2026-06-04
- gvisor.dev/docs/architecture_guide/performance/ — accessed 2026-06-04
- gvisor.dev/docs/architecture_guide/platforms/ — accessed 2026-06-04
- firecracker-microvm.github.io — accessed 2026-06-04
- fly.io/blog/sandboxing-and-workload-isolation — accessed 2026-06-04
- daytona.io/docs — accessed 2026-06-04

## Verification flags
- "150 microVMs/s/host", "<5 MiB", "~125 ms" come from Firecracker's own marketing docs — directionally reliable, exact numbers workload-dependent; re-benchmark before capacity planning.
- gVisor "low-double-digit %" CPU hit is a documented range, not a fixed number; syscall/network-heavy eval jobs can be much worse — bench the actual submission profile.
- **Timeweb nested-KVM availability was NOT independently confirmed** (web search tools were 400/404 during this session). Confirm `/dev/kvm` on any candidate host before choosing Firecracker.
