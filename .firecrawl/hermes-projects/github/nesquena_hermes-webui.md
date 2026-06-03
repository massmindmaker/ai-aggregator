[Skip to content](https://github.com/nesquena/hermes-webui#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/nesquena/hermes-webui) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/nesquena/hermes-webui) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/nesquena/hermes-webui) to refresh your session.Dismiss alert

{{ message }}

[nesquena](https://github.com/nesquena)/ **[hermes-webui](https://github.com/nesquena/hermes-webui)** Public

- [Notifications](https://github.com/login?return_to=%2Fnesquena%2Fhermes-webui) You must be signed in to change notification settings
- [Fork\\
818](https://github.com/login?return_to=%2Fnesquena%2Fhermes-webui)
- [Star\\
6.4k](https://github.com/login?return_to=%2Fnesquena%2Fhermes-webui)


master

[**31** Branches](https://github.com/nesquena/hermes-webui/branches) [**377** Tags](https://github.com/nesquena/hermes-webui/tags)

[Go to Branches page](https://github.com/nesquena/hermes-webui/branches)[Go to Tags page](https://github.com/nesquena/hermes-webui/tags)

Go to file

Code

Open more actions menu

## Folders and files

| Name | Name | Last commit message | Last commit date |
| --- | --- | --- | --- |
| ## Latest commit<br>[![nesquena-hermes](https://avatars.githubusercontent.com/u/272340397?v=4&size=40)](https://github.com/nesquena-hermes)[nesquena-hermes](https://github.com/nesquena/hermes-webui/commits?author=nesquena-hermes)<br>[Release v0.51.30 — Release G (offline recovery + PWA hardening + opt-…](https://github.com/nesquena/hermes-webui/commit/0b7e1e60e85e340ef28dd69e19e25a2bd9cf0c0a)<br>Open commit detailssuccess<br>17 hours agoMay 8, 2026<br>[0b7e1e6](https://github.com/nesquena/hermes-webui/commit/0b7e1e60e85e340ef28dd69e19e25a2bd9cf0c0a) · 17 hours agoMay 8, 2026<br>## History<br>[1,681 Commits](https://github.com/nesquena/hermes-webui/commits/master/) <br>Open commit details<br>[View commit history for this file.](https://github.com/nesquena/hermes-webui/commits/master/) 1,681 Commits |
| [.github/workflows](https://github.com/nesquena/hermes-webui/tree/master/.github/workflows "This path skips through empty directories") | [.github/workflows](https://github.com/nesquena/hermes-webui/tree/master/.github/workflows "This path skips through empty directories") | [ci: install mcp + pytest-asyncio in CI; importorskip in test\_mcp\_serv…](https://github.com/nesquena/hermes-webui/commit/0590d597a3bb07160be3254e255c6bcf4504e5d9 "ci: install mcp + pytest-asyncio in CI; importorskip in test_mcp_server.py  CI failed on stage-323 because: 1. mcp_server.py imports the 'mcp' package (optional runtime dep) — only    users who actually run the MCP integration install it. CI runs with    stdlib-only deps (pyyaml + pytest + pytest-timeout). 2. tests/test_mcp_server.py uses pytest.mark.asyncio which requires    pytest-asyncio — not installed in CI.  Fix: - Add pytest-asyncio to CI install line. - Try-install mcp; if it fails (Python 3.13 wheel issues, etc.) the test   module uses pytest.importorskip and skips cleanly without breaking the   matrix. - tests/test_mcp_server.py: add module-level importorskip for both 'mcp'   and 'pytest_asyncio' as a safety net.  Local: 4947/4947 still pass after change.") | 19 hours agoMay 8, 2026 |
| [api](https://github.com/nesquena/hermes-webui/tree/master/api "api") | [api](https://github.com/nesquena/hermes-webui/tree/master/api "api") | [Stage 325: PR](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [#1929](https://github.com/nesquena/hermes-webui/pull/1929) [— feat: add opt-in session endless scroll by](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [@ai-…](https://github.com/ai-ag2026) | 18 hours agoMay 8, 2026 |
| [docs](https://github.com/nesquena/hermes-webui/tree/master/docs "docs") | [docs](https://github.com/nesquena/hermes-webui/tree/master/docs "docs") | [security: harden production Docker image](https://github.com/nesquena/hermes-webui/commit/b1b0cedbe928fd1e237970f8f52476cbd2d48905 "security: harden production Docker image") | 18 hours agoMay 8, 2026 |
| [scripts](https://github.com/nesquena/hermes-webui/tree/master/scripts "scripts") | [scripts](https://github.com/nesquena/hermes-webui/tree/master/scripts "scripts") | [fix: add workspace user turn repair utility](https://github.com/nesquena/hermes-webui/commit/4c03fdfaa837ad655b992c0e3490b6aa9e5c1829 "fix: add workspace user turn repair utility") | 2 days agoMay 7, 2026 |
| [static](https://github.com/nesquena/hermes-webui/tree/master/static "static") | [static](https://github.com/nesquena/hermes-webui/tree/master/static "static") | [Stage 325: PR](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [#1929](https://github.com/nesquena/hermes-webui/pull/1929) [— feat: add opt-in session endless scroll by](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [@ai-…](https://github.com/ai-ag2026) | 18 hours agoMay 8, 2026 |
| [tests](https://github.com/nesquena/hermes-webui/tree/master/tests "tests") | [tests](https://github.com/nesquena/hermes-webui/tree/master/tests "tests") | [Stage 325: PR](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [#1929](https://github.com/nesquena/hermes-webui/pull/1929) [— feat: add opt-in session endless scroll by](https://github.com/nesquena/hermes-webui/commit/bec4433c2acdc98554d158ddf8109c8e42411fba "Stage 325: PR #1929 — feat: add opt-in session endless scroll by @ai-ag2026  Conflict resolution: both #1928 (session jump buttons) and #1929 (endless scroll) add their own settings/UI/i18n keys. Resolved by keeping both — the features are independent opt-in toggles.") [@ai-…](https://github.com/ai-ag2026) | 18 hours agoMay 8, 2026 |
| [.dockerignore](https://github.com/nesquena/hermes-webui/blob/master/.dockerignore ".dockerignore") | [.dockerignore](https://github.com/nesquena/hermes-webui/blob/master/.dockerignore ".dockerignore") | [fix(review): 5 issues found in agent review of PR](https://github.com/nesquena/hermes-webui/commit/574cd2cf702255df11d942195a8b6bd240daeb71 "fix(review): 5 issues found in agent review of PR #40  BUG-1 (critical): CSS cascade — .sidebar{position:relative} and .rightpanel{position:relative} at line 528/530 appeared after the @media(max-width:640px) block and silently overrode the position:fixed overlay behavior needed for the mobile slide-in. Wrapped both in @media(min-width:641px) so they only apply on desktop.  BUG-2 (medium): mobileSwitchPanel() in boot.js always reopened the sidebar overlay after closing it, with a stale comment saying 'close after a moment' but no actual auto-close. For the 'chat' panel, the content lives in the main area — reopening the sidebar obstructs it. Fixed: only open sidebar for non-chat panels; chat tap closes sidebar.  BUG-3 (medium): Dockerfile was missing 'pip install -r requirements.txt'. pyyaml (required by api/config.py) is not in the python:3.12-slim base image — the container would fail at startup with ImportError.  SEC-2 (medium): No .dockerignore — COPY . /app included .git/, tests/, and .env* in every image. Added .dockerignore excluding these.  NIT-3: docker-compose.yml used ${HERMES_HOME:-~/.hermes} but Docker Compose does not shell-expand ~ in default values. Changed to ${HERMES_HOME:-${HOME}/.hermes}.  Tests: 415 passed, 0 failed (same as pre-fix).") [#40](https://github.com/nesquena/hermes-webui/pull/40) | last monthApr 3, 2026 |
| [.env.docker.example](https://github.com/nesquena/hermes-webui/blob/master/.env.docker.example ".env.docker.example") | [.env.docker.example](https://github.com/nesquena/hermes-webui/blob/master/.env.docker.example ".env.docker.example") | [v0.50.260: Docker reliability batch - PR](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") [#1428](https://github.com/nesquena/hermes-webui/pull/1428) [\+ broader UX/docs impr…](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") | last weekMay 1, 2026 |
| [.env.example](https://github.com/nesquena/hermes-webui/blob/master/.env.example ".env.example") | [.env.example](https://github.com/nesquena/hermes-webui/blob/master/.env.example ".env.example") | [fix: align .env.example state dir default with bootstrap.py](https://github.com/nesquena/hermes-webui/commit/b2fbacf84714316d866622c9a98763922a1730b2 "fix: align .env.example state dir default with bootstrap.py  From PR #1331.  Co-authored-by: Leon.C <160379708+zichen0116@users.noreply.github.com>") | last weekApr 30, 2026 |
| [.gitignore](https://github.com/nesquena/hermes-webui/blob/master/.gitignore ".gitignore") | [.gitignore](https://github.com/nesquena/hermes-webui/blob/master/.gitignore ".gitignore") | [docs(troubleshooting): bake the](https://github.com/nesquena/hermes-webui/commit/29878259ca26d500ed19403854a3326772e5db8d "docs(troubleshooting): bake the #1695 diagnostic flow into the error message + a new troubleshooting doc  Closes #1695.  @Patrick-81 reported the bare \"AIAgent not available -- check that hermes-agent is on sys.path\" error on a symlinked install (~/Programmes/hermes-agent linked to ~/hermes-agent). The maintainer's response — three diagnostic commands plus `pip install -e .` in the agent dir — fixed it for them. This PR captures both halves of that learning so the next user with the same shape doesn't have to file a new issue:  1. **Error message diagnostic block.** New helper    `_aiagent_import_error_detail()` in api/streaming.py builds a multi-line    diagnostic when the import fails, including:      - the running Python interpreter      - HERMES_WEBUI_AGENT_DIR (set value, or \"(not set)\")      - sys.path entries that mention hermes/agent (or \"no entries mention...\"        — itself a strong diagnostic signal)      - the most-common fix (`pip install -e .` in the agent dir)      - a pointer to docs/troubleshooting.md     The original error message string is preserved as the FIRST line so    existing log scrapers and docs-search keep matching.     Helper is kept as a separate function so it stays out of the hot path    until we actually need to raise — building it on every successful import    would be wasted work.  2. **New docs/troubleshooting.md.** Symptom → Why → Diagnostic commands →    Fix → When-to-file-a-bug template, with one entry to start: the    \"AIAgent not available\" flow Patrick-81 walked through. Future    recurring failure modes follow the same template. Required a one-line    addition to .gitignore — docs/* is gitignored with an allowlist, and    the new file needed `!docs/troubleshooting.md` to be tracked.  3. **README link.** docs/troubleshooting.md added to the `## Docs` section    so users know where to look first.  13 regression tests in tests/test_1695_aiagent_import_error_detail.py: 9 for the helper output shape (preserves original message line, includes running python, shows HERMES_WEBUI_AGENT_DIR set/unset both ways, includes pip-install-e hint, points at troubleshooting doc, lists relevant sys.path entries when present, says \"no entries...\" when absent, output is multi-line) plus 4 for the docs-presence regression (file exists, has the AIAgent section, includes pip install -e ., describes the diagnostic chain with readlink + agent/__init__.py verification).  190 streaming/aiagent tests pass after the change. ast.parse on api/streaming.py clean.  CI failure on prior push was due to the docs/* gitignore swallowing the new troubleshooting.md file silently — this commit adds the allowlist entry so the file is tracked.") [#1695](https://github.com/nesquena/hermes-webui/issues/1695) [diagnostic flow into the error …](https://github.com/nesquena/hermes-webui/commit/29878259ca26d500ed19403854a3326772e5db8d "docs(troubleshooting): bake the #1695 diagnostic flow into the error message + a new troubleshooting doc  Closes #1695.  @Patrick-81 reported the bare \"AIAgent not available -- check that hermes-agent is on sys.path\" error on a symlinked install (~/Programmes/hermes-agent linked to ~/hermes-agent). The maintainer's response — three diagnostic commands plus `pip install -e .` in the agent dir — fixed it for them. This PR captures both halves of that learning so the next user with the same shape doesn't have to file a new issue:  1. **Error message diagnostic block.** New helper    `_aiagent_import_error_detail()` in api/streaming.py builds a multi-line    diagnostic when the import fails, including:      - the running Python interpreter      - HERMES_WEBUI_AGENT_DIR (set value, or \"(not set)\")      - sys.path entries that mention hermes/agent (or \"no entries mention...\"        — itself a strong diagnostic signal)      - the most-common fix (`pip install -e .` in the agent dir)      - a pointer to docs/troubleshooting.md     The original error message string is preserved as the FIRST line so    existing log scrapers and docs-search keep matching.     Helper is kept as a separate function so it stays out of the hot path    until we actually need to raise — building it on every successful import    would be wasted work.  2. **New docs/troubleshooting.md.** Symptom → Why → Diagnostic commands →    Fix → When-to-file-a-bug template, with one entry to start: the    \"AIAgent not available\" flow Patrick-81 walked through. Future    recurring failure modes follow the same template. Required a one-line    addition to .gitignore — docs/* is gitignored with an allowlist, and    the new file needed `!docs/troubleshooting.md` to be tracked.  3. **README link.** docs/troubleshooting.md added to the `## Docs` section    so users know where to look first.  13 regression tests in tests/test_1695_aiagent_import_error_detail.py: 9 for the helper output shape (preserves original message line, includes running python, shows HERMES_WEBUI_AGENT_DIR set/unset both ways, includes pip-install-e hint, points at troubleshooting doc, lists relevant sys.path entries when present, says \"no entries...\" when absent, output is multi-line) plus 4 for the docs-presence regression (file exists, has the AIAgent section, includes pip install -e ., describes the diagnostic chain with readlink + agent/__init__.py verification).  190 streaming/aiagent tests pass after the change. ast.parse on api/streaming.py clean.  CI failure on prior push was due to the docs/* gitignore swallowing the new troubleshooting.md file silently — this commit adds the allowlist entry so the file is tracked.") | 4 days agoMay 5, 2026 |
| [ARCHITECTURE.md](https://github.com/nesquena/hermes-webui/blob/master/ARCHITECTURE.md "ARCHITECTURE.md") | [ARCHITECTURE.md](https://github.com/nesquena/hermes-webui/blob/master/ARCHITECTURE.md "ARCHITECTURE.md") | [docs: refresh markdown to v0.50.245 + add CONTRIBUTORS.md](https://github.com/nesquena/hermes-webui/commit/d356e081ed6f424d01dfe32f6fdd55c9209767d2 "docs: refresh markdown to v0.50.245 + add CONTRIBUTORS.md  - New CONTRIBUTORS.md: full ranked credit roll for all 66 contributors   (5+ tiers), with first/latest release versions, single-PR roll, and   attribution methodology. Generated from git log + gh pulls API +   CHANGELOG mention parsing.  - README.md: stack-ranked top-10 contributors table at the top of the   Contributors section, link to CONTRIBUTORS.md for the full list.   Updated test count (1898 → 3309). Refreshed @franksong2702 and   @bergeouss entries to reflect their broader bodies of work (now   the #1 and #2 external contributors).  - ARCHITECTURE.md: removed stale 'tracks upstream v0.50.36' header;   bumped current shipped build to v0.50.245 with current architecture   state notes (streaming-markdown vendoring, byte-range streaming,   configurable-model-badges).  - ROADMAP.md / SPRINTS.md / TESTING.md: header/last-updated bumps to   v0.50.245 and 3309 tests. SPRINTS.md 'Where we are now' section   refreshed for current CLI/Claude parity (~95% Claude parity now).  Generated by aggregating CHANGELOG attribution lines, gh PR API authors, and CHANGELOG version-section walks. Internal/bot accounts filtered out.") | last weekApr 30, 2026 |
| [BUGS.md](https://github.com/nesquena/hermes-webui/blob/master/BUGS.md "BUGS.md") | [BUGS.md](https://github.com/nesquena/hermes-webui/blob/master/BUGS.md "BUGS.md") | [docs: update ROADMAP, SPRINTS, and BUGS to v0.50.156 — 1903 tests](https://github.com/nesquena/hermes-webui/commit/095dbfd641cf571ef9a57db7b944021359b4832b "docs: update ROADMAP, SPRINTS, and BUGS to v0.50.156 — 1903 tests  Update sprint history table in ROADMAP.md through v0.50.156, fix test count header, add Known Limitations section to BUGS.md, update SPRINTS.md header. Reviewed by Opus — factually accurate, table column alignment fixed.") | 2 weeks agoApr 22, 2026 |
| [CHANGELOG.md](https://github.com/nesquena/hermes-webui/blob/master/CHANGELOG.md "CHANGELOG.md") | [CHANGELOG.md](https://github.com/nesquena/hermes-webui/blob/master/CHANGELOG.md "CHANGELOG.md") | [release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA har…](https://github.com/nesquena/hermes-webui/commit/bc4421a1b6a2c00b8deebb0e0f32c1bc6f13fee4 "release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA hardening + opt-in session jump buttons + opt-in endless-scroll)  Three-PR contributor batch (all from @ai-ag2026): - PR #1891: Browser offline recovery + PWA cache hardening - PR #1928: Opt-in session Start/End jump buttons - PR #1929: Opt-in session endless-scroll (builds on shipped #1927)  Tests: 4960 → 4977 (+17 net new). Browser API harness all-green. Manual browser verification on port 8789 passed. Opus advisor: SHIP-WITH-FIXES (both fast-follows are non-blocking).") | 18 hours agoMay 8, 2026 |
| [CONTRIBUTING.md](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTING.md "CONTRIBUTING.md") | [CONTRIBUTING.md](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTING.md "CONTRIBUTING.md") | [docs: add CONTRIBUTING.md](https://github.com/nesquena/hermes-webui/commit/28d226f5ce372f7afa3251ff19061016ab399542 "docs: add CONTRIBUTING.md  Co-authored-by: Aron Prins <pwf.aron@gmail.com>") | last monthApr 14, 2026 |
| [CONTRIBUTORS.md](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTORS.md "CONTRIBUTORS.md") | [CONTRIBUTORS.md](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTORS.md "CONTRIBUTORS.md") | [docs: refresh markdown to v0.50.245 + add CONTRIBUTORS.md](https://github.com/nesquena/hermes-webui/commit/d356e081ed6f424d01dfe32f6fdd55c9209767d2 "docs: refresh markdown to v0.50.245 + add CONTRIBUTORS.md  - New CONTRIBUTORS.md: full ranked credit roll for all 66 contributors   (5+ tiers), with first/latest release versions, single-PR roll, and   attribution methodology. Generated from git log + gh pulls API +   CHANGELOG mention parsing.  - README.md: stack-ranked top-10 contributors table at the top of the   Contributors section, link to CONTRIBUTORS.md for the full list.   Updated test count (1898 → 3309). Refreshed @franksong2702 and   @bergeouss entries to reflect their broader bodies of work (now   the #1 and #2 external contributors).  - ARCHITECTURE.md: removed stale 'tracks upstream v0.50.36' header;   bumped current shipped build to v0.50.245 with current architecture   state notes (streaming-markdown vendoring, byte-range streaming,   configurable-model-badges).  - ROADMAP.md / SPRINTS.md / TESTING.md: header/last-updated bumps to   v0.50.245 and 3309 tests. SPRINTS.md 'Where we are now' section   refreshed for current CLI/Claude parity (~95% Claude parity now).  Generated by aggregating CHANGELOG attribution lines, gh PR API authors, and CHANGELOG version-section walks. Internal/bot accounts filtered out.") | last weekApr 30, 2026 |
| [DESIGN.md](https://github.com/nesquena/hermes-webui/blob/master/DESIGN.md "DESIGN.md") | [DESIGN.md](https://github.com/nesquena/hermes-webui/blob/master/DESIGN.md "DESIGN.md") | [fix: persist activity disclosure state](https://github.com/nesquena/hermes-webui/commit/ee9ae29596ef46574bc5592f2a552a1e5589c679 "fix: persist activity disclosure state") | 3 days agoMay 6, 2026 |
| [Dockerfile](https://github.com/nesquena/hermes-webui/blob/master/Dockerfile "Dockerfile") | [Dockerfile](https://github.com/nesquena/hermes-webui/blob/master/Dockerfile "Dockerfile") | [security: harden production Docker image](https://github.com/nesquena/hermes-webui/commit/b1b0cedbe928fd1e237970f8f52476cbd2d48905 "security: harden production Docker image") | 18 hours agoMay 8, 2026 |
| [HERMES.md](https://github.com/nesquena/hermes-webui/blob/master/HERMES.md "HERMES.md") | [HERMES.md](https://github.com/nesquena/hermes-webui/blob/master/HERMES.md "HERMES.md") | [docs: rewrite HERMES.md with accurate 2026 market comparisons](https://github.com/nesquena/hermes-webui/commit/09325f1bdf49d5937322321a4c514bedc023fdd8 "docs: rewrite HERMES.md with accurate 2026 market comparisons  * docs: rewrite HERMES.md with accurate 2026 market comparisons  * fix: correct /loop and scheduling claims for Claude Code  Three factual errors corrected:  1. /loop is a native bundled skill available without any plugin. The doc    incorrectly described it as behavior from the ralph-wiggum plugin.    ralph-wiggum provides /ralph-loop, which is distinct: it iterates toward    a completion goal. /loop polls on a fixed schedule. Both exist and serve    different purposes.  2. claude.ai/code/scheduled is not a real usable URL or scheduling interface.    Removed the reference. Cloud scheduling is described as cloud-managed cron    with a 1-hour minimum interval.  3. 'your data leaves your hardware' was only half-true. Desktop scheduled tasks    run locally with full file access. Cloud tasks do leave your hardware. Rewrote    to be precise: the real distinction vs Hermes cron is that neither option runs    as a headless server daemon.  ---------  Co-authored-by: Nathan Esquenazi <nesquena@gmail.com>") | last monthApr 11, 2026 |
| [LICENSE](https://github.com/nesquena/hermes-webui/blob/master/LICENSE "LICENSE") | [LICENSE](https://github.com/nesquena/hermes-webui/blob/master/LICENSE "LICENSE") | [Hermes WebUI v0.1.0 — initial public release](https://github.com/nesquena/hermes-webui/commit/a4e2174c29b34a95f7123b732634afa696e60564 "Hermes WebUI v0.1.0 — initial public release") | 2 months agoMar 30, 2026 |
| [README.md](https://github.com/nesquena/hermes-webui/blob/master/README.md "README.md") | [README.md](https://github.com/nesquena/hermes-webui/blob/master/README.md "README.md") | [fix: support IPv6 bind address in QuietHTTPServer](https://github.com/nesquena/hermes-webui/commit/dcc40767887821cd864a4e9506a941dfa232e053 "fix: support IPv6 bind address in QuietHTTPServer  Detect IPv6 addresses (containing ':') in QuietHTTPServer.__init__ and set address_family to AF_INET6 before socket creation, fixing EAFNOSUPPORT when binding to :: or ::1.  Also updates the loopback check to recognize ::1 and the container warning to mention :: as the IPv6 equivalent of 0.0.0.0. Documents IPv6 usage in HERMES_WEBUI_HOST env var description.") | 2 days agoMay 7, 2026 |
| [ROADMAP.md](https://github.com/nesquena/hermes-webui/blob/master/ROADMAP.md "ROADMAP.md") | [ROADMAP.md](https://github.com/nesquena/hermes-webui/blob/master/ROADMAP.md "ROADMAP.md") | [release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA har…](https://github.com/nesquena/hermes-webui/commit/bc4421a1b6a2c00b8deebb0e0f32c1bc6f13fee4 "release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA hardening + opt-in session jump buttons + opt-in endless-scroll)  Three-PR contributor batch (all from @ai-ag2026): - PR #1891: Browser offline recovery + PWA cache hardening - PR #1928: Opt-in session Start/End jump buttons - PR #1929: Opt-in session endless-scroll (builds on shipped #1927)  Tests: 4960 → 4977 (+17 net new). Browser API harness all-green. Manual browser verification on port 8789 passed. Opus advisor: SHIP-WITH-FIXES (both fast-follows are non-blocking).") | 18 hours agoMay 8, 2026 |
| [SPRINTS.md](https://github.com/nesquena/hermes-webui/blob/master/SPRINTS.md "SPRINTS.md") | [SPRINTS.md](https://github.com/nesquena/hermes-webui/blob/master/SPRINTS.md "SPRINTS.md") | [docs: rewrite ROADMAP.md and SPRINTS.md for v0.50.281 currency](https://github.com/nesquena/hermes-webui/commit/3a23efd923a48997b7fc979af5be3ae4d6ce443b "docs: rewrite ROADMAP.md and SPRINTS.md for v0.50.281 currency  Both files had drifted significantly from the actual current state of the project:  ROADMAP.md previously contained: - A ~75-row 'sprint history' table that overlapped with CHANGELOG.md - A 'Wave 2 Core' section frozen at Sprint 7 progress - A 'Wave 2: Full CRUD' nested section repeating the same Wave 7 items - A 'User Requested Features' table that double-counted the same shipped issues - A 'Feature Parity Checklist' with many unchecked boxes that were actually shipped   (branch/fork via #465, LLM-generated session titles via auto_title_refresh_every,   workspace git detection at api/workspace.py:719, code execution and TTS   reclassified, etc.)  SPRINTS.md previously contained: - 1159 lines of historical sprint plans (Sprints 11-26) - Inline planning detail more appropriate for the private workspace - Stale 'as of v0.50.245' header with 'next sprint Sprint 24' reference - Track-A/B/C breakdowns from sprints already long-merged  Rewrite:  ROADMAP.md (now 397 lines, was 363): - Status snapshot table at the top - Architecture table reflecting current layout (api/ ~20k LOC, static/*.js ~26k LOC) - Feature parity checklist reorganized by surface (chat / sessions / workspace /   cron / skills / memory / profiles / config / security / visual / voice /   mobile / i18n / gateway / MCP / distribution) with every line currently in   master correctly checked - 'Forward work' section split into confirmed candidates (with tracking issue   numbers) vs deferred backlog vs intentionally not planned - 'Sprint history' compressed to a single chronological theme table — per-version   detail explicitly redirects to CHANGELOG.md - Versioning conventions documented  SPRINTS.md (now 165 lines, was 1159): - Forward-looking only — no historical sprint plans (those live in CHANGELOG.md) - Active sprint candidates table sourced from the sprint-candidate label - Planning principles section (phase-0 fit assessment, salvage over absorb,   independent-review gate, per-PR release velocity, no feature creep mid-PR,   pre-release gate) - Sprint shape table (typical 3-7 day sprint with phases) - Out-of-scope section centralized - Template for new sprint plans  Also updates TESTING.md test count 3990 → 3995 to match actual pytest collect.  No private workspace info, agent infra references, or contributor stipend content. References to the maintainer's private planning notes are acknowledged as 'in a private workspace' without further specifics — same disclosure pattern most open-source projects use.") | last weekMay 3, 2026 |
| [TESTING.md](https://github.com/nesquena/hermes-webui/blob/master/TESTING.md "TESTING.md") | [TESTING.md](https://github.com/nesquena/hermes-webui/blob/master/TESTING.md "TESTING.md") | [release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA har…](https://github.com/nesquena/hermes-webui/commit/bc4421a1b6a2c00b8deebb0e0f32c1bc6f13fee4 "release: v0.51.30 — Release G (3-PR batch: offline recovery + PWA hardening + opt-in session jump buttons + opt-in endless-scroll)  Three-PR contributor batch (all from @ai-ag2026): - PR #1891: Browser offline recovery + PWA cache hardening - PR #1928: Opt-in session Start/End jump buttons - PR #1929: Opt-in session endless-scroll (builds on shipped #1927)  Tests: 4960 → 4977 (+17 net new). Browser API harness all-green. Manual browser verification on port 8789 passed. Opus advisor: SHIP-WITH-FIXES (both fast-follows are non-blocking).") | 18 hours agoMay 8, 2026 |
| [THEMES.md](https://github.com/nesquena/hermes-webui/blob/master/THEMES.md "THEMES.md") | [THEMES.md](https://github.com/nesquena/hermes-webui/blob/master/THEMES.md "THEMES.md") | [fix: add missing --input-bg/--hover-bg vars, update THEMES.md](https://github.com/nesquena/hermes-webui/commit/e3303c6e891015cde1f87efdcb6402a305adfc33 "fix: add missing --input-bg/--hover-bg vars, update THEMES.md  - Added --input-bg and --hover-bg CSS variables to OLED theme - Added OLED row to built-in themes table in THEMES.md - Updated theme count from six to seven") | last monthApr 7, 2026 |
| [bootstrap.py](https://github.com/nesquena/hermes-webui/blob/master/bootstrap.py "bootstrap.py") | [bootstrap.py](https://github.com/nesquena/hermes-webui/blob/master/bootstrap.py "bootstrap.py") | [fix(bootstrap): clarify shebang fallback precedence + tighten test setup](https://github.com/nesquena/hermes-webui/commit/b7ed4dca3eeb1cf46dce4db8743a055d9084b76b "fix(bootstrap): clarify shebang fallback precedence + tighten test setup  Addresses review feedback on PR #1817:  1. Extend the `_agent_dir_from_hermes_cli` docstring to spell out that    the shebang fallback is a last-resort discovery step, not an override.    Stale clones in known candidate paths still win — same precedence as    today, but now documented so a future maintainer doesn't get the    wrong idea.  2. Drop the misleading \"install exists but no run_agent.py\" comment in    `test_returns_none_when_shebang_interpreter_does_not_walk_to_run_agent`.    The test exercises a shebang pointing at /usr/bin/python3 whose    parents never reach a run_agent.py — it doesn't actually need a fake    install dir at all. Renamed for accuracy and removed the unused    _make_agent_install call.") | 2 days agoMay 7, 2026 |
| [ctl.sh](https://github.com/nesquena/hermes-webui/blob/master/ctl.sh "ctl.sh") | [ctl.sh](https://github.com/nesquena/hermes-webui/blob/master/ctl.sh "ctl.sh") | [feat: add ctl daemon lifecycle script](https://github.com/nesquena/hermes-webui/commit/46bdb3c1aff761aca3f133701d1329a185c92520 "feat: add ctl daemon lifecycle script") | 5 days agoMay 4, 2026 |
| [docker-compose.three-container.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.three-container.yml "docker-compose.three-container.yml") | [docker-compose.three-container.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.three-container.yml "docker-compose.three-container.yml") | [v0.50.260: Docker reliability batch - PR](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") [#1428](https://github.com/nesquena/hermes-webui/pull/1428) [\+ broader UX/docs impr…](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") | last weekMay 1, 2026 |
| [docker-compose.two-container.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.two-container.yml "docker-compose.two-container.yml") | [docker-compose.two-container.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.two-container.yml "docker-compose.two-container.yml") | [v0.50.260: Docker reliability batch - PR](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") [#1428](https://github.com/nesquena/hermes-webui/pull/1428) [\+ broader UX/docs impr…](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") | last weekMay 1, 2026 |
| [docker-compose.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.yml "docker-compose.yml") | [docker-compose.yml](https://github.com/nesquena/hermes-webui/blob/master/docker-compose.yml "docker-compose.yml") | [v0.50.260: Docker reliability batch - PR](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") [#1428](https://github.com/nesquena/hermes-webui/pull/1428) [\+ broader UX/docs impr…](https://github.com/nesquena/hermes-webui/commit/b57525241b5555a48c515ff043c2a639d45797f2 "v0.50.260: Docker reliability batch - PR #1428 + broader UX/docs improvements + Opus advisor fixes  Combines PR #1428 (UID/GID alignment) with a broader Docker reliability pass that addresses recurring user reports about compose files not working.  Constituent PR: - #1428 sunnysktsang - Align agent UID/GID with webui (fixes #1399).   Two- and three-container compose files had agent at UID 10000 (image   default) and webui at UID 1000 (WANTED_UID default), causing permission   denied on shared hermes-home volume. All services now use ${UID:-1000}.  Plus broader Docker UX overhaul: - All 3 compose files document HERMES_SKIP_CHMOD/HERMES_HOME_MODE escape   hatches inline (the v0.50.254 fix wasn't surfaced for Docker users). - New .env.docker.example template covering UID/GID, paths, password,   permission handling. UID/GID are uncommented with placeholder values   per Opus advisor (so macOS users don't skim past). - New docs/docker.md - comprehensive guide: 5-min quickstart, failure   mode table with one-line fixes, bind-mount migration, multi-container   architecture diagram, macOS Docker Desktop VirtioFS note, link to   community sunnysktsang/hermes-suite all-in-one image. - README Docker section rewritten - clearer quickstart, failure-mode   table, link to docs/docker.md. Stale /root/.hermes references removed.  Plus Opus pre-release advisor MUST-FIX: - HERMES_HOME_MODE has DIFFERENT semantics in the WebUI vs the agent   image. WebUI: credential-file mode threshold (0640 allows group bits).   Agent: HERMES_HOME directory mode (default 0700). 0640 on a directory   has no owner-execute bit, so the agent can't traverse its own home and   bricks. My initial draft recommended HERMES_HOME_MODE=0640 in agent   service blocks - corrected to 0750 across all 4 surfaces (compose   files, .env.docker.example, docs/docker.md). 3 regression tests pin   the asymmetry.  12 regression tests total in test_v050260_docker_invariants.py. Full suite: 3627 passed, 0 failed.  Nathan explicitly authorized merge with my own review + Opus only, no independent review needed.") | last weekMay 1, 2026 |
| [docker\_init.bash](https://github.com/nesquena/hermes-webui/blob/master/docker_init.bash "docker_init.bash") | [docker\_init.bash](https://github.com/nesquena/hermes-webui/blob/master/docker_init.bash "docker_init.bash") | [security: harden production Docker image](https://github.com/nesquena/hermes-webui/commit/b1b0cedbe928fd1e237970f8f52476cbd2d48905 "security: harden production Docker image") | 18 hours agoMay 8, 2026 |
| [mcp\_server.py](https://github.com/nesquena/hermes-webui/blob/master/mcp_server.py "mcp_server.py") | [mcp\_server.py](https://github.com/nesquena/hermes-webui/blob/master/mcp_server.py "mcp_server.py") | [refactor(profiles): relocate \_profiles\_match to api/profiles.py (](https://github.com/nesquena/hermes-webui/commit/c613cfa9a7c67b8caf06d6e2466d949c6ac17e75 "refactor(profiles): relocate _profiles_match to api/profiles.py (#1895 review)  Maintainer review on PR #1895 flagged that mcp_server.py duplicated the visibility model from api/routes.py:75. Move the canonical helper into api/profiles.py (next to _is_root_profile, on which it depends) so both api/routes.py and mcp_server.py import the same function instead of carrying parallel definitions that could drift as the model evolves.  - api/profiles.py: + _profiles_match (verbatim from former routes.py:75-97) - api/routes.py:   replace local definition with re-export to keep all                    existing _profiles_match(...) call sites resolving                    without per-call-site refactors - mcp_server.py:   drop local copy, import _profiles_match alongside the                    existing api.profiles imports (line 59) - tests:           + test_profiles_match_single_source_of_truth asserts                    identity (mcp.module._profiles_match is api.profiles._profiles_match                    is api.routes._profiles_match) so any re-introduction of                    a local copy trips the test                    + test_profiles_match_input_matrix parametrize across                    the (None|''|'default'|'foo') x (None|''|'default'|'foo'|'bar')                    visibility matrix per maintainer suggestion  Behaviour unchanged. Zero call-site changes anywhere in api/routes.py.  Co-Authored-By: Claude (Opus 4.7) <noreply@anthropic.com>") [#1895](https://github.com/nesquena/hermes-webui/pull/1895) […](https://github.com/nesquena/hermes-webui/commit/c613cfa9a7c67b8caf06d6e2466d949c6ac17e75 "refactor(profiles): relocate _profiles_match to api/profiles.py (#1895 review)  Maintainer review on PR #1895 flagged that mcp_server.py duplicated the visibility model from api/routes.py:75. Move the canonical helper into api/profiles.py (next to _is_root_profile, on which it depends) so both api/routes.py and mcp_server.py import the same function instead of carrying parallel definitions that could drift as the model evolves.  - api/profiles.py: + _profiles_match (verbatim from former routes.py:75-97) - api/routes.py:   replace local definition with re-export to keep all                    existing _profiles_match(...) call sites resolving                    without per-call-site refactors - mcp_server.py:   drop local copy, import _profiles_match alongside the                    existing api.profiles imports (line 59) - tests:           + test_profiles_match_single_source_of_truth asserts                    identity (mcp.module._profiles_match is api.profiles._profiles_match                    is api.routes._profiles_match) so any re-introduction of                    a local copy trips the test                    + test_profiles_match_input_matrix parametrize across                    the (None|''|'default'|'foo') x (None|''|'default'|'foo'|'bar')                    visibility matrix per maintainer suggestion  Behaviour unchanged. Zero call-site changes anywhere in api/routes.py.  Co-Authored-By: Claude (Opus 4.7) <noreply@anthropic.com>") | yesterdayMay 8, 2026 |
| [requirements.txt](https://github.com/nesquena/hermes-webui/blob/master/requirements.txt "requirements.txt") | [requirements.txt](https://github.com/nesquena/hermes-webui/blob/master/requirements.txt "requirements.txt") | [Hermes WebUI v0.1.0 — initial public release](https://github.com/nesquena/hermes-webui/commit/a4e2174c29b34a95f7123b732634afa696e60564 "Hermes WebUI v0.1.0 — initial public release") | 2 months agoMar 30, 2026 |
| [server.py](https://github.com/nesquena/hermes-webui/blob/master/server.py "server.py") | [server.py](https://github.com/nesquena/hermes-webui/blob/master/server.py "server.py") | [fix: support IPv6 bind address in QuietHTTPServer](https://github.com/nesquena/hermes-webui/commit/dcc40767887821cd864a4e9506a941dfa232e053 "fix: support IPv6 bind address in QuietHTTPServer  Detect IPv6 addresses (containing ':') in QuietHTTPServer.__init__ and set address_family to AF_INET6 before socket creation, fixing EAFNOSUPPORT when binding to :: or ::1.  Also updates the loopback check to recognize ::1 and the container warning to mention :: as the IPv6 equivalent of 0.0.0.0. Documents IPv6 usage in HERMES_WEBUI_HOST env var description.") | 2 days agoMay 7, 2026 |
| [start.sh](https://github.com/nesquena/hermes-webui/blob/master/start.sh "start.sh") | [start.sh](https://github.com/nesquena/hermes-webui/blob/master/start.sh "start.sh") | [feat(onboarding): add one-shot bootstrap and first-run setup wizard (](https://github.com/nesquena/hermes-webui/commit/31a721417e8cc0dd30e396655c91c1ba42b6dc90 "feat(onboarding): add one-shot bootstrap and first-run setup wizard (#285)  Adds a bootstrap launcher and a blocking first-run onboarding wizard that guides new users through minimum Hermes setup from the browser UI.  Supported provider flows: OpenRouter, Anthropic, OpenAI, custom OpenAI-compatible. OAuth/terminal-first flows remain via 'hermes model'.  Security hardening applied during review: - /api/onboarding/setup restricted to loopback when auth disabled - Newline injection guard in _write_env_file - esc() on setup.unsupported_note in onboarding.js - Test isolation fix (send_key instead of bot_name in contamination test) - Skip markers for PyYAML-dependent tests in agent-less environments  Tests: 693 passed (up from 679)  Co-authored-by: Nathan Esquenazi <nesquena@gmail.com> Co-authored-by: gabogabucho <gabogabucho@gmail.com>") [#…](https://github.com/nesquena/hermes-webui/pull/285) | last monthApr 12, 2026 |
| View all files |

## Repository files navigation

# Hermes Web UI

[Permalink: Hermes Web UI](https://github.com/nesquena/hermes-webui#hermes-web-ui)

[Hermes Agent](https://hermes-agent.nousresearch.com/) is a sophisticated autonomous agent that lives on your server, accessed via a terminal or messaging apps, that remembers what it learns and gets more capable the longer it runs.

Hermes WebUI is a lightweight, dark-themed web app interface in your browser for [Hermes Agent](https://hermes-agent.nousresearch.com/).
Full parity with the CLI experience - everything you can do from a terminal,
you can do from this UI. No build step, no framework, no bundler. Just Python
and vanilla JS.

Layout: three-panel. Left sidebar for sessions and navigation, center for chat,
right for workspace file browsing. Model, profile, and workspace controls live in
the **composer footer** — always visible while composing. A circular context ring
shows token usage at a glance. All settings and session tools are in the
**Hermes Control Center** (launcher at the sidebar bottom).

![Hermes Web UI — three-panel layout](https://private-user-images.githubusercontent.com/272340397/579555904-6bf8af4c-209d-441e-8b92-6515d7a0c369.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NzgzNDA5ODEsIm5iZiI6MTc3ODM0MDY4MSwicGF0aCI6Ii8yNzIzNDAzOTcvNTc5NTU1OTA0LTZiZjhhZjRjLTIwOWQtNDQxZS04YjkyLTY1MTVkN2EwYzM2OS5wbmc_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjYwNTA5JTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MDUwOVQxNTMxMjFaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT01MDk5Mzc3NTYwYmFhZjU1NDUxMzNmMDVlYmZjMmQ4NWNhODdhNTdkMGVkYmY5OTBhYzJmODJjOTkwMDkxMTRiJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZyZXNwb25zZS1jb250ZW50LXR5cGU9aW1hZ2UlMkZwbmcifQ.Nlc2qjSYawYIiSBs_04yyH5G2tbt5rJM-fr2xCGXq2w)

|     |     |
| --- | --- |
| ![Light mode with full profile support](https://private-user-images.githubusercontent.com/272340397/579555993-4ef3a59c-7a66-4705-b4e7-cb9148fe4c47.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NzgzNDA5ODEsIm5iZiI6MTc3ODM0MDY4MSwicGF0aCI6Ii8yNzIzNDAzOTcvNTc5NTU1OTkzLTRlZjNhNTljLTdhNjYtNDcwNS1iNGU3LWNiOTE0OGZlNGM0Ny5wbmc_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjYwNTA5JTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MDUwOVQxNTMxMjFaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT1iOWY5MjAxM2EzYjc5OTQ5Y2E5YTdhZmM0NjNmNTFlYjM0YzQ4OGYzZTM3YjVhNjVlZDQzMGI3YzNhNDQ2ZWI0JlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZyZXNwb25zZS1jb250ZW50LXR5cGU9aW1hZ2UlMkZwbmcifQ.0ozCW-RZ0-SKWphAS8i1-3nlgFf3DoY3qBbo9-RA4Tw)<br>Light mode with full profile support | ![Customize your settings, configure a password](https://private-user-images.githubusercontent.com/272340397/573882002-941f3156-21e3-41fd-bcc8-f975d5000cb8.png?jwt=eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJnaXRodWIuY29tIiwiYXVkIjoicmF3LmdpdGh1YnVzZXJjb250ZW50LmNvbSIsImtleSI6ImtleTUiLCJleHAiOjE3NzgzNDA5ODEsIm5iZiI6MTc3ODM0MDY4MSwicGF0aCI6Ii8yNzIzNDAzOTcvNTczODgyMDAyLTk0MWYzMTU2LTIxZTMtNDFmZC1iY2M4LWY5NzVkNTAwMGNiOC5wbmc_WC1BbXotQWxnb3JpdGhtPUFXUzQtSE1BQy1TSEEyNTYmWC1BbXotQ3JlZGVudGlhbD1BS0lBVkNPRFlMU0E1M1BRSzRaQSUyRjIwMjYwNTA5JTJGdXMtZWFzdC0xJTJGczMlMkZhd3M0X3JlcXVlc3QmWC1BbXotRGF0ZT0yMDI2MDUwOVQxNTMxMjFaJlgtQW16LUV4cGlyZXM9MzAwJlgtQW16LVNpZ25hdHVyZT1kZjBjNzY5N2U0Nzg4YzBhMmM3YjM5MTRmZTJmNDM2MjRlZmIxOWQ0NTdlZTk0MmQ0MWE3YmRhYmQ2ODUzYjBlJlgtQW16LVNpZ25lZEhlYWRlcnM9aG9zdCZyZXNwb25zZS1jb250ZW50LXR5cGU9aW1hZ2UlMkZwbmcifQ.BBNuK4uVpe6_Hn7EM0saWSpxqf-1GPtSAQRsRhKvsTU)<br>Customize your settings, configure a password |

|     |     |
| --- | --- |
| [![Workspace file browser with inline preview](https://github.com/nesquena/hermes-webui/raw/master/docs/images/ui-workspace.png)](https://github.com/nesquena/hermes-webui/blob/master/docs/images/ui-workspace.png)<br>Workspace file browser with inline preview | [![Session projects, tags, and tool call cards](https://github.com/nesquena/hermes-webui/raw/master/docs/images/ui-sessions.png)](https://github.com/nesquena/hermes-webui/blob/master/docs/images/ui-sessions.png)<br>Session projects, tags, and tool call cards |

This gives you nearly **1:1 parity with Hermes CLI from a convenient web UI** which you can access securely through an SSH tunnel from your Hermes setup. Single command to start this up, and a single command to SSH tunnel for access on your computer. Every single part of the web UI uses your existing Hermes agent and existing models, without requiring any additional setup.

* * *

## Why Hermes

[Permalink: Why Hermes](https://github.com/nesquena/hermes-webui#why-hermes)

Most AI tools reset every session. They don't know who you are, what you worked on, or what
conventions your project follows. You re-explain yourself every time.

Hermes retains context across sessions, runs scheduled jobs while you're offline, and gets
smarter about your environment the longer it runs. It uses your existing Hermes agent setup,
your existing models, and requires no additional configuration to start.

What makes it different from other agentic tools:

- **Persistent memory** — user profile, agent notes, and a skills system that saves reusable
procedures; Hermes learns your environment and does not have to relearn it
- **Self-hosted scheduling** — cron jobs that fire while you're offline and deliver results to
Telegram, Discord, Slack, Signal, email, and more
- **10+ messaging platforms** — the same agent available in the terminal is reachable from your phone
- **Self-improving skills** — Hermes writes and saves its own skills automatically from experience;
no marketplace to browse, no plugins to install
- **Provider-agnostic** — OpenAI, Anthropic, Google, DeepSeek, OpenRouter, and more
- **Orchestrates other agents** — can spawn Claude Code or Codex for heavy coding tasks and bring
the results back into its own memory
- **Self-hosted** — your conversations, your memory, your hardware

**vs. the field** _(landscape is actively shifting — see [HERMES.md](https://github.com/nesquena/hermes-webui/blob/master/HERMES.md) for the full breakdown)_:

|  | OpenClaw | Claude Code | Codex CLI | OpenCode | Hermes |
| --- | --- | --- | --- | --- | --- |
| Persistent memory (auto) | Yes | Partial† | Partial | Partial | Yes |
| Scheduled jobs (self-hosted) | Yes | No‡ | No | No | Yes |
| Messaging app access | Yes (15+ platforms) | Partial (Telegram/Discord preview) | No | No | Yes (10+) |
| Web UI (self-hosted) | Dashboard only | No | No | Yes | Yes |
| Self-improving skills | Partial | No | No | No | Yes |
| Python / ML ecosystem | No (Node.js) | No | No | No | Yes |
| Provider-agnostic | Yes | No (Claude only) | Yes | Yes | Yes |
| Open source | Yes (MIT) | No | Yes | Yes | Yes |

† Claude Code has CLAUDE.md / MEMORY.md project context and rolling auto-memory, but not full automatic cross-session recall

‡ Claude Code has cloud-managed scheduling (Anthropic infrastructure) and session-scoped `/loop`; no self-hosted cron

**The closest competitor is OpenClaw** — both are always-on, self-hosted, open-source agents
with memory, cron, and messaging. The key differences: Hermes writes and saves its own skills
automatically as a core behavior (OpenClaw's skill system centers on a community marketplace);
Hermes is more stable across updates (OpenClaw has documented release regressions and ClawHub
has had security incidents involving malicious skills); and Hermes runs natively in the Python
ecosystem. See [HERMES.md](https://github.com/nesquena/hermes-webui/blob/master/HERMES.md) for the full side-by-side.

* * *

## Quick start

[Permalink: Quick start](https://github.com/nesquena/hermes-webui#quick-start)

Run the repo bootstrap:

```
git clone https://github.com/nesquena/hermes-webui.git hermes-webui
cd hermes-webui
python3 bootstrap.py
```

Or keep using the shell launcher:

```
./start.sh
```

For self-hosted VM or homelab installs, `ctl.sh` wraps the common daemon lifecycle commands without requiring `fuser` or `pkill`:

```
./ctl.sh start              # background daemon, PID at ~/.hermes/webui.pid
./ctl.sh status             # PID, uptime, bound host/port, log path, /health
./ctl.sh logs --lines 100   # tail ~/.hermes/webui.log
./ctl.sh restart
./ctl.sh stop
```

`ctl.sh start` runs the bootstrap in foreground/no-browser mode behind the daemon wrapper, writes logs to `~/.hermes/webui.log`, and respects `.env` plus inline overrides such as `HERMES_WEBUI_HOST=0.0.0.0 ./ctl.sh start`.

The bootstrap will:

1. Detect Hermes Agent and, if missing, attempt the official installer (`curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash`).
2. Find or create a Python environment with the WebUI dependencies.
3. Start the web server and wait for `/health`.
4. Open the browser unless you pass `--no-browser`.
5. Drop you into a first-run onboarding wizard inside the WebUI.

> Native Windows is not supported for this bootstrap yet. Use Linux, macOS, or WSL2.
> For Windows / WSL auto-start at login, see [`docs/wsl-autostart.md`](https://github.com/nesquena/hermes-webui/blob/master/docs/wsl-autostart.md).

If provider setup is still incomplete after install, the onboarding wizard will point you to finish it with `hermes model` instead of trying to replicate the full CLI setup in-browser.

* * *

## Docker

[Permalink: Docker](https://github.com/nesquena/hermes-webui#docker)

**Pre-built images** (amd64 + arm64) are published to GHCR on every release.

For a comprehensive setup guide covering all 3 compose files, common failure modes, and bind-mount migration, see [`docs/docker.md`](https://github.com/nesquena/hermes-webui/blob/master/docs/docker.md). The README covers the 5-minute happy path.

### 5-minute quickstart (single container)

[Permalink: 5-minute quickstart (single container)](https://github.com/nesquena/hermes-webui#5-minute-quickstart-single-container)

The simplest setup: one WebUI container that runs the agent in-process.

```
git clone https://github.com/nesquena/hermes-webui
cd hermes-webui
cp .env.docker.example .env
# Edit .env if your host UID isn't 1000 (e.g. macOS where UIDs start at 501)
docker compose up -d
# Open http://localhost:8787
```

The container auto-detects your UID/GID from the mounted `~/.hermes` volume so files written by the agent stay readable by you on the host.

To enable password protection (required if you expose the port outside `127.0.0.1`):

```
echo "HERMES_WEBUI_PASSWORD=change-me-to-something-strong" >> .env
docker compose up -d --force-recreate
```

### Manual `docker run` (no compose)

[Permalink: Manual docker run (no compose)](https://github.com/nesquena/hermes-webui#manual-docker-run-no-compose)

```
docker pull ghcr.io/nesquena/hermes-webui:latest
docker run -d \
  -e WANTED_UID=$(id -u) -e WANTED_GID=$(id -g) \
  -v ~/.hermes:/home/hermeswebui/.hermes \
  -e HERMES_WEBUI_STATE_DIR=/home/hermeswebui/.hermes/webui \
  -v ~/workspace:/workspace \
  -p 127.0.0.1:8787:8787 \
  ghcr.io/nesquena/hermes-webui:latest
```

### Build locally

[Permalink: Build locally](https://github.com/nesquena/hermes-webui#build-locally)

```
docker build -t hermes-webui .
docker run -d \
  -e WANTED_UID=$(id -u) -e WANTED_GID=$(id -g) \
  -v ~/.hermes:/home/hermeswebui/.hermes \
  -e HERMES_WEBUI_STATE_DIR=/home/hermeswebui/.hermes/webui \
  -v ~/workspace:/workspace \
  -p 127.0.0.1:8787:8787 \
  hermes-webui
```

### Multi-container setups

[Permalink: Multi-container setups](https://github.com/nesquena/hermes-webui#multi-container-setups)

If you want the agent and WebUI in separate containers (for isolation, or because you're already running an agent gateway elsewhere):

```
# Agent + WebUI
docker compose -f docker-compose.two-container.yml up -d

# Agent + Dashboard + WebUI
docker compose -f docker-compose.three-container.yml up -d
```

Both compose files use **named Docker volumes** by default, which solves the UID/GID problem by construction. If you need bind mounts to share an existing host directory, see [`docs/docker.md`](https://github.com/nesquena/hermes-webui/blob/master/docs/docker.md) for the full migration recipe.

> **Known limitation (#681)**: in the two-container setup, tools triggered from the WebUI run in the **WebUI container**, not the agent container. If you need git/node/etc. on the WebUI's filesystem, either use the single-container setup, extend the WebUI Dockerfile, or use the community [all-in-one image](https://github.com/sunnysktsang/hermes-suite).

### Common failure modes

[Permalink: Common failure modes](https://github.com/nesquena/hermes-webui#common-failure-modes)

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| `PermissionError` at startup | UID mismatch on bind mount | Set `UID=$(id -u)` in `.env` |
| `.env: permission denied` (#1389) | `fix_credential_permissions()` enforced 0600 | Set `HERMES_SKIP_CHMOD=1` in `.env` |
| Workspace appears empty | UID mismatch on `/workspace` mount | Set `UID=$(id -u)` in `.env` |
| `git: command not found` in chat | Two-container architectural limit (#681) | Use single-container or extend Dockerfile |
| WebUI can't find agent source | `hermes-agent-src` volume misconfigured | Use the named volumes from compose files as-is |
| Podman shared `.hermes` fails | Podman 3.4 `keep-id` limitation | Use Podman 4+ or single-container |

For the deep dive on each of these, see [`docs/docker.md`](https://github.com/nesquena/hermes-webui/blob/master/docs/docker.md).

> **Note:** By default, Docker Compose binds to `127.0.0.1` (localhost only).
> To expose on a network, change the port to `"8787:8787"` in `docker-compose.yml`
> and set `HERMES_WEBUI_PASSWORD` to enable authentication.

* * *

## What start.sh discovers automatically

[Permalink: What start.sh discovers automatically](https://github.com/nesquena/hermes-webui#what-startsh-discovers-automatically)

| Thing | How it finds it |
| --- | --- |
| Hermes agent dir | `HERMES_WEBUI_AGENT_DIR` env, then `~/.hermes/hermes-agent`, then sibling `../hermes-agent` |
| Python executable | Agent venv first, then `.venv` in this repo, then system `python3` |
| State directory | `HERMES_WEBUI_STATE_DIR` env, then `~/.hermes/webui-mvp` |
| Default workspace | `HERMES_WEBUI_DEFAULT_WORKSPACE` env, then `~/workspace`, then state dir |
| Port | `HERMES_WEBUI_PORT` env or first argument, default `8787` |

If discovery finds everything, nothing else is required.

* * *

## Overrides (only needed if auto-detection misses)

[Permalink: Overrides (only needed if auto-detection misses)](https://github.com/nesquena/hermes-webui#overrides-only-needed-if-auto-detection-misses)

```
export HERMES_WEBUI_AGENT_DIR=/path/to/hermes-agent
export HERMES_WEBUI_PYTHON=/path/to/python
export HERMES_WEBUI_PORT=9000
export HERMES_WEBUI_AUTO_INSTALL=1  # enable auto-install of agent deps (disabled by default)
./start.sh
```

Or inline:

```
HERMES_WEBUI_AGENT_DIR=/custom/path ./start.sh 9000
```

Full list of environment variables:

| Variable | Default | Description |
| --- | --- | --- |
| `HERMES_WEBUI_AGENT_DIR` | auto-discovered | Path to the hermes-agent checkout |
| `HERMES_WEBUI_PYTHON` | auto-discovered | Python executable |
| `HERMES_WEBUI_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` for all IPv4, `::` for all IPv6, `::1` for IPv6 loopback) |
| `HERMES_WEBUI_PORT` | `8787` | Port |
| `HERMES_WEBUI_STATE_DIR` | `~/.hermes/webui-mvp` | Where sessions and state are stored |
| `HERMES_WEBUI_DEFAULT_WORKSPACE` | `~/workspace` | Default workspace |
| `HERMES_WEBUI_DEFAULT_MODEL` | `openai/gpt-5.4-mini` | Default model |
| `HERMES_WEBUI_PASSWORD` | _(unset)_ | Set to enable password authentication |
| `HERMES_WEBUI_EXTENSION_DIR` | _(unset)_ | Optional local directory served at `/extensions/`; must point to an existing directory before extension injection is enabled |
| `HERMES_WEBUI_EXTENSION_SCRIPT_URLS` | _(unset)_ | Optional comma-separated same-origin script URLs to inject; see [WebUI Extensions](https://github.com/nesquena/hermes-webui/blob/master/docs/EXTENSIONS.md) |
| `HERMES_WEBUI_EXTENSION_STYLESHEET_URLS` | _(unset)_ | Optional comma-separated same-origin stylesheet URLs to inject; see [WebUI Extensions](https://github.com/nesquena/hermes-webui/blob/master/docs/EXTENSIONS.md) |
| `HERMES_HOME` | `~/.hermes` | Base directory for Hermes state (affects all paths) |
| `HERMES_CONFIG_PATH` | `~/.hermes/config.yaml` | Path to Hermes config file |

* * *

## Accessing from a remote machine

[Permalink: Accessing from a remote machine](https://github.com/nesquena/hermes-webui#accessing-from-a-remote-machine)

The server binds to `127.0.0.1` by default (loopback only). If you are running
Hermes on a VPS or remote server, use an SSH tunnel from your local machine:

```
ssh -N -L <local-port>:127.0.0.1:<remote-port> <user>@<server-host>
```

Example:

```
ssh -N -L 8787:127.0.0.1:8787 user@your.server.com
```

Then open `http://localhost:8787` in your local browser.

`start.sh` will print this command for you automatically when it detects you
are running over SSH.

* * *

## Accessing on your phone with Tailscale

[Permalink: Accessing on your phone with Tailscale](https://github.com/nesquena/hermes-webui#accessing-on-your-phone-with-tailscale)

[Tailscale](https://tailscale.com/) is a zero-config mesh VPN built on
WireGuard. Install it on your server and your phone, and they join the same
private network -- no port forwarding, no SSH tunnels, no public exposure.

The Hermes Web UI is fully responsive with a mobile-optimized layout
(hamburger sidebar, sidebar top tabs in the drawer, touch-friendly controls),
so it works well as a daily-driver agent interface from your phone.

**Setup:**

1. Install [Tailscale](https://tailscale.com/download) on your server and
your iPhone/Android.
2. Start the WebUI listening on all interfaces with password auth enabled:

```
HERMES_WEBUI_HOST=0.0.0.0 HERMES_WEBUI_PASSWORD=your-secret ./start.sh
```

3. Open `http://<server-tailscale-ip>:8787` in your phone's browser
(find your server's Tailscale IP in the Tailscale app or with
`tailscale ip -4` on the server).

That's it. Traffic is encrypted end-to-end by WireGuard, and password auth
protects the UI at the application level. You can add it to your home screen
for an app-like experience.

> **Tip:** If using Docker, set `HERMES_WEBUI_HOST=0.0.0.0` in your
> `docker-compose.yml` environment (already the default) and set
> `HERMES_WEBUI_PASSWORD`.

* * *

## Manual launch (without start.sh)

[Permalink: Manual launch (without start.sh)](https://github.com/nesquena/hermes-webui#manual-launch-without-startsh)

If you prefer to launch the server directly:

```
cd /path/to/hermes-agent          # or wherever sys.path can find Hermes modules
HERMES_WEBUI_PORT=8787 venv/bin/python /path/to/hermes-webui/server.py
```

Note: use the agent venv Python (or any Python environment that has the Hermes agent dependencies installed). System Python will be missing `openai`, `httpx`, and other required packages.

Health check:

```
curl http://127.0.0.1:8787/health
```

* * *

## Running tests

[Permalink: Running tests](https://github.com/nesquena/hermes-webui#running-tests)

Tests discover the repo and the Hermes agent dynamically -- no hardcoded paths.

```
cd hermes-webui
pytest tests/ -v --timeout=60
```

Or using the agent venv explicitly:

```
/path/to/hermes-agent/venv/bin/python -m pytest tests/ -v
```

Tests run against an isolated server on port 8788 with a separate state directory.
Production data and real cron jobs are never touched. Current count: **3309 tests**
across 100+ test files.

* * *

## Features

[Permalink: Features](https://github.com/nesquena/hermes-webui#features)

### Chat and agent

[Permalink: Chat and agent](https://github.com/nesquena/hermes-webui#chat-and-agent)

- Streaming responses via SSE (tokens appear as they are generated)
- Multi-provider model support -- any Hermes API provider (OpenAI, Anthropic, Google, DeepSeek, Nous Portal, OpenRouter, MiniMax, Z.AI); dynamic model dropdown populated from configured keys
- Send a message while one is processing -- it queues automatically
- Edit any past user message inline and regenerate from that point
- Retry the last assistant response with one click
- Cancel a running task directly from the composer footer (Stop button next to Send)
- Tool call cards inline -- each shows the tool name, args, and result snippet; expand/collapse all toggle for multi-tool turns
- Subagent delegation cards -- child agent activity shown with distinct icon and indented border
- Mermaid diagram rendering inline (flowcharts, sequence diagrams, gantt charts)
- Thinking/reasoning display -- collapsible gold-themed cards for Claude extended thinking and o3 reasoning blocks
- Approval card for dangerous shell commands (allow once / session / always / deny)
- SSE auto-reconnect on network blips (SSH tunnel resilience)
- File attachments persist across page reloads
- Message timestamps (HH:MM next to each message, full date on hover)
- Code block copy button with "Copied!" feedback
- Syntax highlighting via Prism.js (Python, JS, bash, JSON, SQL, and more)
- Safe HTML rendering in AI responses (bold, italic, code converted to markdown)
- rAF-throttled token streaming for smoother rendering during long responses
- Context usage indicator in composer footer -- token count, cost, and fill bar (model-aware)

### Sessions

[Permalink: Sessions](https://github.com/nesquena/hermes-webui#sessions)

- Create, rename, duplicate, delete, search by title and message content
- Session actions via `⋯` dropdown per session — pin, move to project, archive, duplicate, delete
- Pin/star sessions to the top of the sidebar (gold indicator)
- Archive sessions (hide without deleting, toggle to show)
- Session projects -- named groups with colors for organizing sessions
- Session tags -- add #tag to titles for colored chips and click-to-filter
- Grouped by Today / Yesterday / Earlier in the sidebar (collapsible date groups)
- Download as Markdown transcript, full JSON export, or import from JSON
- Sessions persist across page reloads and SSH tunnel reconnects
- Browser tab title reflects the active session name
- CLI session bridge -- CLI sessions from hermes-agent's SQLite store appear in the sidebar with a gold "cli" badge; click to import with full history and reply normally
- Token/cost display -- input tokens, output tokens, estimated cost shown per conversation (toggle in Settings or `/usage` command)

### Workspace file browser

[Permalink: Workspace file browser](https://github.com/nesquena/hermes-webui#workspace-file-browser)

- Directory tree with expand/collapse (single-click toggles, double-click navigates)
- Breadcrumb navigation with clickable path segments
- Preview text, code, Markdown (rendered), and images inline
- Edit, create, delete, and rename files; create folders
- Binary file download (auto-detected from server)
- File preview auto-closes on directory navigation (with unsaved-edit guard)
- Git detection -- branch name and dirty file count badge in workspace header
- Right panel is drag-resizable
- Syntax highlighted code preview (Prism.js)

### Voice input

[Permalink: Voice input](https://github.com/nesquena/hermes-webui#voice-input)

- Microphone button in the composer (Web Speech API)
- Tap to record, tap again or send to stop
- Live interim transcription appears in the textarea
- Auto-stops after ~2s of silence
- Appends to existing textarea content (doesn't replace)
- Hidden when browser doesn't support Web Speech API (Chrome, Edge, Safari)

### Profiles

[Permalink: Profiles](https://github.com/nesquena/hermes-webui#profiles)

- Profile chip in the **composer footer** \-\- dropdown showing all profiles with gateway status and model info
- Gateway status dots (green = running), model info, skill count per profile
- Profiles management panel -- create, switch, and delete profiles from the sidebar
- Clone config from active profile on create
- Optional custom endpoint fields on create -- Base URL and API key written into the profile's `config.yaml` at creation time, so Ollama, LMStudio, and other local endpoints can be configured without editing files manually
- Seamless switching -- no server restart; reloads config, skills, memory, cron, models
- Per-session profile tracking (records which profile was active at creation)

### Authentication and security

[Permalink: Authentication and security](https://github.com/nesquena/hermes-webui#authentication-and-security)

- Optional password auth -- off by default, zero friction for localhost
- Enable via `HERMES_WEBUI_PASSWORD` env var or Settings panel
- Signed HMAC HTTP-only cookie with 24h TTL
- Minimal dark-themed login page at `/login`
- Security headers on all responses (X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- 20MB POST body size limit
- CDN resources pinned with SRI integrity hashes

### Themes

[Permalink: Themes](https://github.com/nesquena/hermes-webui#themes)

- 7 built-in themes: Dark (default), Light, Slate, Solarized Dark, Monokai, Nord, OLED
- Switch via Settings panel dropdown (instant live preview) or `/theme` command
- Persists across reloads (server-side in settings.json + localStorage for flicker-free loading)
- Custom themes: define a `:root[data-theme="name"]` CSS block and it works — see [THEMES.md](https://github.com/nesquena/hermes-webui/blob/master/THEMES.md)

### Settings and configuration

[Permalink: Settings and configuration](https://github.com/nesquena/hermes-webui#settings-and-configuration)

- **Hermes Control Center** (sidebar launcher button) -- Conversation tab (export/import/clear), Preferences tab (model, send key, theme, language, all toggles), System tab (version, password)
- Send key: Enter (default) or Ctrl/Cmd+Enter
- Show/hide CLI sessions toggle (enabled by default)
- Token usage display toggle (off by default, also via `/usage` command)
- Control Center always opens on the Conversation tab; resets on close
- Unsaved changes guard -- discard/save prompt when closing with unpersisted changes
- Cron completion alerts -- toast notifications and unread badge on Tasks tab
- Background agent error alerts -- banner when a non-active session encounters an error

### Slash commands

[Permalink: Slash commands](https://github.com/nesquena/hermes-webui#slash-commands)

- Type `/` in the composer for autocomplete dropdown
- Built-in: `/help`, `/clear`, `/compress [focus topic]`, `/compact` (alias), `/model <name>`, `/workspace <name>`, `/new`, `/usage`, `/theme`
- Arrow keys navigate, Tab/Enter select, Escape closes
- Unrecognized commands pass through to the agent

### Panels

[Permalink: Panels](https://github.com/nesquena/hermes-webui#panels)

- **Chat** \-\- session list, search, pin, archive, projects, new conversation
- **Tasks** \-\- view, create, edit, run, pause/resume, delete cron jobs; run history; completion alerts
- **Skills** \-\- list all skills by category, search, preview, create/edit/delete; linked files viewer
- **Memory** \-\- view and edit MEMORY.md and USER.md inline
- **Profiles** \-\- create, switch, delete agent profiles; clone config
- **Todos** \-\- live task list from the current session
- **Spaces** \-\- add, rename, remove workspaces; quick-switch from topbar

### Mobile responsive

[Permalink: Mobile responsive](https://github.com/nesquena/hermes-webui#mobile-responsive)

- Hamburger sidebar -- slide-in overlay on mobile (<640px)
- Sidebar top tabs stay available on mobile; no fixed bottom nav stealing chat height
- Files slide-over panel from right edge
- Touch targets minimum 44px on all interactive elements
- Full-height chat/composer on phones without bottom-nav spacing
- Desktop layout completely unchanged

* * *

## Architecture

[Permalink: Architecture](https://github.com/nesquena/hermes-webui#architecture)

```
server.py               HTTP routing shell + auth middleware (~154 lines)
api/
  auth.py               Optional password authentication, signed cookies (~201 lines)
  config.py             Discovery, globals, model detection, reloadable config (~1110 lines)
  helpers.py            HTTP helpers, security headers (~175 lines)
  models.py             Session model + CRUD + CLI bridge (~377 lines)
  onboarding.py         First-run onboarding wizard, OAuth provider support (~507 lines)
  profiles.py           Profile state management, hermes_cli wrapper (~411 lines)
  routes.py             All GET + POST route handlers (~2250 lines)
  state_sync.py         /insights sync — message_count to state.db (~113 lines)
  streaming.py          SSE engine, run_agent, cancel support (~660 lines)
  updates.py            Self-update check and release notes (~257 lines)
  upload.py             Multipart parser, file upload handler (~82 lines)
  workspace.py          File ops, workspace helpers, git detection (~288 lines)
static/
  index.html            HTML template (~600 lines)
  style.css             All CSS incl. mobile responsive, themes (~1050 lines)
  ui.js                 DOM helpers, renderMd, tool cards, context indicator (~1740 lines)
  workspace.js          File preview, file ops, git badge (~286 lines)
  sessions.js           Session CRUD, collapsible groups, search, reload recovery (~800 lines)
  messages.js           send(), SSE handlers, live streaming, session recovery (~655 lines)
  panels.js             Cron, skills, memory, profiles, settings (~1438 lines)
  commands.js           Slash command autocomplete (~267 lines)
  boot.js               Mobile nav, voice input, boot IIFE (~524 lines)
tests/
  conftest.py           Isolated test server (port 8788)
  61 test files          961 test functions
Dockerfile              python:3.12-slim container image
docker-compose.yml      Compose with named volume and optional auth
.github/workflows/      CI: multi-arch Docker build + GitHub Release on tag
```

State lives outside the repo at `~/.hermes/webui-mvp/` by default
(sessions, workspaces, settings, projects, last\_workspace). Override with `HERMES_WEBUI_STATE_DIR`.

* * *

## Docs

[Permalink: Docs](https://github.com/nesquena/hermes-webui#docs)

- `HERMES.md` \-\- why Hermes, mental model, and detailed comparison to Claude Code / Codex / OpenCode / Cursor
- `ROADMAP.md` \-\- feature roadmap and sprint history
- `ARCHITECTURE.md` \-\- system design, all API endpoints, implementation notes
- `TESTING.md` \-\- manual browser test plan and automated coverage reference
- `CHANGELOG.md` \-\- release notes per sprint
- `SPRINTS.md` \-\- forward sprint plan with CLI + Claude parity targets
- `THEMES.md` \-\- theme system documentation, custom theme guide
- `docs/troubleshooting.md` \-\- diagnostic flows for common failures (e.g. "AIAgent not available")

## Contributors

[Permalink: Contributors](https://github.com/nesquena/hermes-webui#contributors)

Hermes WebUI is built with help from the open-source community. Every PR — whether merged directly or incorporated via batch release — shapes the project, and we're grateful to everyone who has taken the time to contribute.

**66 contributors have shipped code that landed in a release tag** as of v0.50.245. The full credit roll lives in [`CONTRIBUTORS.md`](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTORS.md). The highlights:

### Top contributors (by merged-PR count)

[Permalink: Top contributors (by merged-PR count)](https://github.com/nesquena/hermes-webui#top-contributors-by-merged-pr-count)

| # | Contributor | PRs | First → latest release |
| --- | --- | --: | --- |
| 1 | [@franksong2702](https://github.com/franksong2702) | 22 | `v0.50.49` → `v0.50.245` |
| 2 | [@bergeouss](https://github.com/bergeouss) | 18 | `v0.50.49` → `v0.50.240` |
| 3 | [@aronprins](https://github.com/aronprins) | 8 | `v0.47.0` → `v0.50.77` |
| 4 | [@iRonin](https://github.com/iRonin) | 6 | `v0.41.0` |
| 5 | [@24601](https://github.com/24601) | 6 | `v0.50.201` |
| 6 | [@KingBoyAndGirl](https://github.com/KingBoyAndGirl) | 4 | `v0.50.232` → `v0.50.237` |
| 7 | [@renheqiang](https://github.com/renheqiang) | 4 | `v0.50.93` |
| 8 | [@ccqqlo](https://github.com/ccqqlo) | 3 | `v0.50.83` → `v0.50.207` |
| 9 | [@deboste](https://github.com/deboste) | 3 | `v0.16.1` |
| 10 | [@frap129](https://github.com/frap129) | 3 | `v0.50.157` → `v0.50.166` |

See [`CONTRIBUTORS.md`](https://github.com/nesquena/hermes-webui/blob/master/CONTRIBUTORS.md) for the full ranked list of all 66 contributors, including everyone with one or two merged PRs and the special-thanks roll for design and architectural contributions.

### Notable contributions

[Permalink: Notable contributions](https://github.com/nesquena/hermes-webui#notable-contributions)

**[@aronprins](https://github.com/aronprins)** — v0.50.0 UI overhaul (PR #242)
The biggest single contribution to the project: a complete UI redesign that moved model/profile/workspace controls into the composer footer, replaced the gear-icon settings panel with the Hermes Control Center (tabbed modal), removed the activity bar in favor of inline composer status, redesigned the session list with a `⋯` action dropdown, and added the workspace panel state machine. 26 commits, thoroughly designed and iterated through multiple review rounds.

**[@iRonin](https://github.com/iRonin)** — Security hardening sprint (PRs #196–#204)
Six consecutive security and reliability PRs: session memory leak fix (expired token pruning), Content-Security-Policy + Permissions-Policy headers, 30-second slow-client connection timeout, optional HTTPS/TLS support via environment variables, upstream branch tracking fix for self-update, and CLI session support in the file browser API. This is the kind of focused, high-quality security work that makes a self-hosted tool trustworthy.

**[@DavidSchuchert](https://github.com/DavidSchuchert)** — German translation (PR #190)
Complete German locale (`de`) covering all UI strings, settings labels, commands, and system messages — and in doing so, stress-tested the i18n system and exposed several elements that weren't yet translatable, which got fixed as part of the same PR.

**[@Jordan-SkyLF](https://github.com/Jordan-SkyLF)** — Live streaming, session recovery, workspace fallback (PRs #366, #367)
Three interlocking improvements: workspace fallback resolution so the server recovers gracefully when the configured workspace is deleted or unavailable; live reasoning cards that upgrade the generic thinking spinner to a real-time reasoning display as the model thinks; and durable session state recovery via `localStorage` so in-flight tool cards, partial assistant output, and the live SSE stream all survive a full page reload or session switch.

### Feature contributions

[Permalink: Feature contributions](https://github.com/nesquena/hermes-webui#feature-contributions)

**[@gabogabucho](https://github.com/gabogabucho)** — Spanish locale + onboarding wizard (PRs #275, #285)
Full Spanish (`es`) locale covering all 175 UI strings, plus the one-shot bootstrap onboarding wizard that guides new users through provider setup on first launch — the feature most responsible for new users actually getting started.

**[@bergeouss](https://github.com/bergeouss)** — Provider management UI + gateway sync + Docker hardening (18 PRs, `v0.50.49` → `v0.50.240`)
Real-time gateway session sync (Telegram/Discord/Slack into the WebUI sidebar via SSE), the provider management UI for adding/editing custom providers from Settings, the two-container Docker setup docs, OAuth provider status detection, profile isolation hardening (per-profile `.env` secrets), and the bulk of what users see when they touch Settings → Providers.

**[@ccqqlo](https://github.com/ccqqlo)** — Terminal approval UX + custom model discovery + mobile close button (PRs #224, #225, #238, #333)
A run of focused quality-of-life improvements: terminal tool approval prompts that stay visible long enough to actually be read, restored custom model API key discovery, and the redundant mobile close button fix that had been confusing users on narrow screens.

**[@kevin-ho](https://github.com/kevin-ho)** — OLED theme (PR #168)
Added the 7th built-in theme: pure black backgrounds with warm accents tuned to reduce burn-in risk. Small diff, big impact for anyone on an OLED display.

**[@Bobby9228](https://github.com/Bobby9228)** — Mobile Profiles button + Android Chrome fixes (PRs #253, #263, #265)
Added the Profiles entry to the mobile navigation flow, making profile switching reachable on phones, plus a set of Android Chrome-specific fixes for the profile dropdown.

**[@franksong2702](https://github.com/franksong2702)** — Most prolific external contributor (22 PRs, `v0.50.49` → `v0.50.245`)
The session title guard, breadcrumb workspace navigation, mobile workspace panel sliver fix (#1300), composer footer container queries, streaming session sidebar exemption (#1327), session sidecar repair, cron output preservation (#1295), profile default workspace persistence, and a long tail of polish across the session sidebar, mobile responsive layout, and workspace state machine.

**[@betamod](https://github.com/betamod)** — Security hardening (PR #171)
A comprehensive security audit PR covering CSRF protection, SSRF guards, XSS escaping improvements, and the env race condition between concurrent agent sessions — foundational security work that shipped in v0.39.0.

**[@TaraTheStar](https://github.com/TaraTheStar)** — Bot name + thinking blocks + login refactor (PRs #132, #176, #181)
Made the assistant display name configurable throughout the UI, added thinking/reasoning block display in chat, and refactored the login page to use template variables instead of inline string replacement.

**[@thadreber-web](https://github.com/thadreber-web)** — CLI session bridge (PR #56)
The original CLI session bridge: reads CLI sessions from the agent's SQLite state store and surfaces them in the WebUI sidebar. This was the first bridge between the CLI and WebUI session worlds.

**[@deboste](https://github.com/deboste)** — Reverse proxy auth + mobile responsive layout + model routing (PRs #3, #4, #5)
Three of the very first community PRs: fixed EventSource/fetch to use the URL origin for reverse proxy setups, corrected model provider routing from config, and added mobile responsive layout with dvh viewport fix. Early foundation work.

### Bug fix and security contributions

[Permalink: Bug fix and security contributions](https://github.com/nesquena/hermes-webui#bug-fix-and-security-contributions)

**[@Hinotoi-agent](https://github.com/Hinotoi-agent)** — Profile .env secret isolation (PR #351)
Fixed API key leakage between profiles on switch — switching from a profile with `OPENAI_API_KEY` to one without it left the key in the process environment for the duration of the session, effectively leaking credentials. A subtle and important security fix.

**[@lawrencel1ng](https://github.com/lawrencel1ng)** — Bandit security fixes B310/B324/B110 + QuietHTTPServer (PR #354)
Systematic bandit security scan fixes: URL scheme validation before `urlopen`, MD5 `usedforsecurity=False`, and 40+ bare `except: pass` blocks replaced with proper logging — plus `QuietHTTPServer` to stop client-disconnect log spam from SSE streams.

**[@lx3133584](https://github.com/lx3133584)** — CSRF fix for reverse proxy on non-standard ports (PR #360)
Fixed CSRF rejection for deployments behind Nginx Proxy Manager or similar on non-standard ports — a real-world blocker for anyone hosting on a port other than 80/443.

**[@DelightRun](https://github.com/DelightRun)** — session\_search fix for WebUI sessions (PR #356)
The `session_search` tool silently returned "Session database not available" in every WebUI session. Tracked down the missing `SessionDB` injection in the streaming path and fixed it.

**[@shaoxianbilly](https://github.com/shaoxianbilly)** — Unicode filename downloads (PR #378)
Fixed `UnicodeEncodeError` crashes when downloading workspace files with Chinese, Japanese, or other non-ASCII names. Implemented proper `Content-Disposition` header with RFC 5987 `filename*=UTF-8''...` encoding.

**[@huangzt](https://github.com/huangzt)** — Cancel interrupts agent (PR #244)
Made the Cancel button actually interrupt the running agent and clean up UI state, rather than just hiding the button while the agent kept running.

**[@tgaalman](https://github.com/tgaalman)** — Thinking card fix (PR #169)
Fixed top-level reasoning fields being missed in the thinking card display — an edge case in how Claude's extended thinking blocks surface in the API response.

**[@smurmann](https://github.com/smurmann)** — Custom provider routing fix (PR #189)
Fixed model routing for slash-prefixed custom provider models, which were being misrouted in the model selector. A precise fix for a real edge case in multi-provider setups.

**[@jeffscottward](https://github.com/jeffscottward)** — Claude Haiku model ID fix (PR #145)
Caught and corrected the Claude Haiku model ID (`3-5` → `4-5`) immediately after the Anthropic release — the kind of quick community catch that keeps the model dropdown accurate.

**[@kcclaw001](https://github.com/kcclaw001)** — Credential redaction in API responses (PR #243)
Added credential redaction to all API response paths so API keys, tokens, and other secrets in session data or error messages are masked before reaching the browser.

**[@mbac](https://github.com/mbac)** — Phantom "Custom" provider group fix (PR #191)
Removed the phantom "Custom" optgroup that appeared in the model dropdown even when no custom provider was configured — a small but consistently confusing UI noise issue.

**[@andrewy-wizard](https://github.com/andrewy-wizard)** — Chinese localization (PR #177)
Added Simplified Chinese (`zh`) locale to the WebUI. One of the first non-English locales and the most-used non-English locale in the codebase.

**[@mmartial](https://github.com/mmartial)** — Docker UID/GID matching (PR #237)
Added Docker support for running as an arbitrary UID/GID matching the host user, eliminating permission issues with bind-mounted volumes — essential for Docker deployments where the host user isn't UID 1000.

**[@vCillusion](https://github.com/vCillusion)** — pip package resolution fix (PR #76)
Fixed agent dependency resolution to prefer packages from the venv's site-packages over the agent directory itself, preventing shadowing bugs when developing locally.

**[@carlytwozero](https://github.com/carlytwozero)** — API key pass-through for non-Anthropic providers (PR #78)
Fixed `api_key` not being passed to `AIAgent` for non-Anthropic `/anthropic` providers — a quiet regression that silently broke any non-default provider.

**[@mangodxd](https://github.com/mangodxd)** — Type hints cleanup (PR #115)
Added missing type hints across 10 files and corrected 9 inaccurate existing ones — the kind of maintenance work that makes the codebase easier to reason about.

**[@Argonaut790](https://github.com/Argonaut790)** — HTML entity decode + Traditional Chinese locale (PR #239)
Fixed double-escaping of HTML entities in `renderMd()` — LLM output containing `&lt;code&gt;` was being escaped a second time, rendering as literal text instead of the intended markdown. The same PR also completed the Simplified Chinese translation (40+ missing keys) and added a full Traditional Chinese (`zh-Hant`) locale.

**[@indigokarasu](https://github.com/indigokarasu)** — Visual redesign proposal: icon rail + design token system + 7 themes (PR #213)
A CSS-only redesign of the full UI — proper design tokens (`--bg-primary`, `--text-info`, spacing scale), an icon rail sidebar replacing the emoji tab strip, consistent form cards, breadcrumb nav, and 7 built-in themes as custom properties. The PR didn't merge as-is but directly shaped the design language and theme architecture that shipped in v0.50.0.

**[@zenc-cp](https://github.com/zenc-cp)** — Anti-hallucination guard for ReAct loop (PR #133)
Added a streaming token buffer and post-run message scrub to `streaming.py` to detect and strip fake tool execution JSON that weaker models write inline instead of calling tools properly. A three-layer approach: ephemeral anti-hallucination prompt, live token filtering, and session history cleanup. The pattern influenced later streaming.py improvements.

* * *

Want to contribute? See [ARCHITECTURE.md](https://github.com/nesquena/hermes-webui/blob/master/ARCHITECTURE.md) for the codebase layout and [TESTING.md](https://github.com/nesquena/hermes-webui/blob/master/TESTING.md) for how to run the test suite. The best contributions are focused, well-tested, and solve a real problem — exactly what every person on this list did.

## Repo

[Permalink: Repo](https://github.com/nesquena/hermes-webui#repo)

```
git@github.com:nesquena/hermes-webui.git
```

## About

Hermes WebUI: The best way to use Hermes Agent from the web or from your phone!


[get-hermes.ai/](https://get-hermes.ai/ "https://get-hermes.ai/")

### Topics

[agent](https://github.com/topics/agent "Topic: agent") [hermes](https://github.com/topics/hermes "Topic: hermes") [ai-agents](https://github.com/topics/ai-agents "Topic: ai-agents") [hermes-agent](https://github.com/topics/hermes-agent "Topic: hermes-agent") [nous-research](https://github.com/topics/nous-research "Topic: nous-research")

### Resources

[Readme](https://github.com/nesquena/hermes-webui#readme-ov-file)

### License

[MIT license](https://github.com/nesquena/hermes-webui#MIT-1-ov-file)

### Contributing

[Contributing](https://github.com/nesquena/hermes-webui#contributing-ov-file)

### Uh oh!

There was an error while loading. [Please reload this page](https://github.com/nesquena/hermes-webui).

[Activity](https://github.com/nesquena/hermes-webui/activity)

### Stars

[**6.4k**\\
stars](https://github.com/nesquena/hermes-webui/stargazers)

### Watchers

[**26**\\
watching](https://github.com/nesquena/hermes-webui/watchers)

### Forks

[**818**\\
forks](https://github.com/nesquena/hermes-webui/forks)

[Report repository](https://github.com/contact/report-content?content_url=https%3A%2F%2Fgithub.com%2Fnesquena%2Fhermes-webui&report=nesquena+%28user%29)

## [Releases\  353](https://github.com/nesquena/hermes-webui/releases)

[v0.51.30\\
Latest\\
\\
17 hours agoMay 8, 2026](https://github.com/nesquena/hermes-webui/releases/tag/v0.51.30)

[\+ 352 releases](https://github.com/nesquena/hermes-webui/releases)

## [Packages\  1](https://github.com/users/nesquena/packages?repo_name=hermes-webui)

- [hermes-webui](https://github.com/users/nesquena/packages/container/package/hermes-webui)

## [Contributors\  96](https://github.com/nesquena/hermes-webui/graphs/contributors)

- [![@nesquena-hermes](https://avatars.githubusercontent.com/u/272340397?s=64&v=4)](https://github.com/nesquena-hermes)
- [![@nesquena](https://avatars.githubusercontent.com/u/6511?s=64&v=4)](https://github.com/nesquena)
- [![@claude](https://avatars.githubusercontent.com/u/81847?s=64&v=4)](https://github.com/claude)
- [![@Michaelyklam](https://avatars.githubusercontent.com/u/70162481?s=64&v=4)](https://github.com/Michaelyklam)
- [![@bergeouss](https://avatars.githubusercontent.com/u/48155732?s=64&v=4)](https://github.com/bergeouss)
- [![@laportacj_appstate](https://avatars.githubusercontent.com/u/226517000?s=64&v=4)](https://github.com/laportacj_appstate)
- [![@ai-ag2026](https://avatars.githubusercontent.com/u/261867348?s=64&v=4)](https://github.com/ai-ag2026)
- [![@dso2ng](https://avatars.githubusercontent.com/u/275702?s=64&v=4)](https://github.com/dso2ng)
- [![@starship-s](https://avatars.githubusercontent.com/u/45587122?s=64&v=4)](https://github.com/starship-s)
- [![@fxd-jason](https://avatars.githubusercontent.com/u/131768217?s=64&v=4)](https://github.com/fxd-jason)
- [![@franksong2702](https://avatars.githubusercontent.com/u/138988108?s=64&v=4)](https://github.com/franksong2702)
- [![@aronprins](https://avatars.githubusercontent.com/u/1126344?s=64&v=4)](https://github.com/aronprins)
- [![@24601](https://avatars.githubusercontent.com/u/1157207?s=64&v=4)](https://github.com/24601)
- [![@iRonin](https://avatars.githubusercontent.com/u/27929?s=64&v=4)](https://github.com/iRonin)

[\+ 82 contributors](https://github.com/nesquena/hermes-webui/graphs/contributors)

## Languages

- [Python72.1%](https://github.com/nesquena/hermes-webui/search?l=python)
- [JavaScript21.9%](https://github.com/nesquena/hermes-webui/search?l=javascript)
- [CSS3.6%](https://github.com/nesquena/hermes-webui/search?l=css)
- [HTML1.9%](https://github.com/nesquena/hermes-webui/search?l=html)
- [Shell0.5%](https://github.com/nesquena/hermes-webui/search?l=shell)
- [Dockerfile0.0%](https://github.com/nesquena/hermes-webui/search?l=dockerfile)

You can’t perform that action at this time.