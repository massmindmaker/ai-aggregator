[Skip to content](https://github.com/outsourc-e/hermes-workspace#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/outsourc-e/hermes-workspace) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/outsourc-e/hermes-workspace) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/outsourc-e/hermes-workspace) to refresh your session.Dismiss alert

{{ message }}

[outsourc-e](https://github.com/outsourc-e)/ **[hermes-workspace](https://github.com/outsourc-e/hermes-workspace)** Public

- [Notifications](https://github.com/login?return_to=%2Foutsourc-e%2Fhermes-workspace) You must be signed in to change notification settings
- [Fork\\
464](https://github.com/login?return_to=%2Foutsourc-e%2Fhermes-workspace)
- [Star\\
3.7k](https://github.com/login?return_to=%2Foutsourc-e%2Fhermes-workspace)


main

[**32** Branches](https://github.com/outsourc-e/hermes-workspace/branches) [**8** Tags](https://github.com/outsourc-e/hermes-workspace/tags)

[Go to Branches page](https://github.com/outsourc-e/hermes-workspace/branches)[Go to Tags page](https://github.com/outsourc-e/hermes-workspace/tags)

Go to file

Code

Open more actions menu

## Folders and files

| Name | Name | Last commit message | Last commit date |
| --- | --- | --- | --- |
| ## Latest commit<br>![outsourc-e](https://avatars.githubusercontent.com/u/201563152?v=4&size=40)![Aurora release bot](https://github.githubassets.com/images/gravatars/gravatar-user-420.png?size=40)<br>[outsourc-e](https://github.com/outsourc-e/hermes-workspace/commits?author=outsourc-e)<br>and<br>Aurora release bot<br>[docs(readme): bump to v2.3.0, drop MseeP badge, add Agent Pairing sec…](https://github.com/outsourc-e/hermes-workspace/commit/372b18a8e4e3fa7947ff3cf5651865560daca0a1)<br>Open commit detailsfailure<br>2 days agoMay 7, 2026<br>[372b18a](https://github.com/outsourc-e/hermes-workspace/commit/372b18a8e4e3fa7947ff3cf5651865560daca0a1) · 2 days agoMay 7, 2026<br>## History<br>[1,930 Commits](https://github.com/outsourc-e/hermes-workspace/commits/main/) <br>Open commit details<br>[View commit history for this file.](https://github.com/outsourc-e/hermes-workspace/commits/main/) 1,930 Commits |
| [.devcontainer](https://github.com/outsourc-e/hermes-workspace/tree/main/.devcontainer ".devcontainer") | [.devcontainer](https://github.com/outsourc-e/hermes-workspace/tree/main/.devcontainer ".devcontainer") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [.github/workflows](https://github.com/outsourc-e/hermes-workspace/tree/main/.github/workflows "This path skips through empty directories") | [.github/workflows](https://github.com/outsourc-e/hermes-workspace/tree/main/.github/workflows "This path skips through empty directories") | [ci(docker): authenticate smoke-test container](https://github.com/outsourc-e/hermes-workspace/commit/25bc7452466aaf838762957063c6a6865ff0eb20 "ci(docker): authenticate smoke-test container") | last weekMay 1, 2026 |
| [.vscode](https://github.com/outsourc-e/hermes-workspace/tree/main/.vscode ".vscode") | [.vscode](https://github.com/outsourc-e/hermes-workspace/tree/main/.vscode ".vscode") | [chore: Hermes Workspace v0.1.0 — initial open-source release](https://github.com/outsourc-e/hermes-workspace/commit/e8baad35b7476ec5dbb8d373aa7851857afd898a "chore: Hermes Workspace v0.1.0 — initial open-source release") | 2 months agoMar 16, 2026 |
| [assets](https://github.com/outsourc-e/hermes-workspace/tree/main/assets "assets") | [assets](https://github.com/outsourc-e/hermes-workspace/tree/main/assets "assets") | [feat(mcp): replace /settings/mcp with full-featured /mcp page (catalo…](https://github.com/outsourc-e/hermes-workspace/commit/c021ef5fccc14b1b19ae39569d4ad203f131d8af "feat(mcp): replace /settings/mcp with full-featured /mcp page (catalog + marketplace + sources) (#231)  * feat(mcp): MCP server management page (Phase 1)  Implements the MCP management plan (.omc/plans/mcp-management.md) Phase 1 end-to-end on a single feature branch (PR1+PR2+PR3+PR4 collapsed):  - New `/mcp` route with capability gate + BackendUnavailableState fallback. - New `/api/mcp` (GET list, POST create), `/api/mcp/test` (POST connection   probe), `/api/mcp/discover` (POST tool discovery for a draft config),   `/api/mcp/configure` (PUT enable/toolMode/include/exclude), and   `/api/mcp/$name` (DELETE). - Strict `mcp` capability probe in gateway-capabilities: hits `GET /api/mcp`   directly and validates the body parses through `normalizeMcpList` —   dashboard-up-but-route-missing returns false (resolves Open Question #4). - Type split: read shapes in `src/types/mcp.ts` (client+server), write   shapes in `src/types/mcp-input.ts` (server-only; secrets contained here). - Runtime normalization layer `src/server/mcp-normalize.ts` mirrors the   Skills `asRecord`/`readString`/`normalizeSkill` defense — strips   unknown fields, coerces enums, masks secrets via `MASK_SENTINEL`,   re-applies via `maskSecretsInPlace` before every `json(...)`. - All write endpoints CSRF-checked via `requireJsonContentType`. - Capability-off responses use `createCapabilityUnavailablePayload('mcp')`   with `{ servers: [], total: 0, categories }` for GET (200) and 503 for   writes — feature gates fall open without throwing. - Static preset catalog (`src/screens/mcp/presets.ts`) with GitHub,   Filesystem, Postgres, Slack, Linear; Catalog tab installs prefilled   drafts through the same dialog flow. - Screens: `McpScreen` (Installed/Catalog/All tabs + search + category   filter), `McpServerCard` (status badge + Test/Edit/Delete + enable   toggle), `McpServerDialog` (HTTP/stdio + auth + Discover + Save with   bearer-token clear-on-submit). - TanStack Query hooks (`useMcpServers`, `useTestMcpServer`,   `useDiscoverMcpTools`, `useUpsertMcpServer`, `useConfigureMcpServer`,   `useDeleteMcpServer`).  Tests (vitest): - `src/server/mcp-normalize.test.ts` — 13 tests covering enum coercion,   list-shape variants, malformed-entry drop, presence flags without   echo, env/header masking by key hint, idempotency, test-result   normalization, payload-string scanner. - `src/routes/api/-mcp.test.ts` — 8 tests covering input validation,   capability fall-open shape, CSRF gate (415 on non-JSON POST, pass on   JSON, pass on GET), and the **secret echo guard**: a worst-case agent   that echoes a submitted bearer token in body/env/headers must never   surface the original string in the workspace response.  Build, lint, and the new test files are clean. Pre-existing unrelated test failures on `local` (router-route-resolution, context-usage, markdown math, slash-command-menu, chat-message-list, gateway-capabilities env-source) are unchanged by this PR.  Worked with Interstellar Code  * fix(mcp): strip secret fields from client-safe McpClientInput  Architect review flagged that `McpClientInput` in `src/types/mcp.ts` (the file explicitly designated for client+server read shapes with no secrets) contained `bearerToken` and `oauth.clientSecret`, allowing the browser bundle to import a secret-bearing type via the dialog component.  Resolves the type-split violation: - `src/types/mcp.ts`: drop `bearerToken` and `oauth` from `McpClientInput`.   Now strictly the browser-safe form payload, no secret fields. - `src/screens/mcp/components/mcp-server-dialog.tsx`: hold `bearerToken`   in ephemeral component-local `useState<string>` typed inline. Cleared   on submit and on dialog open. No exported type carries the field. - `src/screens/mcp/hooks/use-mcp-mutations.ts`: `useUpsertMcpServer`   accepts `McpClientInput & { bearerToken?: string }` inline at the   call-site, again with no exported secret-bearing type. Server route   `parseMcpServerInput` re-validates and forwards to the agent.  The full server-side write shape (`McpServerInput` with secrets) remains in `src/types/mcp-input.ts`, server-only.  Worked with Interstellar Code  * fix(mcp): block client imports of server-only mcp-input types  Add no-restricted-imports rule scoped to src/screens/** and src/components/** that blocks importing @/types/mcp-input. That file may carry unmasked secrets and is server-only — clients should import McpClientInput from @/types/mcp instead.  Worked with Interstellar Code  * feat(mcp): wire /mcp into all sidebar/nav surfaces  Mirror the existing /skills registration across every nav and command surface so the MCP screen is reachable from the dashboard overflow grid, command palette, mobile hamburger drawer, mobile tab bar, slash menu, search modal quick actions, and workspace shell (active-tab tracking + mobile page title). Inspector panel gets a parallel MCP tab that lists configured servers via /api/mcp.  Worked with Interstellar Code  * feat(mcp): catalog tab search, category badges, and nav coverage tests  Catalog tab now reuses the screen's search state to filter presets by name/description, surfaces an empty-state when no presets match, and renders each preset as a card with an Official Presets category badge styled to match the skills-screen design vocabulary.  Tests: - src/components/-mcp-nav.test.tsx: each modified nav file references   the /mcp route (or registers an mcp tab id for inspector-panel) - src/screens/mcp/-presets.test.ts: filtering MCP_PRESETS by query   narrows results by name and description, returns full catalog for   empty queries, and returns nothing for unknown queries  Worked with Interstellar Code  * feat(mcp): add MCP entry to chat-sidebar Knowledge group  The primary visible left rail (`chat-sidebar.tsx`) was missed by the prior nav-coverage commit. Slot MCP between Skills and Profiles in `knowledgeItems`, mirroring the McpServerIcon used elsewhere.  Worked with Interstellar Code  * feat(mcp): Phase 3 — live tool refresh, OAuth reauth, per-server SSE logs  - `useMcpServers`: enable refetchOnWindowFocus for live state. - `McpServerCard`: per-card Refresh button (re-runs Test, updates   discoveredToolsCount), Reauth button when authType === 'oauth' (uses   new useMcpOAuth hook), Logs button (opens McpLogsDrawer). - `use-mcp-oauth.ts`: opens auth URL in new tab, polls /api/mcp/test   every 2s until status === 'connected' or 60s timeout. Returns   mutation-style { start, isPending, isError, error, data }. - `mcp-logs-drawer.tsx`: fixed-right slide-in drawer subscribing via   EventSource to /api/mcp/<name>/logs. Newest-first, max 500 lines,   auto-scroll, tear down on close (no zombie EventSource). - `routes/api/mcp/$name.logs.ts`: SSE proxy with auth + capability   gates. Capability-off → 503. Pattern follows chat-events.ts. - Tests: 3 new for logs route (input validation, capability-off,   auth gate); smoke test for useMcpOAuth shape.  Total tests: 24 passing (13 normalize + 8 mcp + 3 logs). Build clean.  Worked with Interstellar Code  * feat(mcp): localhost-only config-fallback transport (Phase 1.5)  Adds an `mcpFallback` capability that lets the workspace perform CRUD on `config.mcp_servers` via the existing dashboard `/api/config` route when the agent does not yet expose the new `/api/mcp*` runtime endpoints.  Gated to loopback-only deployments by `isLocalhostDeployment()` (both URLs loopback AND HOST unset/loopback). Test/Discover/Logs return a structured \"not yet available\" payload in fallback mode; the MCP screen renders an amber banner so the limitation is visible.  Worked with Interstellar Code  * feat(mcp): full catalog + marketplace + sources manager (Phase 2-3.2)  Workspace-only end-to-end MCP catalog + marketplace replacing the static presets.ts and the upstream /settings/mcp surfaces.  Phase 2 — File-backed catalog: - assets/mcp-presets.seed.json + ~/.hermes/mcp-presets.json (atomic   bootstrap via tmp+linkSync, mtime+ino+ctime+size cache, malformed-file   preservation, schema validation: id regex, transport-specific fields,   env key regex, https URLs, category allowlist, duplicate-id rejection,   unknown-field warnings) - src/server/mcp-input-validate.ts: shared parseMcpServerInput returning   per-field {path, message} errors; promoted from inline definition - src/routes/api/mcp/presets.ts GET handler  Phase 3.0 — Federated marketplace: - src/server/mcp-hub/{cache,trust,index,types}.ts + sources/{mcp-get,   local-file}.ts: Smithery registry adapter (replaces speculative   registry.mcp.run NXDOMAIN), ETag/If-Modified-Since with 304 reuse,   rate-limit handling, parallel Promise.allSettled across sources with   8s per-source timeout, dedupe by source+id+name, fallback to   local-file when remote degraded - Trust hardening: shell metachar reject, transport allowlist, env-key   regex, control-char + absolute-path attack defenses, inline-exec   flag detection (-c, -lc, -e for sh/bash/python/node/perl/ruby) - src/screens/mcp/components/install-confirmation-dialog.tsx: 2-click   commit with full template preview (command/args/env masked) and   AbortController on dismiss - Disk persistence for tool-discovery cache (mcp-tools-cache.ts) +   hermes-mcp CLI bridge (mcp-cli-bridge.ts) for live test/tool   enumeration in fallback mode  Phase 3.2 — User-configurable sources: - ~/.hermes/mcp-hub-sources.json schema (built-ins always present,   protected from mutation; user can add HTTPS-only generic-json   sources with trust+format) - src/routes/api/mcp/hub-sources{,.$id}.ts CRUD with per-process mutex   (read-modify-write race protection) - generic-json adapter: SSRF guard (private/loopback/link-local/IPv6   ULA all rejected after DNS resolution, redirects disabled), 5MB   response-size cap (streaming read), trust hard-cap at 'community'   for user-source entries, source field 'user:<id>' for dedupe - src/screens/mcp/components/sources-manager-dialog.tsx UI  Polish: - Placeholder detection at install confirmation (inline fill form   blocks commit until /path/to/, <your-...>, empty *_TOKEN/_KEY/etc   resolved) - Test result UX hints when stdio Connection closed + placeholder args   or http fetch failed + placeholder url - Env-ref preserved in normalize (${VAR_NAME} no longer masked) +   Edit dialog diagnostic  UI: Skills-pattern parity for /mcp screen (Tabs + Marketplace tab, Switch primitive, Button primitives, DialogRoot/Content, primary-* Tailwind classes matching skills-screen.tsx). Single-row toolbar (tabs + search + filter). Removed All + Catalog tabs, kept Installed + Marketplace.  Backend: - gateway-capabilities probeMcp uses authenticated dashboardFetch   (Codex MAJOR fix); probeMcpConfigKey + isLocalhostDeployment for   mcpFallback capability - routes/mcp.tsx route gate accepts mcp || mcpFallback - mcp-normalize.ts headers.Authorization + env *_TOKEN/_KEY/_SECRET   /_AUTH/_APIKEY auth detection upgrades authType to 'bearer'  Removed (replaced by /mcp): - src/screens/settings/mcp-settings-screen.tsx (759 LOC) - src/routes/settings/mcp.tsx - src/routes/api/mcp/{servers,reload}.ts (orphaned endpoints; reload   posted to gateway 404s) - src/screens/mcp/presets.ts (static array, replaced by file-backed) - settings-sidebar MCP nav entries (replaced by main /mcp route)  Tests: 263+ passing across 19+ MCP suites — input-validate, presets- store, hub-cache/trust/unified-search, sources/{mcp-get,local-file, generic-json}, hub-sources-store, mcp-tools-cache, ssrf-guard, marketplace-install-confirmation, marketplace-placeholder-detection, hub-search/-presets/-hub-sources route tests. Pre-existing 2 gateway-capabilities env-resolution failures unrelated.  Reviewers: Codex critic 4 passes (Phase 2 REJECTED → 8 fixes applied, Phase 3.0 APPROVED-WITH-CHANGES → 4 fixes, Phase 3.2 REJECTED → 6 fixes including SSRF guard + response-size cap + concurrent-CRUD mutex + trust cap). Architect approved final pass.  Worked with Interstellar Code") | last weekMay 3, 2026 |
| [docs](https://github.com/outsourc-e/hermes-workspace/tree/main/docs "docs") | [docs](https://github.com/outsourc-e/hermes-workspace/tree/main/docs "docs") | [feat: agora HUD polish to match mockup (](https://github.com/outsourc-e/hermes-workspace/commit/2c4da3b43542263b6be159b783b1173274bdda25 "feat: agora HUD polish to match mockup (#376)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#376](https://github.com/outsourc-e/hermes-workspace/pull/376) [)](https://github.com/outsourc-e/hermes-workspace/commit/2c4da3b43542263b6be159b783b1173274bdda25 "feat: agora HUD polish to match mockup (#376)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 2 days agoMay 7, 2026 |
| [electron](https://github.com/outsourc-e/hermes-workspace/tree/main/electron "electron") | [electron](https://github.com/outsourc-e/hermes-workspace/tree/main/electron "electron") | [fix: make desktop updater optional at runtime](https://github.com/outsourc-e/hermes-workspace/commit/dbda66975772658c06470ab3ca094f915de5a391 "fix: make desktop updater optional at runtime") | last weekMay 1, 2026 |
| [memory](https://github.com/outsourc-e/hermes-workspace/tree/main/memory "memory") | [memory](https://github.com/outsourc-e/hermes-workspace/tree/main/memory "memory") | [feat(tasks): unify Workspace task board with Hermes Kanban backend (](https://github.com/outsourc-e/hermes-workspace/commit/4f177f9b8d9e812aad0bf9d3650a871148add694 "feat(tasks): unify Workspace task board with Hermes Kanban backend (#311) (#348)  * wip(hermesworld): viral sprint checkpoint - landing rebuild + character pipeline scaffold  - standalone /hermes-world and /world routes bypass workspace shell - root overlay leaks gated for landing + game surfaces - character pipeline scaffolding (player/npc/glb-body components) - canonical asset path public/assets/hermesworld/characters/ - docs: landing-page-spec, graphics-usability-plan, agora-believable-checklist, master-roadmap - handoff at memory/goals/2026-05-05-hermesworld-viral-sprint/handoff.md  Local-only checkpoint. Not for upstream yet.  * feat(playground): persistent admin mode toggle with shield button  - Admin mode now persists via localStorage (key: hermes-playground-admin) - Shield icon button in HUD (right rail, below focus toggle, md+) - Click toggles admin panel and saves preference - ?admin=1 URL param still works as override - gitignore swarm worker scratch dirs  Mission: memory/swarm/missions/2026-05-05-pr-triage.md (5 swarm lanes dispatched on 19 open PRs, no-merge contract)  * feat(landing): add Play Now CTAs to HermesWorld landing  - Hero: Play Now (primary, gold), View on GitHub (demoted), Read Roadmap - Header nav: Play badge (highlighted gold) - Final CTA: Play Now (primary), GitHub + Roadmap (secondary)  All Play buttons go to /playground which mounts the title screen (username + character customizer + Enter). Sets up the public-URL deploy: hermes-world.ai → / serves landing → click Play → /playground.  * fix(tasks): use shared kanban backend  ---------  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#311](https://github.com/outsourc-e/hermes-workspace/issues/311) | 4 days agoMay 5, 2026 |
| [playground-ws-worker](https://github.com/outsourc-e/hermes-workspace/tree/main/playground-ws-worker "playground-ws-worker") | [playground-ws-worker](https://github.com/outsourc-e/hermes-workspace/tree/main/playground-ws-worker "playground-ws-worker") | [feat(tasks): unify Workspace task board with Hermes Kanban backend (](https://github.com/outsourc-e/hermes-workspace/commit/4f177f9b8d9e812aad0bf9d3650a871148add694 "feat(tasks): unify Workspace task board with Hermes Kanban backend (#311) (#348)  * wip(hermesworld): viral sprint checkpoint - landing rebuild + character pipeline scaffold  - standalone /hermes-world and /world routes bypass workspace shell - root overlay leaks gated for landing + game surfaces - character pipeline scaffolding (player/npc/glb-body components) - canonical asset path public/assets/hermesworld/characters/ - docs: landing-page-spec, graphics-usability-plan, agora-believable-checklist, master-roadmap - handoff at memory/goals/2026-05-05-hermesworld-viral-sprint/handoff.md  Local-only checkpoint. Not for upstream yet.  * feat(playground): persistent admin mode toggle with shield button  - Admin mode now persists via localStorage (key: hermes-playground-admin) - Shield icon button in HUD (right rail, below focus toggle, md+) - Click toggles admin panel and saves preference - ?admin=1 URL param still works as override - gitignore swarm worker scratch dirs  Mission: memory/swarm/missions/2026-05-05-pr-triage.md (5 swarm lanes dispatched on 19 open PRs, no-merge contract)  * feat(landing): add Play Now CTAs to HermesWorld landing  - Hero: Play Now (primary, gold), View on GitHub (demoted), Read Roadmap - Header nav: Play badge (highlighted gold) - Final CTA: Play Now (primary), GitHub + Roadmap (secondary)  All Play buttons go to /playground which mounts the title screen (username + character customizer + Enter). Sets up the public-URL deploy: hermes-world.ai → / serves landing → click Play → /playground.  * fix(tasks): use shared kanban backend  ---------  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#311](https://github.com/outsourc-e/hermes-workspace/issues/311) | 4 days agoMay 5, 2026 |
| [public](https://github.com/outsourc-e/hermes-workspace/tree/main/public "public") | [public](https://github.com/outsourc-e/hermes-workspace/tree/main/public "public") | [feat: wire HermesWorld MJ assets (](https://github.com/outsourc-e/hermes-workspace/commit/8b12384b37803e4138a93300c45415324832f751 "feat: wire HermesWorld MJ assets (#374)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#374](https://github.com/outsourc-e/hermes-workspace/pull/374) [)](https://github.com/outsourc-e/hermes-workspace/commit/8b12384b37803e4138a93300c45415324832f751 "feat: wire HermesWorld MJ assets (#374)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 3 days agoMay 6, 2026 |
| [screenshots](https://github.com/outsourc-e/hermes-workspace/tree/main/screenshots "screenshots") | [screenshots](https://github.com/outsourc-e/hermes-workspace/tree/main/screenshots "screenshots") | [feat: SciFi theme — full dark/light palette with Tailwind v4 token re…](https://github.com/outsourc-e/hermes-workspace/commit/536e643d52f569068b0e3731ed1a51dd1ab265cf "feat: SciFi theme — full dark/light palette with Tailwind v4 token remaps (#320)  * Upload SciFi theme screenshot  * fix: stabilize workspace swarm process spawning (#302)  Co-authored-by: Jarno de Vries <jarno@match-day.nl>  * feat(theme): add SciFi theme (dark + light variants) (#303)  * feat(theme): add SciFi theme (dark + light variants)  - Add scifi-theme.css with neon accents, glow effects, gradient backgrounds - Register SciFi in theme.ts with dark/light color schemes - Add SciFi option in settings UI - Import scifi-theme.css in styles.css  * docs: add SciFi theme screenshot  ---------  Co-authored-by: Fungraphique <fungraphique@jarvis.local>  * fix(chat): cross-session response contamination + /new opens previous chat (#297, #300)  Two related session-routing bugs that landed responses (or new-chat clicks) into the wrong session.  #297 — cross-session response contamination  When the user navigated to a new chat while a previous chat was still streaming, the previous chat's response chunks would land in the **new** chat. Three fixes:  * useStreamingMessage now bumps a streamGenerationRef on every   startStreaming call. The fetch-reader loop captures that token at   start and re-checks it on every reader.read() and between events   in the same batch. If the token has changed (because the user   started a different stream), the loop cancels the reader and exits   without dispatching anything. This closes the brief race between   abortController.abort() and the underlying fetch reader actually   stopping, during which buffered chunks were silently writing into   activeSessionKeyRef.current (which had already been switched to   the new session).  * chat-screen now cancels the in-flight stream on session-key change   via a useEffect keyed on (activeCanonicalKey, activeFriendlyId,   isNewChat). Previously nothing cancelled the stream on navigation   \u2014 only the user clicking the explicit Stop button (handleStop)   called cancelStreaming().  #300 — /new slash command opens last chat instead of new session  /new was calling navigate({ to: '/chat' }), but the /chat index route unconditionally redirects to localStorage('claude-last-session'), so /new always landed in whichever chat was last active. Fixed at three entry points so all 'new chat' actions go through the explicit 'new' sentinel:  * /new in chat-screen.handleUiSlashCommand * /new in command-palette.runSlashCommand * 'New Chat' quick-action tile in the search modal  The 'Chat' nav link in the sidebar still goes to /chat (= last session) \u2014 that's the correct behaviour for a screen-level nav target. Only 'new' actions are routed to the new sentinel.  Closes #297, #300  * fix(terminal): keep PTY alive across SSE disconnects + auto-reattach (#298)  The browser terminal periodically 'reset back to prompt' during normal use because any transient SSE disconnect (network blip, browser tab suspension, HMR reload, dev-server restart) tore down the user's PTY and dropped them into a fresh shell.  Root cause: terminal-stream's request.signal abort handler called session.close(), which SIGTERM'd the underlying Python PTY helper. There was also no auto-reconnect on the client \u2014 a single dropped read terminated the loop, called /api/terminal-close, cleared the tab's sessionId, and left the user with an idle tab.  Fix in three parts:  1) terminal-sessions: TerminalSession gains markDetached() and    markAttached(). markDetached() starts a TTL timer (default 5 min,    override via HERMES_TERMINAL_DETACH_TTL_MS) that reaps the PTY only    if no client reattaches in time. The map keeps the session live in    the meantime.  2) terminal-stream: accepts an optional sessionId in the POST body. If    the id matches a still-alive session, the route reattaches to it    instead of spawning a fresh PTY. The 'session' event payload now    includes a 'reattach' flag. On SSE abort, we just detach listeners    and call session.markDetached() \u2014 the PTY stays running.  3) terminal-workspace: passes sessionId on every connect, so reconnect    reattaches automatically. When the read loop ends and the tab still    has a sessionId, we attempt a single quick reattach with a    '[reconnecting...]' nudge to the user instead of tearing the tab    down. /api/terminal-close is no longer called on stream end \u2014 the    server-side TTL handles abandoned sessions.  Fixes #298  * fix(scifi-theme): remap amber tokens to cyan/teal — no more pale yellow in SciFi  Amber colors (used for warnings/alerts in usage meter, agent thinking, inspector badges, etc.) were not remapped in the SciFi theme, causing: - Pale yellow bg-amber-100 with light text → unreadable menu items - Jarring yellow accents breaking the cyberpunk aesthetic - Trigger pill and selection states with impossible contrast  Remap all --color-amber-* tokens: - Dark theme: amber → cyan/teal gradient (#041418 → #ccfaff) - Light theme: amber → teal gradient (#e8f4f6 → #0a1628)  This replaces the previous .bg-amber-100 !important hack which broke the usage meter bar by forcing dark text on already-dark remapped primary-50 backgrounds.  * fix(scifi-theme): tweak amber remap contrast values  Brighten the amber→cyan tokens slightly so bg-amber-100 is visible on --theme-panel (#0d1b2a) and text colors have good contrast on the darker backgrounds.  * fix(theme): SciFi — visible usage pill + selected menu item colors  - Brightened amber-100 to #0c3245 (was #0a2633, too dark on #060b18 bg) - Brightened amber-50/200/300/400/500/600/700 gradient for better contrast - Added !important overrides for .bg-amber-100 to force background and   text color, overriding MenuItem inline styles that were blocking   the selected menu item appearance in SciFi dark theme  * fix(scifi-theme): add yellow, neutral, and white overrides for dark mode  - Add --color-yellow-* remap to teal-warm tones (was missing entirely) - Add --color-neutral-* remap to dark slate/navy tones - Add .bg-white override to theme-card for dialog backgrounds - Add .bg-amber-100 color override for MenuItem selected state   (MenuItem uses inline style color:var(--theme-text) which overwrites    Tailwind text-amber-800, now overridden with !important) - Add scifi-light remaps for yellow, red, emerald, neutral tokens - Fixes: pale yellow/white backgrounds in usage meter menu, View Details   dialog, status badges, progress bars, and tab pills in SciFi dark mode  * fix: replace bg-white with bg-primary-50 in usage-details-modal for theme compatibility  - All bg-white/bg-white/N in usage-details-modal replaced with bg-primary-50/N   which is properly remapped by the SciFi theme (--theme-card/panel) - Active tab pill: bg-white → bg-primary-100, text-primary-900 → text-primary-800 - Set as Default button: bg-white → bg-primary-50, hover:bg-primary-50 → hover:bg-primary-100 - Removed aggressive bg-white !important overrides from scifi-theme.css that   broke borders, switches, and other elements using white elsewhere  * fix(scifi-theme): rewrite theme following nous pattern  - Replace hex values with var(--theme-*) references (same as nous theme) - Remove broken red/emerald/yellow/neutral remaps that caused border/bg issues - Add !important on dark-mode primary/accent remaps (needed for Tailwind v4 oklch) - Move @import scifi-theme.css to END of styles.css (after .system dark rules) - Keep essential .bg-amber-100 overrides for menu selected state - Result: 238 lines (was 350+), clean structure matching nous theme pattern  Root cause: Tailwind v4 uses oklch color-mix internally for utility classes. Simple --color-amber-100: #0f3547 overrides don't work because .border-primary-200 resolves via color-mix, not via the CSS custom property. Using var(--theme-*) with !important ensures proper resolution.  * fix(scifi-theme): add !important to all dark mode token remaps  Tailwind v4 defines color tokens as oklch in @layer theme, which has higher specificity than plain [data-theme] selectors. Without !important, the remaps were ignored and components displayed native Tailwind colors (white, amber, neutral-gray) instead of the SciFi palette.  Also remap --color-white to #0d1b2a so bg-white becomes dark navy in SciFi dark mode (fixes chat-controls popover white background).  * feat(scifi): active tab indicator — cyan accent glow on Session/Providers tabs  * fix(scifi-theme): review fixes - 9 corrections  * fix: restore tab selector without role=tablist (component doesn't use it)  * fix(scifi): tab selector uses .bg-primary-50 > button instead of [role=tablist]  The usage-details-modal tabs don't use role=tablist ARIA attribute, so [role=tablist] selector never matched. The tab container has bg-primary-50 and direct child buttons with bg-primary-100 when active.  ---------  Co-authored-by: jarnodevries-byte <jarnodevries@gmail.com> Co-authored-by: Jarno de Vries <jarno@match-day.nl> Co-authored-by: Fungraphique <fungraphique@jarvis.local> Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 2 days agoMay 7, 2026 |
| [scripts](https://github.com/outsourc-e/hermes-workspace/tree/main/scripts "scripts") | [scripts](https://github.com/outsourc-e/hermes-workspace/tree/main/scripts "scripts") | [feat: add HermesWorld brand asset pack (](https://github.com/outsourc-e/hermes-workspace/commit/85e2f72b210a8e8b7bbbb7320f4f5ab8d70165f1 "feat: add HermesWorld brand asset pack (#367)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#367](https://github.com/outsourc-e/hermes-workspace/pull/367) [)](https://github.com/outsourc-e/hermes-workspace/commit/85e2f72b210a8e8b7bbbb7320f4f5ab8d70165f1 "feat: add HermesWorld brand asset pack (#367)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 3 days agoMay 6, 2026 |
| [skills/workspace-dispatch](https://github.com/outsourc-e/hermes-workspace/tree/main/skills/workspace-dispatch "This path skips through empty directories") | [skills/workspace-dispatch](https://github.com/outsourc-e/hermes-workspace/tree/main/skills/workspace-dispatch "This path skips through empty directories") | [Fix conductor mission tracking and portable fallback](https://github.com/outsourc-e/hermes-workspace/commit/e2425f698ea9f779d59362f060f6db4c610d223c "Fix conductor mission tracking and portable fallback  (cherry picked from commit 2ce6c799b17e5bd69ecae41fcf7b85e67ebb2a8c)") | last weekMay 1, 2026 |
| [src](https://github.com/outsourc-e/hermes-workspace/tree/main/src "src") | [src](https://github.com/outsourc-e/hermes-workspace/tree/main/src "src") | [feat(vt-capital): add guardian oms cockpit (](https://github.com/outsourc-e/hermes-workspace/commit/65767e652f0a9e13142049f3b0c3cee5b798e2dd "feat(vt-capital): add guardian oms cockpit (#364)  Co-authored-by: root <root@ego2.hstgr.cloud>") [#364](https://github.com/outsourc-e/hermes-workspace/pull/364) [)](https://github.com/outsourc-e/hermes-workspace/commit/65767e652f0a9e13142049f3b0c3cee5b798e2dd "feat(vt-capital): add guardian oms cockpit (#364)  Co-authored-by: root <root@ego2.hstgr.cloud>") | 2 days agoMay 7, 2026 |
| [.dockerignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.dockerignore ".dockerignore") | [.dockerignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.dockerignore ".dockerignore") | [feat: Docker Compose + Codespaces setup — one command to run everything](https://github.com/outsourc-e/hermes-workspace/commit/fc3f64880e5f870e701c43f47039f68c975a9c18 "feat: Docker Compose + Codespaces setup — one command to run everything") | 2 months agoMar 18, 2026 |
| [.env.example](https://github.com/outsourc-e/hermes-workspace/blob/main/.env.example ".env.example") | [.env.example](https://github.com/outsourc-e/hermes-workspace/blob/main/.env.example ".env.example") | [feat: add VITE\_HERMESWORLD\_ENABLED env var to optionally hide HermesW…](https://github.com/outsourc-e/hermes-workspace/commit/c934d59fdabe0750459a3822794d9a4104c58cd2 "feat: add VITE_HERMESWORLD_ENABLED env var to optionally hide HermesWorld link (#322)  Allow operators to hide the HermesWorld sidebar link by setting VITE_HERMESWORLD_ENABLED=0 in .env.  Default is enabled (1).  Closes the gap for users who don't want gamification/playground links in their workspace sidebar.") | 4 days agoMay 5, 2026 |
| [.eslintignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.eslintignore ".eslintignore") | [.eslintignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.eslintignore ".eslintignore") | [chore: Hermes Workspace v0.1.0 — initial open-source release](https://github.com/outsourc-e/hermes-workspace/commit/e8baad35b7476ec5dbb8d373aa7851857afd898a "chore: Hermes Workspace v0.1.0 — initial open-source release") | 2 months agoMar 16, 2026 |
| [.gitignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.gitignore ".gitignore") | [.gitignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.gitignore ".gitignore") | [feat(tasks): unify Workspace task board with Hermes Kanban backend (](https://github.com/outsourc-e/hermes-workspace/commit/4f177f9b8d9e812aad0bf9d3650a871148add694 "feat(tasks): unify Workspace task board with Hermes Kanban backend (#311) (#348)  * wip(hermesworld): viral sprint checkpoint - landing rebuild + character pipeline scaffold  - standalone /hermes-world and /world routes bypass workspace shell - root overlay leaks gated for landing + game surfaces - character pipeline scaffolding (player/npc/glb-body components) - canonical asset path public/assets/hermesworld/characters/ - docs: landing-page-spec, graphics-usability-plan, agora-believable-checklist, master-roadmap - handoff at memory/goals/2026-05-05-hermesworld-viral-sprint/handoff.md  Local-only checkpoint. Not for upstream yet.  * feat(playground): persistent admin mode toggle with shield button  - Admin mode now persists via localStorage (key: hermes-playground-admin) - Shield icon button in HUD (right rail, below focus toggle, md+) - Click toggles admin panel and saves preference - ?admin=1 URL param still works as override - gitignore swarm worker scratch dirs  Mission: memory/swarm/missions/2026-05-05-pr-triage.md (5 swarm lanes dispatched on 19 open PRs, no-merge contract)  * feat(landing): add Play Now CTAs to HermesWorld landing  - Hero: Play Now (primary, gold), View on GitHub (demoted), Read Roadmap - Header nav: Play badge (highlighted gold) - Final CTA: Play Now (primary), GitHub + Roadmap (secondary)  All Play buttons go to /playground which mounts the title screen (username + character customizer + Enter). Sets up the public-URL deploy: hermes-world.ai → / serves landing → click Play → /playground.  * fix(tasks): use shared kanban backend  ---------  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#311](https://github.com/outsourc-e/hermes-workspace/issues/311) | 4 days agoMay 5, 2026 |
| [.npmrc](https://github.com/outsourc-e/hermes-workspace/blob/main/.npmrc ".npmrc") | [.npmrc](https://github.com/outsourc-e/hermes-workspace/blob/main/.npmrc ".npmrc") | [chore: Hermes Workspace v0.1.0 — initial open-source release](https://github.com/outsourc-e/hermes-workspace/commit/e8baad35b7476ec5dbb8d373aa7851857afd898a "chore: Hermes Workspace v0.1.0 — initial open-source release") | 2 months agoMar 16, 2026 |
| [.prettierignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.prettierignore ".prettierignore") | [.prettierignore](https://github.com/outsourc-e/hermes-workspace/blob/main/.prettierignore ".prettierignore") | [chore: Hermes Workspace v0.1.0 — initial open-source release](https://github.com/outsourc-e/hermes-workspace/commit/e8baad35b7476ec5dbb8d373aa7851857afd898a "chore: Hermes Workspace v0.1.0 — initial open-source release") | 2 months agoMar 16, 2026 |
| [CHANGELOG.md](https://github.com/outsourc-e/hermes-workspace/blob/main/CHANGELOG.md "CHANGELOG.md") | [CHANGELOG.md](https://github.com/outsourc-e/hermes-workspace/blob/main/CHANGELOG.md "CHANGELOG.md") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [CONTRIBUTING.md](https://github.com/outsourc-e/hermes-workspace/blob/main/CONTRIBUTING.md "CONTRIBUTING.md") | [CONTRIBUTING.md](https://github.com/outsourc-e/hermes-workspace/blob/main/CONTRIBUTING.md "CONTRIBUTING.md") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [Dockerfile](https://github.com/outsourc-e/hermes-workspace/blob/main/Dockerfile "Dockerfile") | [Dockerfile](https://github.com/outsourc-e/hermes-workspace/blob/main/Dockerfile "Dockerfile") | [fix(docker): re-add python3 to runtime image (regression of](https://github.com/outsourc-e/hermes-workspace/commit/a08b9af6a356905631992b226164af891a7f3a61 "fix(docker): re-add python3 to runtime image (regression of #161/#185) (#267)  PR #185 (commit 8b45b632) added python3 to the runtime Dockerfile to fix issue #161 — terminal broken in Docker because scripts/pty-helper.py requires Python at runtime.  Commit efcb7d14 (2026-05-01 'migrate legacy Hermes codename bytes to canonical Claude') reverted the Dockerfile to a pre-#185 state without python3, regressing #161 silently. Issue #259 reports the regression.  This is a one-line restore. Inline comment added so the next rename sweep doesn't trip over it again.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#161](https://github.com/outsourc-e/hermes-workspace/issues/161) [/](https://github.com/outsourc-e/hermes-workspace/commit/a08b9af6a356905631992b226164af891a7f3a61 "fix(docker): re-add python3 to runtime image (regression of #161/#185) (#267)  PR #185 (commit 8b45b632) added python3 to the runtime Dockerfile to fix issue #161 — terminal broken in Docker because scripts/pty-helper.py requires Python at runtime.  Commit efcb7d14 (2026-05-01 'migrate legacy Hermes codename bytes to canonical Claude') reverted the Dockerfile to a pre-#185 state without python3, regressing #161 silently. Issue #259 reports the regression.  This is a one-line restore. Inline comment added so the next rename sweep doesn't trip over it again.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#185](https://github.com/outsourc-e/hermes-workspace/pull/185) [) (](https://github.com/outsourc-e/hermes-workspace/commit/a08b9af6a356905631992b226164af891a7f3a61 "fix(docker): re-add python3 to runtime image (regression of #161/#185) (#267)  PR #185 (commit 8b45b632) added python3 to the runtime Dockerfile to fix issue #161 — terminal broken in Docker because scripts/pty-helper.py requires Python at runtime.  Commit efcb7d14 (2026-05-01 'migrate legacy Hermes codename bytes to canonical Claude') reverted the Dockerfile to a pre-#185 state without python3, regressing #161 silently. Issue #259 reports the regression.  This is a one-line restore. Inline comment added so the next rename sweep doesn't trip over it again.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | last weekMay 3, 2026 |
| [FEATURES-INVENTORY.md](https://github.com/outsourc-e/hermes-workspace/blob/main/FEATURES-INVENTORY.md "FEATURES-INVENTORY.md") | [FEATURES-INVENTORY.md](https://github.com/outsourc-e/hermes-workspace/blob/main/FEATURES-INVENTORY.md "FEATURES-INVENTORY.md") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [FUTURE-FEATURES.md](https://github.com/outsourc-e/hermes-workspace/blob/main/FUTURE-FEATURES.md "FUTURE-FEATURES.md") | [FUTURE-FEATURES.md](https://github.com/outsourc-e/hermes-workspace/blob/main/FUTURE-FEATURES.md "FUTURE-FEATURES.md") | [feat: v1.0.0 — profiles, knowledge browser, MCP settings, skills hub …](https://github.com/outsourc-e/hermes-workspace/commit/fb17b5f86ff9f8468eb75b6b8613e708e019bbca "feat: v1.0.0 — profiles, knowledge browser, MCP settings, skills hub upgrade, eslint, security contact update  New features: - Multi-profile management (create, switch, rename, delete) - Knowledge browser with document viewer - MCP server settings screen - Skills hub with marketplace search fallback - Context usage tracking and display  Improvements: - eslint added and auto-fixed (69 issues resolved) - Settings dialog restructured (Agent, Smart Routing, Voice, Display sections) - Navigation updated with Profiles tab across desktop/mobile - Security contact updated to GitHub advisories + X DM - .gitignore hardened (.runtime/, internal dev docs) - Version bumped to 1.0.0  Build: clean | TypeScript: 0 errors | Tests: 4/4 passing") | last monthApr 10, 2026 |
| [LICENSE](https://github.com/outsourc-e/hermes-workspace/blob/main/LICENSE "LICENSE") | [LICENSE](https://github.com/outsourc-e/hermes-workspace/blob/main/LICENSE "LICENSE") | [chore: Hermes Workspace v0.1.0 — initial open-source release](https://github.com/outsourc-e/hermes-workspace/commit/e8baad35b7476ec5dbb8d373aa7851857afd898a "chore: Hermes Workspace v0.1.0 — initial open-source release") | 2 months agoMar 16, 2026 |
| [README.md](https://github.com/outsourc-e/hermes-workspace/blob/main/README.md "README.md") | [README.md](https://github.com/outsourc-e/hermes-workspace/blob/main/README.md "README.md") | [docs(readme): bump to v2.3.0, drop MseeP badge, add Agent Pairing sec…](https://github.com/outsourc-e/hermes-workspace/commit/372b18a8e4e3fa7947ff3cf5651865560daca0a1 "docs(readme): bump to v2.3.0, drop MseeP badge, add Agent Pairing section (#389)  - Remove the MseeP.ai security badge - the crocodile mascot doesn't fit   Workspace branding and Workspace isn't an MCP server (it's an agent UI),   so the audit badge was confusing for users skimming the readme. - Bump the visible version badge from 2.1.3 to 2.3.0 to match the actual   shipped version. - Add a dedicated 'Pair an Agent with the Workspace' section between the   install paths and Docker, covering:   - Architecture diagram (which service does what on which port)   - Three-command pairing workflow   - Verify-pairing curl checks   - .env reference table   - Common pairing scenarios (local, Tailscale/VPN, multi-profile, remote)   - Live re-pairing without restart   - Troubleshooting for the four most common pairing errors  The previous readme split this information across the 'Already running hermes-agent? Attach the workspace to it' and 'Manual install' sections, which was hard to follow if your question was just 'how do I connect agent X to workspace Y'.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 2 days agoMay 7, 2026 |
| [SECURITY.md](https://github.com/outsourc-e/hermes-workspace/blob/main/SECURITY.md "SECURITY.md") | [SECURITY.md](https://github.com/outsourc-e/hermes-workspace/blob/main/SECURITY.md "SECURITY.md") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [docker-compose.dev.yml](https://github.com/outsourc-e/hermes-workspace/blob/main/docker-compose.dev.yml "docker-compose.dev.yml") | [docker-compose.dev.yml](https://github.com/outsourc-e/hermes-workspace/blob/main/docker-compose.dev.yml "docker-compose.dev.yml") | [chore(docker): drop stale local Dockerfiles, simplify dev overlay (](https://github.com/outsourc-e/hermes-workspace/commit/57618a000e424dae24721590b8697ae6ce440510 "chore(docker): drop stale local Dockerfiles, simplify dev overlay (#237)  Removes `docker/agent/Dockerfile` and `docker/workspace/Dockerfile`:  - `docker/agent/Dockerfile` cloned the wrong repo (`outsourc-e/hermes-agent`   is the workspace fork, not the agent) and ran the old `claude` binary   name. It would not build successfully. - `docker/workspace/Dockerfile` was a dev-mode (`pnpm dev`) variant that   duplicated the production root `Dockerfile` for no benefit; the dev   overlay now reuses the root Dockerfile with hot-build instead.  Updates `docker-compose.dev.yml` to build only the workspace from local source via the canonical root Dockerfile. The Hermes Agent service stays on the canonical `nousresearch/hermes-agent:latest` upstream image (~750k pulls), with a clear note in the overlay header explaining how to override if a custom agent image is genuinely needed.  Adds a quick-start path table at the top of README pointing 'compose gig' users straight at the Docker section, and rewrites the dev-overlay section to match the simpler reality.  This addresses the recurring 'can we get a docker image so I can set up a compose gig instead of building from source' community ask. The image already exists at `ghcr.io/outsourc-e/hermes-workspace:latest`, the compose file just works \u2014 the stale local Dockerfiles were the only thing making the dev overlay confusing.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#237](https://github.com/outsourc-e/hermes-workspace/pull/237) [)](https://github.com/outsourc-e/hermes-workspace/commit/57618a000e424dae24721590b8697ae6ce440510 "chore(docker): drop stale local Dockerfiles, simplify dev overlay (#237)  Removes `docker/agent/Dockerfile` and `docker/workspace/Dockerfile`:  - `docker/agent/Dockerfile` cloned the wrong repo (`outsourc-e/hermes-agent`   is the workspace fork, not the agent) and ran the old `claude` binary   name. It would not build successfully. - `docker/workspace/Dockerfile` was a dev-mode (`pnpm dev`) variant that   duplicated the production root `Dockerfile` for no benefit; the dev   overlay now reuses the root Dockerfile with hot-build instead.  Updates `docker-compose.dev.yml` to build only the workspace from local source via the canonical root Dockerfile. The Hermes Agent service stays on the canonical `nousresearch/hermes-agent:latest` upstream image (~750k pulls), with a clear note in the overlay header explaining how to override if a custom agent image is genuinely needed.  Adds a quick-start path table at the top of README pointing 'compose gig' users straight at the Docker section, and rewrites the dev-overlay section to match the simpler reality.  This addresses the recurring 'can we get a docker image so I can set up a compose gig instead of building from source' community ask. The image already exists at `ghcr.io/outsourc-e/hermes-workspace:latest`, the compose file just works \u2014 the stale local Dockerfiles were the only thing making the dev overlay confusing.  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | last weekMay 2, 2026 |
| [docker-compose.yml](https://github.com/outsourc-e/hermes-workspace/blob/main/docker-compose.yml "docker-compose.yml") | [docker-compose.yml](https://github.com/outsourc-e/hermes-workspace/blob/main/docker-compose.yml "docker-compose.yml") | [fix(docker): start Hermes Agent gateway in compose (](https://github.com/outsourc-e/hermes-workspace/commit/2b8093b556ad65c9246110eb59a750eb38504f43 "fix(docker): start Hermes Agent gateway in compose (#385)  The hermes-agent image's default entrypoint is the interactive CLI which exits immediately under `docker compose up -d`, causing the gateway to appear absent and the Workspace healthcheck/connection to fail with \"Could not reach Hermes gateway\". Override the command to `gateway run` so the long-running API/health server starts.  Reproducible without this fix: a fresh `docker compose up -d` against upstream main fails with the symptoms reported in #360 across several users (different OSes), and the only working remedy was for users to manually patch their compose with `command: gateway run`.  Closes #360  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#385](https://github.com/outsourc-e/hermes-workspace/pull/385) [)](https://github.com/outsourc-e/hermes-workspace/commit/2b8093b556ad65c9246110eb59a750eb38504f43 "fix(docker): start Hermes Agent gateway in compose (#385)  The hermes-agent image's default entrypoint is the interactive CLI which exits immediately under `docker compose up -d`, causing the gateway to appear absent and the Workspace healthcheck/connection to fail with \"Could not reach Hermes gateway\". Override the command to `gateway run` so the long-running API/health server starts.  Reproducible without this fix: a fresh `docker compose up -d` against upstream main fails with the symptoms reported in #360 across several users (different OSes), and the only working remedy was for users to manually patch their compose with `command: gateway run`.  Closes #360  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 2 days agoMay 7, 2026 |
| [electron-builder.config.cjs](https://github.com/outsourc-e/hermes-workspace/blob/main/electron-builder.config.cjs "electron-builder.config.cjs") | [electron-builder.config.cjs](https://github.com/outsourc-e/hermes-workspace/blob/main/electron-builder.config.cjs "electron-builder.config.cjs") | [fix: stabilize desktop build and chat warning guard](https://github.com/outsourc-e/hermes-workspace/commit/627d7f4d8e25ff77ec47e2d462c9bf33e149cd13 "fix: stabilize desktop build and chat warning guard") | last weekMay 1, 2026 |
| [eslint.config.js](https://github.com/outsourc-e/hermes-workspace/blob/main/eslint.config.js "eslint.config.js") | [eslint.config.js](https://github.com/outsourc-e/hermes-workspace/blob/main/eslint.config.js "eslint.config.js") | [feat(mcp): replace /settings/mcp with full-featured /mcp page (catalo…](https://github.com/outsourc-e/hermes-workspace/commit/c021ef5fccc14b1b19ae39569d4ad203f131d8af "feat(mcp): replace /settings/mcp with full-featured /mcp page (catalog + marketplace + sources) (#231)  * feat(mcp): MCP server management page (Phase 1)  Implements the MCP management plan (.omc/plans/mcp-management.md) Phase 1 end-to-end on a single feature branch (PR1+PR2+PR3+PR4 collapsed):  - New `/mcp` route with capability gate + BackendUnavailableState fallback. - New `/api/mcp` (GET list, POST create), `/api/mcp/test` (POST connection   probe), `/api/mcp/discover` (POST tool discovery for a draft config),   `/api/mcp/configure` (PUT enable/toolMode/include/exclude), and   `/api/mcp/$name` (DELETE). - Strict `mcp` capability probe in gateway-capabilities: hits `GET /api/mcp`   directly and validates the body parses through `normalizeMcpList` —   dashboard-up-but-route-missing returns false (resolves Open Question #4). - Type split: read shapes in `src/types/mcp.ts` (client+server), write   shapes in `src/types/mcp-input.ts` (server-only; secrets contained here). - Runtime normalization layer `src/server/mcp-normalize.ts` mirrors the   Skills `asRecord`/`readString`/`normalizeSkill` defense — strips   unknown fields, coerces enums, masks secrets via `MASK_SENTINEL`,   re-applies via `maskSecretsInPlace` before every `json(...)`. - All write endpoints CSRF-checked via `requireJsonContentType`. - Capability-off responses use `createCapabilityUnavailablePayload('mcp')`   with `{ servers: [], total: 0, categories }` for GET (200) and 503 for   writes — feature gates fall open without throwing. - Static preset catalog (`src/screens/mcp/presets.ts`) with GitHub,   Filesystem, Postgres, Slack, Linear; Catalog tab installs prefilled   drafts through the same dialog flow. - Screens: `McpScreen` (Installed/Catalog/All tabs + search + category   filter), `McpServerCard` (status badge + Test/Edit/Delete + enable   toggle), `McpServerDialog` (HTTP/stdio + auth + Discover + Save with   bearer-token clear-on-submit). - TanStack Query hooks (`useMcpServers`, `useTestMcpServer`,   `useDiscoverMcpTools`, `useUpsertMcpServer`, `useConfigureMcpServer`,   `useDeleteMcpServer`).  Tests (vitest): - `src/server/mcp-normalize.test.ts` — 13 tests covering enum coercion,   list-shape variants, malformed-entry drop, presence flags without   echo, env/header masking by key hint, idempotency, test-result   normalization, payload-string scanner. - `src/routes/api/-mcp.test.ts` — 8 tests covering input validation,   capability fall-open shape, CSRF gate (415 on non-JSON POST, pass on   JSON, pass on GET), and the **secret echo guard**: a worst-case agent   that echoes a submitted bearer token in body/env/headers must never   surface the original string in the workspace response.  Build, lint, and the new test files are clean. Pre-existing unrelated test failures on `local` (router-route-resolution, context-usage, markdown math, slash-command-menu, chat-message-list, gateway-capabilities env-source) are unchanged by this PR.  Worked with Interstellar Code  * fix(mcp): strip secret fields from client-safe McpClientInput  Architect review flagged that `McpClientInput` in `src/types/mcp.ts` (the file explicitly designated for client+server read shapes with no secrets) contained `bearerToken` and `oauth.clientSecret`, allowing the browser bundle to import a secret-bearing type via the dialog component.  Resolves the type-split violation: - `src/types/mcp.ts`: drop `bearerToken` and `oauth` from `McpClientInput`.   Now strictly the browser-safe form payload, no secret fields. - `src/screens/mcp/components/mcp-server-dialog.tsx`: hold `bearerToken`   in ephemeral component-local `useState<string>` typed inline. Cleared   on submit and on dialog open. No exported type carries the field. - `src/screens/mcp/hooks/use-mcp-mutations.ts`: `useUpsertMcpServer`   accepts `McpClientInput & { bearerToken?: string }` inline at the   call-site, again with no exported secret-bearing type. Server route   `parseMcpServerInput` re-validates and forwards to the agent.  The full server-side write shape (`McpServerInput` with secrets) remains in `src/types/mcp-input.ts`, server-only.  Worked with Interstellar Code  * fix(mcp): block client imports of server-only mcp-input types  Add no-restricted-imports rule scoped to src/screens/** and src/components/** that blocks importing @/types/mcp-input. That file may carry unmasked secrets and is server-only — clients should import McpClientInput from @/types/mcp instead.  Worked with Interstellar Code  * feat(mcp): wire /mcp into all sidebar/nav surfaces  Mirror the existing /skills registration across every nav and command surface so the MCP screen is reachable from the dashboard overflow grid, command palette, mobile hamburger drawer, mobile tab bar, slash menu, search modal quick actions, and workspace shell (active-tab tracking + mobile page title). Inspector panel gets a parallel MCP tab that lists configured servers via /api/mcp.  Worked with Interstellar Code  * feat(mcp): catalog tab search, category badges, and nav coverage tests  Catalog tab now reuses the screen's search state to filter presets by name/description, surfaces an empty-state when no presets match, and renders each preset as a card with an Official Presets category badge styled to match the skills-screen design vocabulary.  Tests: - src/components/-mcp-nav.test.tsx: each modified nav file references   the /mcp route (or registers an mcp tab id for inspector-panel) - src/screens/mcp/-presets.test.ts: filtering MCP_PRESETS by query   narrows results by name and description, returns full catalog for   empty queries, and returns nothing for unknown queries  Worked with Interstellar Code  * feat(mcp): add MCP entry to chat-sidebar Knowledge group  The primary visible left rail (`chat-sidebar.tsx`) was missed by the prior nav-coverage commit. Slot MCP between Skills and Profiles in `knowledgeItems`, mirroring the McpServerIcon used elsewhere.  Worked with Interstellar Code  * feat(mcp): Phase 3 — live tool refresh, OAuth reauth, per-server SSE logs  - `useMcpServers`: enable refetchOnWindowFocus for live state. - `McpServerCard`: per-card Refresh button (re-runs Test, updates   discoveredToolsCount), Reauth button when authType === 'oauth' (uses   new useMcpOAuth hook), Logs button (opens McpLogsDrawer). - `use-mcp-oauth.ts`: opens auth URL in new tab, polls /api/mcp/test   every 2s until status === 'connected' or 60s timeout. Returns   mutation-style { start, isPending, isError, error, data }. - `mcp-logs-drawer.tsx`: fixed-right slide-in drawer subscribing via   EventSource to /api/mcp/<name>/logs. Newest-first, max 500 lines,   auto-scroll, tear down on close (no zombie EventSource). - `routes/api/mcp/$name.logs.ts`: SSE proxy with auth + capability   gates. Capability-off → 503. Pattern follows chat-events.ts. - Tests: 3 new for logs route (input validation, capability-off,   auth gate); smoke test for useMcpOAuth shape.  Total tests: 24 passing (13 normalize + 8 mcp + 3 logs). Build clean.  Worked with Interstellar Code  * feat(mcp): localhost-only config-fallback transport (Phase 1.5)  Adds an `mcpFallback` capability that lets the workspace perform CRUD on `config.mcp_servers` via the existing dashboard `/api/config` route when the agent does not yet expose the new `/api/mcp*` runtime endpoints.  Gated to loopback-only deployments by `isLocalhostDeployment()` (both URLs loopback AND HOST unset/loopback). Test/Discover/Logs return a structured \"not yet available\" payload in fallback mode; the MCP screen renders an amber banner so the limitation is visible.  Worked with Interstellar Code  * feat(mcp): full catalog + marketplace + sources manager (Phase 2-3.2)  Workspace-only end-to-end MCP catalog + marketplace replacing the static presets.ts and the upstream /settings/mcp surfaces.  Phase 2 — File-backed catalog: - assets/mcp-presets.seed.json + ~/.hermes/mcp-presets.json (atomic   bootstrap via tmp+linkSync, mtime+ino+ctime+size cache, malformed-file   preservation, schema validation: id regex, transport-specific fields,   env key regex, https URLs, category allowlist, duplicate-id rejection,   unknown-field warnings) - src/server/mcp-input-validate.ts: shared parseMcpServerInput returning   per-field {path, message} errors; promoted from inline definition - src/routes/api/mcp/presets.ts GET handler  Phase 3.0 — Federated marketplace: - src/server/mcp-hub/{cache,trust,index,types}.ts + sources/{mcp-get,   local-file}.ts: Smithery registry adapter (replaces speculative   registry.mcp.run NXDOMAIN), ETag/If-Modified-Since with 304 reuse,   rate-limit handling, parallel Promise.allSettled across sources with   8s per-source timeout, dedupe by source+id+name, fallback to   local-file when remote degraded - Trust hardening: shell metachar reject, transport allowlist, env-key   regex, control-char + absolute-path attack defenses, inline-exec   flag detection (-c, -lc, -e for sh/bash/python/node/perl/ruby) - src/screens/mcp/components/install-confirmation-dialog.tsx: 2-click   commit with full template preview (command/args/env masked) and   AbortController on dismiss - Disk persistence for tool-discovery cache (mcp-tools-cache.ts) +   hermes-mcp CLI bridge (mcp-cli-bridge.ts) for live test/tool   enumeration in fallback mode  Phase 3.2 — User-configurable sources: - ~/.hermes/mcp-hub-sources.json schema (built-ins always present,   protected from mutation; user can add HTTPS-only generic-json   sources with trust+format) - src/routes/api/mcp/hub-sources{,.$id}.ts CRUD with per-process mutex   (read-modify-write race protection) - generic-json adapter: SSRF guard (private/loopback/link-local/IPv6   ULA all rejected after DNS resolution, redirects disabled), 5MB   response-size cap (streaming read), trust hard-cap at 'community'   for user-source entries, source field 'user:<id>' for dedupe - src/screens/mcp/components/sources-manager-dialog.tsx UI  Polish: - Placeholder detection at install confirmation (inline fill form   blocks commit until /path/to/, <your-...>, empty *_TOKEN/_KEY/etc   resolved) - Test result UX hints when stdio Connection closed + placeholder args   or http fetch failed + placeholder url - Env-ref preserved in normalize (${VAR_NAME} no longer masked) +   Edit dialog diagnostic  UI: Skills-pattern parity for /mcp screen (Tabs + Marketplace tab, Switch primitive, Button primitives, DialogRoot/Content, primary-* Tailwind classes matching skills-screen.tsx). Single-row toolbar (tabs + search + filter). Removed All + Catalog tabs, kept Installed + Marketplace.  Backend: - gateway-capabilities probeMcp uses authenticated dashboardFetch   (Codex MAJOR fix); probeMcpConfigKey + isLocalhostDeployment for   mcpFallback capability - routes/mcp.tsx route gate accepts mcp || mcpFallback - mcp-normalize.ts headers.Authorization + env *_TOKEN/_KEY/_SECRET   /_AUTH/_APIKEY auth detection upgrades authType to 'bearer'  Removed (replaced by /mcp): - src/screens/settings/mcp-settings-screen.tsx (759 LOC) - src/routes/settings/mcp.tsx - src/routes/api/mcp/{servers,reload}.ts (orphaned endpoints; reload   posted to gateway 404s) - src/screens/mcp/presets.ts (static array, replaced by file-backed) - settings-sidebar MCP nav entries (replaced by main /mcp route)  Tests: 263+ passing across 19+ MCP suites — input-validate, presets- store, hub-cache/trust/unified-search, sources/{mcp-get,local-file, generic-json}, hub-sources-store, mcp-tools-cache, ssrf-guard, marketplace-install-confirmation, marketplace-placeholder-detection, hub-search/-presets/-hub-sources route tests. Pre-existing 2 gateway-capabilities env-resolution failures unrelated.  Reviewers: Codex critic 4 passes (Phase 2 REJECTED → 8 fixes applied, Phase 3.0 APPROVED-WITH-CHANGES → 4 fixes, Phase 3.2 REJECTED → 6 fixes including SSRF guard + response-size cap + concurrent-CRUD mutex + trust cap). Architect approved final pass.  Worked with Interstellar Code") | last weekMay 3, 2026 |
| [install.sh](https://github.com/outsourc-e/hermes-workspace/blob/main/install.sh "install.sh") | [install.sh](https://github.com/outsourc-e/hermes-workspace/blob/main/install.sh "install.sh") | [fix: clean Hermes Workspace setup and branding copy (](https://github.com/outsourc-e/hermes-workspace/commit/171229c78f6df8ebaed2ee10e07ee996a4b0cb5e "fix: clean Hermes Workspace setup and branding copy (#252)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#252](https://github.com/outsourc-e/hermes-workspace/pull/252) [)](https://github.com/outsourc-e/hermes-workspace/commit/171229c78f6df8ebaed2ee10e07ee996a4b0cb5e "fix: clean Hermes Workspace setup and branding copy (#252)  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | last weekMay 3, 2026 |
| [package.json](https://github.com/outsourc-e/hermes-workspace/blob/main/package.json "package.json") | [package.json](https://github.com/outsourc-e/hermes-workspace/blob/main/package.json "package.json") | [chore(release): v2.3.0](https://github.com/outsourc-e/hermes-workspace/commit/15fa9cd706f5c04e4db288fb958e21d10fc776da "chore(release): v2.3.0") | 2 days agoMay 7, 2026 |
| [pnpm-lock.yaml](https://github.com/outsourc-e/hermes-workspace/blob/main/pnpm-lock.yaml "pnpm-lock.yaml") | [pnpm-lock.yaml](https://github.com/outsourc-e/hermes-workspace/blob/main/pnpm-lock.yaml "pnpm-lock.yaml") | [feat(playground): cinematic postprocess pass — bloom + ACES tone mapp…](https://github.com/outsourc-e/hermes-workspace/commit/a3459ab18a88b5451bdf8c3b1db09fdd821f8f59 "feat(playground): cinematic postprocess pass — bloom + ACES tone mapping + vignette + ambient sparkle particles") | last weekMay 3, 2026 |
| [prettier.config.js](https://github.com/outsourc-e/hermes-workspace/blob/main/prettier.config.js "prettier.config.js") | [prettier.config.js](https://github.com/outsourc-e/hermes-workspace/blob/main/prettier.config.js "prettier.config.js") | [feat: v1.0.0 — profiles, knowledge browser, MCP settings, skills hub …](https://github.com/outsourc-e/hermes-workspace/commit/fb17b5f86ff9f8468eb75b6b8613e708e019bbca "feat: v1.0.0 — profiles, knowledge browser, MCP settings, skills hub upgrade, eslint, security contact update  New features: - Multi-profile management (create, switch, rename, delete) - Knowledge browser with document viewer - MCP server settings screen - Skills hub with marketplace search fallback - Context usage tracking and display  Improvements: - eslint added and auto-fixed (69 issues resolved) - Settings dialog restructured (Agent, Smart Routing, Voice, Display sections) - Navigation updated with Profiles tab across desktop/mobile - Security contact updated to GitHub advisories + X DM - .gitignore hardened (.runtime/, internal dev docs) - Version bumped to 1.0.0  Build: clean | TypeScript: 0 errors | Tests: 4/4 passing") | last monthApr 10, 2026 |
| [server-entry.js](https://github.com/outsourc-e/hermes-workspace/blob/main/server-entry.js "server-entry.js") | [server-entry.js](https://github.com/outsourc-e/hermes-workspace/blob/main/server-entry.js "server-entry.js") | [fix(chat): correct local session accounting and titles (](https://github.com/outsourc-e/hermes-workspace/commit/274e9a2e5c7ccdee6c0b4ef770dd0079a2ec1b59 "fix(chat): correct local session accounting and titles (#350)  * Hide normal chat sessions from agent sidebar  * Fix context meter for portable chat sessions  * Persist local session renames  * Show local session titles in sidebar  * Harden Workspace asset serving and expose Kanban nav  ---------  Co-authored-by: clawbot <clawbot@clawbots-Mac-mini.local>") [#350](https://github.com/outsourc-e/hermes-workspace/pull/350) [)](https://github.com/outsourc-e/hermes-workspace/commit/274e9a2e5c7ccdee6c0b4ef770dd0079a2ec1b59 "fix(chat): correct local session accounting and titles (#350)  * Hide normal chat sessions from agent sidebar  * Fix context meter for portable chat sessions  * Persist local session renames  * Show local session titles in sidebar  * Harden Workspace asset serving and expose Kanban nav  ---------  Co-authored-by: clawbot <clawbot@clawbots-Mac-mini.local>") | 2 days agoMay 7, 2026 |
| [swarm.yaml](https://github.com/outsourc-e/hermes-workspace/blob/main/swarm.yaml "swarm.yaml") | [swarm.yaml](https://github.com/outsourc-e/hermes-workspace/blob/main/swarm.yaml "swarm.yaml") | [fix(branding): restore Hermes naming across GitHub surfaces](https://github.com/outsourc-e/hermes-workspace/commit/7fe6f4a4bb4c8d35c4acf16e6fc12eb588e2609f "fix(branding): restore Hermes naming across GitHub surfaces") | last weekMay 1, 2026 |
| [tsconfig.json](https://github.com/outsourc-e/hermes-workspace/blob/main/tsconfig.json "tsconfig.json") | [tsconfig.json](https://github.com/outsourc-e/hermes-workspace/blob/main/tsconfig.json "tsconfig.json") | [fix(ci): remove stale workspace-daemon COPY from Dockerfile (](https://github.com/outsourc-e/hermes-workspace/commit/ffd60931efea6e0c6fcd1dd478ab2151595b9439 "fix(ci): remove stale workspace-daemon COPY from Dockerfile (#104)  The workspace-daemon/ package was removed in 82c3f70 but the Dockerfile manifest COPY wasn't cleaned up, so CI/docker builds have been failing at `COPY workspace-daemon/package.json workspace-daemon/` (fixes #88 pull manifest unknown symptom — no new images could be built/pushed).  Also: - tsconfig include: `vite.config.js` → `vite.config.ts` (actual file ext) - tsconfig: drop redundant `baseUrl`.\", already implied by `paths` in TS 5  Extracted from #91 to ship the CI unblock independently; the larger settings-UI portion of that PR stays open for separate review.  Co-authored-by: Eric <eric@outsourc-e.com> Co-authored-by: ajojotank <ajojotank@users.noreply.github.com>") [#104](https://github.com/outsourc-e/hermes-workspace/pull/104) [)](https://github.com/outsourc-e/hermes-workspace/commit/ffd60931efea6e0c6fcd1dd478ab2151595b9439 "fix(ci): remove stale workspace-daemon COPY from Dockerfile (#104)  The workspace-daemon/ package was removed in 82c3f70 but the Dockerfile manifest COPY wasn't cleaned up, so CI/docker builds have been failing at `COPY workspace-daemon/package.json workspace-daemon/` (fixes #88 pull manifest unknown symptom — no new images could be built/pushed).  Also: - tsconfig include: `vite.config.js` → `vite.config.ts` (actual file ext) - tsconfig: drop redundant `baseUrl`.\", already implied by `paths` in TS 5  Extracted from #91 to ship the CI unblock independently; the larger settings-UI portion of that PR stays open for separate review.  Co-authored-by: Eric <eric@outsourc-e.com> Co-authored-by: ajojotank <ajojotank@users.noreply.github.com>") | 2 weeks agoApr 22, 2026 |
| [vite.config.ts](https://github.com/outsourc-e/hermes-workspace/blob/main/vite.config.ts "vite.config.ts") | [vite.config.ts](https://github.com/outsourc-e/hermes-workspace/blob/main/vite.config.ts "vite.config.ts") | [fix: harden workspace swarm prompt submission (](https://github.com/outsourc-e/hermes-workspace/commit/4f1bf501051aa99529cba55065f6b2bd7ffbdc59 "fix: harden workspace swarm prompt submission (#307)  Co-authored-by: Jarno de Vries <jarno@match-day.nl>") [#307](https://github.com/outsourc-e/hermes-workspace/pull/307) [)](https://github.com/outsourc-e/hermes-workspace/commit/4f1bf501051aa99529cba55065f6b2bd7ffbdc59 "fix: harden workspace swarm prompt submission (#307)  Co-authored-by: Jarno de Vries <jarno@match-day.nl>") | 4 days agoMay 5, 2026 |
| [wrangler.jsonc](https://github.com/outsourc-e/hermes-workspace/blob/main/wrangler.jsonc "wrangler.jsonc") | [wrangler.jsonc](https://github.com/outsourc-e/hermes-workspace/blob/main/wrangler.jsonc "wrangler.jsonc") | [feat: HermesWorld name reservations — public claim flow (](https://github.com/outsourc-e/hermes-workspace/commit/4b3a47ae49188f962880f3ca481f88f562f7def4 "feat: HermesWorld name reservations — public claim flow (#383)  * feat(reserve): add HermesWorld name reservation flow  - /reserve form with live validation + counter - /reserve/confirm and /early-access routes - Server: name-reservations.ts (Supabase service-role storage, profanity + reserved-name filter, optional wallet) - API routes /api/hermesworld/reservations + /reservations/confirm - Cloudflare wrangler.jsonc for hermes-world deploy - 237-line test suite covers validation, normalization, dedup - SQL migration in docs/hermesworld/name-reservations.sql  Required env vars on production:   HERMESWORLD_SUPABASE_URL   HERMESWORLD_SUPABASE_SERVICE_ROLE_KEY   HERMESWORLD_RESERVE_BASE_URL (optional, default https://hermes-world.ai)   RESEND_API_KEY + RESERVE_FROM_EMAIL (optional, only if confirmation emails desired)   HERMESWORLD_RESERVED_NAMES (optional, comma-separated)  * chore(routes): regenerate routeTree for /reserve, /reserve/confirm, /early-access  ---------  Co-authored-by: Aurora release bot <release@outsourc-e.com>") [#383](https://github.com/outsourc-e/hermes-workspace/pull/383) [)](https://github.com/outsourc-e/hermes-workspace/commit/4b3a47ae49188f962880f3ca481f88f562f7def4 "feat: HermesWorld name reservations — public claim flow (#383)  * feat(reserve): add HermesWorld name reservation flow  - /reserve form with live validation + counter - /reserve/confirm and /early-access routes - Server: name-reservations.ts (Supabase service-role storage, profanity + reserved-name filter, optional wallet) - API routes /api/hermesworld/reservations + /reservations/confirm - Cloudflare wrangler.jsonc for hermes-world deploy - 237-line test suite covers validation, normalization, dedup - SQL migration in docs/hermesworld/name-reservations.sql  Required env vars on production:   HERMESWORLD_SUPABASE_URL   HERMESWORLD_SUPABASE_SERVICE_ROLE_KEY   HERMESWORLD_RESERVE_BASE_URL (optional, default https://hermes-world.ai)   RESEND_API_KEY + RESERVE_FROM_EMAIL (optional, only if confirmation emails desired)   HERMESWORLD_RESERVED_NAMES (optional, comma-separated)  * chore(routes): regenerate routeTree for /reserve, /reserve/confirm, /early-access  ---------  Co-authored-by: Aurora release bot <release@outsourc-e.com>") | 2 days agoMay 7, 2026 |
| View all files |

## Repository files navigation

[![Hermes Workspace](https://github.com/outsourc-e/hermes-workspace/raw/main/public/claude-avatar.webp)](https://github.com/outsourc-e/hermes-workspace/blob/main/public/claude-avatar.webp)

# Hermes Workspace

[Permalink: Hermes Workspace](https://github.com/outsourc-e/hermes-workspace#hermes-workspace)

**Your AI agent's command center — chat, files, memory, skills, and terminal in one place.**

[![Version](https://camo.githubusercontent.com/9e1c16b6b0e56c5c83ff9f08023213f86a01fb2348524ec572d8cda9e67dc846/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f76657273696f6e2d322e332e302d3235353762372e737667)](https://github.com/outsourc-e/hermes-workspace/blob/main/CHANGELOG.md)[![License](https://camo.githubusercontent.com/7013272bd27ece47364536a221edb554cd69683b68a46fc0ee96881174c4214c/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f6c6963656e73652d4d49542d626c75652e737667)](https://github.com/outsourc-e/hermes-workspace/blob/main/LICENSE)[![Node](https://camo.githubusercontent.com/788b8e1549df06e7890c44af8b8615c7e7f76c4840ed8c85aefb0cd566243a2d/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f6e6f64652d25334525334432322e302e302d627269676874677265656e2e737667)](https://nodejs.org/)[![PRs Welcome](https://camo.githubusercontent.com/787614831ae02f8c104e4a5f4443e715a4fc1cf59f6ffff9847ca7c9f0cd63ad/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f5052732d77656c636f6d652d3633363646312e737667)](https://github.com/outsourc-e/hermes-workspace/blob/main/CONTRIBUTING.md)

> Not a chat wrapper. A complete workspace — orchestrate agents, browse memory, manage skills, and control everything from one interface.

> **v2 — zero-fork.** Clone, don't fork. Runs on vanilla [`NousResearch/hermes-agent`](https://github.com/NousResearch/hermes-agent) installed via Nous's own installer. Chat, sessions, memory, skills, jobs, MCP, terminal, dashboard, Agent View, and Operations are all in vanilla parity. **Conductor** currently requires an additional dashboard plugin not in upstream yet — the UI shows a clear placeholder when that endpoint isn't available ( [#262](https://github.com/outsourc-e/hermes-workspace/issues/262)). Everything else works with zero patches.

[![Hermes Workspace](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/splash.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/splash.png)

* * *

## Swarm Mode

[Permalink: Swarm Mode](https://github.com/outsourc-e/hermes-workspace#swarm-mode)

Hermes Agent Swarm turns the workspace into a live control plane: unlimited Hermes Agents, 1 orchestrator, 0 humans manually dispatching.
Persistent tmux workers keep context across tasks, rotate safely, and report proof-bearing checkpoints.
Role-based dispatch routes builders, reviewers, docs, research, ops, triage, QA, and lab lanes without turning Eric into the task router.
A byte-verified review gate protects release branches before PRs ship.
Autonomous PR/issue lanes, lab experiments, and the repair playbook keep the machine moving while humans handle judgment.

Start here: [docs/swarm/](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/swarm)

- **Orchestrator Chat** — ask the control plane for one task, a decomposed mission, or a full broadcast.
- **Multi-Agent Control Plane** — see persistent Hermes Agents, roles, state, runtime, and routing wires in one surface.
- **Kanban TaskBoard** — plan backlog, ready, running, review, blocked, and done lanes without leaving the workspace.
- **Reports + Inbox** — review checkpoints, blockers, handoffs, and ready-for-human decisions.
- **TUI View built in** — attach to tmux-backed workers or fall back to a live shell/log stream.

* * *

## ✨ What's inside

[Permalink: ✨ What's inside](https://github.com/outsourc-e/hermes-workspace#-whats-inside)

- 💬 **Chat** — Real-time SSE streaming, tool call rendering, multi-session, markdown + syntax highlighting
- 🧠 **Memory** — Browse, search, and edit agent memory; markdown live editor
- 🧩 **Skills** — Browse 2,000+ skills with origin badges, filters, source paths, marketplace
- 🔌 **MCP** — Full /mcp page (catalog + marketplace + sources), or fallback to local config CRUD
- 📁 **Files + Terminal** — Full workspace file browser with Monaco; cross-platform PTY terminal
- 🎮 **Operations** — Multi-agent dashboard with profile presets (Sage/Trader/Builder/Scribe/Ops) and 'Needs setup' detection
- 📡 **Conductor** — Mission dispatch + decomposition (requires upstream dashboard plugin, see [#262](https://github.com/outsourc-e/hermes-workspace/issues/262))
- 👥 **Agent View** — Live agent panel in chat with avatar, queue, history, usage meter
- 🐝 **Swarm Mode** — Persistent tmux-backed Hermes Agent workers with role-based dispatch
- 🗄️ **Dashboard** — Aggregated overview: sessions, model mix, cost ledger, attention card, ops strip
- 🎨 **Themes** — Hermes, Nous, Bronze, Slate, Mono (light + dark)
- 🔒 **Security** — Auth middleware on every route, CSP, path-traversal guard, fail-closed remote bind
- 📱 **PWA + Tailscale** — Install as a native-feeling app; access from any device on your tailnet
- ⚙️ **Capability gates** — Features that need upstream endpoints (Conductor) show a clean placeholder instead of failing mid-action

* * *

## 📸 Screenshots

[Permalink: 📸 Screenshots](https://github.com/outsourc-e/hermes-workspace#-screenshots)

| Chat | Conductor |
| :-: | :-: |
| [![Chat](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/chat.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/chat.png) | [![Conductor](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/conductor.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/conductor.png) |

| Dashboard | Memory |
| :-: | :-: |
| [![Dashboard](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/dashboard.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/dashboard.png) | [![Memory](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/memory.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/memory.png) |

| Terminal | Settings |
| :-: | :-: |
| [![Terminal](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/terminal.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/terminal.png) | [![Settings](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/settings.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/settings.png) |

| Tasks | Jobs |
| :-: | :-: |
| [![Tasks](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/tasks.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/tasks.png) | [![Jobs](https://github.com/outsourc-e/hermes-workspace/raw/main/docs/screenshots/jobs.png)](https://github.com/outsourc-e/hermes-workspace/blob/main/docs/screenshots/jobs.png) |

* * *

## 🚀 Quick Start

[Permalink: 🚀 Quick Start](https://github.com/outsourc-e/hermes-workspace#-quick-start)

Three paths — pick the one that matches you:

| Path | Best for | Time |
| --- | --- | --- |
| **🐳 [Docker Compose](https://github.com/outsourc-e/hermes-workspace#-docker-quickstart)** | Self-hosters, home labs, "give me a compose gig" | ~2 min |
| **🌐 One-line install** | Local dev on macOS/Linux | ~3 min |
| **🔌 Attach to existing `hermes-agent`** | You already run Hermes Agent | ~1 min |

### One-line install

[Permalink: One-line install](https://github.com/outsourc-e/hermes-workspace#one-line-install)

```
curl -fsSL https://raw.githubusercontent.com/outsourc-e/hermes-workspace/main/install.sh | bash
```

This installs `hermes-agent` via Nous's official installer, clones this repo, sets up `.env`, and installs dependencies. Then:

```
hermes gateway run                  # terminal 1
cd ~/hermes-workspace && pnpm dev   # terminal 2
```

Open [http://localhost:3000](http://localhost:3000/). That's it.

* * *

### Already running `hermes-agent`? Attach the workspace to it

[Permalink: Already running hermes-agent? Attach the workspace to it](https://github.com/outsourc-e/hermes-workspace#already-running-hermes-agent-attach-the-workspace-to-it)

If you already have `hermes-agent` installed (via Nous's official installer, a source checkout, systemd, Docker, or another existing setup) and it's serving the gateway at `http://<host>:8642`, you don't need to reinstall anything — just point the workspace at it.

```
git clone https://github.com/outsourc-e/hermes-workspace.git
cd hermes-workspace
pnpm install
cp .env.example .env

# Point at your existing Hermes Agent services.
echo 'HERMES_API_URL=http://127.0.0.1:8642' >> .env
# Zero-fork installs also need the separate dashboard API for config/sessions/skills/jobs.
echo 'HERMES_DASHBOARD_URL=http://127.0.0.1:9119' >> .env

# If your gateway was started with API_SERVER_KEY (auth enabled), set the same value:
# echo 'HERMES_API_TOKEN=***' >> .env

pnpm dev                            # http://localhost:3000 (override with PORT=4000 pnpm dev)
```

Requirements on the agent side:

- Gateway bound to an address the workspace can reach (typically `API_SERVER_HOST=0.0.0.0` \+ the port exposed).
- `API_SERVER_ENABLED=true` in `~/.hermes/.env` (or the agent's env) so the gateway serves core APIs on `:8642`.
- `hermes dashboard` running (default `http://127.0.0.1:9119`) for zero-fork installs. The dashboard provides config, sessions, skills, and jobs APIs.
- If `API_SERVER_KEY` is set, the workspace must pass the same value via `HERMES_API_TOKEN` — otherwise leave both unset.

Verify both services before opening the workspace:

- `curl http://127.0.0.1:8642/health` should return ok.
- `curl http://127.0.0.1:9119/api/status` should return dashboard metadata.

Then start the workspace and complete onboarding — it should detect the gateway + dashboard pair and unlock the enhanced panes automatically.

#### Running on a remote host (Tailscale / VPN / LAN)

[Permalink: Running on a remote host (Tailscale / VPN / LAN)](https://github.com/outsourc-e/hermes-workspace#running-on-a-remote-host-tailscale--vpn--lan)

If the workspace and its browser live on different machines — e.g. the workspace runs on a Pi/Mac/home server and you access it from your phone over Tailscale — point `HERMES_API_URL` at the **reachable** backend address, not `127.0.0.1`:

```
# On the server running the workspace + gateway:
echo 'HERMES_API_URL=http://100.x.y.z:8642' >> .env
echo 'HERMES_DASHBOARD_URL=http://100.x.y.z:9119' >> .env

# Also tell the gateway to listen on all interfaces so Tailscale peers can reach it.
# In ~/.hermes/.env (or wherever the gateway reads config):
echo 'API_SERVER_HOST=0.0.0.0' >> ~/.hermes/.env
```

Then restart the gateway, dashboard, and workspace. Hit the workspace from the remote device and the connection probe will use the Tailscale IP instead of localhost. Both `HERMES_API_URL` and `HERMES_DASHBOARD_URL` must be set to Tailscale/LAN-reachable URLs — setting only one will leave the other probing `127.0.0.1` and failing.

**If you've already started the workspace**, you can update both URLs from `Settings → Connection` without restarting. The values are persisted to `~/.hermes/workspace-overrides.json` and take effect immediately (gateway capabilities are reprobed on save). Editing `.env` still works for pre-start config and for CI/containers.

* * *

### Manual install

[Permalink: Manual install](https://github.com/outsourc-e/hermes-workspace#manual-install)

Hermes Workspace works with any OpenAI-compatible backend. If your backend also exposes Hermes Agent gateway APIs, enhanced features like sessions, memory, skills, and jobs unlock automatically.

#### Prerequisites

[Permalink: Prerequisites](https://github.com/outsourc-e/hermes-workspace#prerequisites)

- **Node.js 22+** — [nodejs.org](https://nodejs.org/)
- **An OpenAI-compatible backend** — local, self-hosted, or remote
- **Optional:** Python 3.11+ if you want to run a Hermes Agent gateway locally

#### Step 1: Start your backend

[Permalink: Step 1: Start your backend](https://github.com/outsourc-e/hermes-workspace#step-1-start-your-backend)

Point Hermes Workspace at any backend that supports:

- `POST /v1/chat/completions`
- `GET /v1/models` recommended

Example Hermes Agent gateway setup (from scratch):

```
# Install hermes-agent via Nous's official installer
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# Configure a provider + start the gateway
hermes setup
hermes gateway run
```

Our one-liner installer (below) does both steps automatically. If you're using another OpenAI-compatible server, just note its base URL.

### Step 2: Install & Run Hermes Workspace

[Permalink: Step 2: Install & Run Hermes Workspace](https://github.com/outsourc-e/hermes-workspace#step-2-install--run-hermes-workspace)

```
# In a new terminal
git clone https://github.com/outsourc-e/hermes-workspace.git
cd hermes-workspace
pnpm install
cp .env.example .env
printf '\nHERMES_API_URL=http://127.0.0.1:8642\n' >> .env
pnpm dev                   # Starts on http://localhost:3000
```

> **Verify:** Open `http://localhost:3000` and complete the onboarding flow. First connect the backend, then verify chat works. If your gateway exposes Hermes Agent APIs, advanced features appear automatically.

#### Environment Variables

[Permalink: Environment Variables](https://github.com/outsourc-e/hermes-workspace#environment-variables)

```
# OpenAI-compatible backend URL
HERMES_API_URL=http://127.0.0.1:8642

# Optional: provider keys the Hermes Agent gateway can read at runtime.
# You only need the key(s) for whichever provider(s) you actually use.
# ANTHROPIC_API_KEY=***         # Anthropic
# OPENAI_API_KEY=sk-...                # GPT / o-series
# OPENROUTER_API_KEY=sk-or-v1-...      # OpenRouter (incl. free models)
# GOOGLE_API_KEY=AIza...               # Gemini
# (Ollama / LM Studio / local servers don't need a key)

# Optional: password-protect the web UI
# HERMES_PASSWORD=your_password
```

* * *

## 🧠 Local Models (Ollama, Atomic Chat, LM Studio, vLLM)

[Permalink: 🧠 Local Models (Ollama, Atomic Chat, LM Studio, vLLM)](https://github.com/outsourc-e/hermes-workspace#-local-models-ollama-atomic-chat-lm-studio-vllm)

Hermes Workspace supports two modes with local models:

### Portable Mode (Easiest)

[Permalink: Portable Mode (Easiest)](https://github.com/outsourc-e/hermes-workspace#portable-mode-easiest)

Point the workspace directly at your local server — no Hermes Agent gateway needed.

### Atomic Chat

[Permalink: Atomic Chat](https://github.com/outsourc-e/hermes-workspace#atomic-chat)

```
# Start workspace pointed at Atomic Chat
HERMES_API_URL=http://127.0.0.1:1337/v1 pnpm dev
```

Download [Atomic Chat](https://atomic.chat/), launch the desktop app, and make sure a model is loaded before starting Hermes Workspace.

### Ollama

[Permalink: Ollama](https://github.com/outsourc-e/hermes-workspace#ollama)

```
# Start Ollama
OLLAMA_ORIGINS=* ollama serve

# Start workspace pointed at Ollama
HERMES_API_URL=http://127.0.0.1:11434 pnpm dev
```

Chat works immediately. Sessions, memory, and skills show "Not Available" — that's expected in portable mode.

### Enhanced Mode (Full Features)

[Permalink: Enhanced Mode (Full Features)](https://github.com/outsourc-e/hermes-workspace#enhanced-mode-full-features)

Route through the Hermes Agent gateway for sessions, memory, skills, jobs, and tools.

Here are two explicit `~/.hermes/config.yaml` examples for the local providers we support directly in the workspace:

**Atomic Chat**

```
provider: atomic-chat
model: your-model-name
custom_providers:
  - name: atomic-chat
    base_url: http://127.0.0.1:1337/v1
    api_key: atomic-chat
    api_mode: chat_completions
```

**Ollama**

```
provider: ollama
model: qwen3:32b
custom_providers:
  - name: ollama
    base_url: http://127.0.0.1:11434/v1
    api_key: ollama
    api_mode: chat_completions
```

You can adapt the same shape for other OpenAI-compatible local runners, but `Atomic Chat` and `Ollama` are the two built-in local paths documented in the workspace UI.

**2\. Enable the API server in `~/.hermes/.env`:**

```
API_SERVER_ENABLED=true
```

**3\. Start the gateway, dashboard, and workspace:**

```
hermes gateway run          # Starts core APIs on :8642
hermes dashboard            # Starts dashboard APIs on :9119
HERMES_API_URL=http://127.0.0.1:8642 \
HERMES_DASHBOARD_URL=http://127.0.0.1:9119 \
pnpm dev
```

For authenticated gateways, also set `HERMES_API_TOKEN` in the workspace environment to the same value as `API_SERVER_KEY`.

All workspace features unlock automatically once both services are reachable — sessions persist, memory saves across chats, skills are available, and the dashboard shows real usage data.

> **Works with any OpenAI-compatible server** — Atomic Chat, Ollama, LM Studio, vLLM, llama.cpp, LocalAI, etc. Just change the `base_url` and `model` in the config above.

* * *

## 🤝 Pair an Agent with the Workspace

[Permalink: 🤝 Pair an Agent with the Workspace](https://github.com/outsourc-e/hermes-workspace#-pair-an-agent-with-the-workspace)

Workspace is the UI. **Hermes Agent** is the brain. They talk over two HTTP services on localhost (or any reachable network).

```
┌───────────────┐         :8642 gateway          ┌────────────────┐
│   Workspace    │ ─────────────────────▶ │  Hermes Agent  │
│   :3000 (UI)   │ ◀───────────────────── │  CLI / brain   │
└───────────────┘         :9119 dashboard        └────────────────┘
```

### Two services, three commands

[Permalink: Two services, three commands](https://github.com/outsourc-e/hermes-workspace#two-services-three-commands)

```
hermes gateway run     # terminal 1 · :8642 · chat, models, streaming, jobs
hermes dashboard       # terminal 2 · :9119 · sessions, skills, config, MCP
cd ~/hermes-workspace && pnpm dev   # terminal 3 · :3000 · the UI
```

> **Tip:**`pnpm start:all` starts gateway + dashboard + workspace in one shot if you've installed via the one-liner.

### Verify the pairing

[Permalink: Verify the pairing](https://github.com/outsourc-e/hermes-workspace#verify-the-pairing)

```
curl http://127.0.0.1:8642/health        # → {"status":"ok","platform":"hermes-agent"}
curl http://127.0.0.1:9119/api/status    # → {"status":"ok", ...}
```

Both must return `200`. If either fails, the workspace will fall back to **portable mode** (chat works, sessions/skills/memory show "Not Available").

### `.env` settings the workspace cares about

[Permalink: .env settings the workspace cares about](https://github.com/outsourc-e/hermes-workspace#env-settings-the-workspace-cares-about)

```
# Required: where the gateway is
HERMES_API_URL=http://127.0.0.1:8642

# Recommended: where the dashboard is (unlocks sessions/skills/config/MCP/jobs)
HERMES_DASHBOARD_URL=http://127.0.0.1:9119

# Only if your gateway was started with API_SERVER_KEY=... — paste the same value:
# HERMES_API_TOKEN=***

# Optional: password-protect the web UI itself
# HERMES_PASSWORD=***
```

### Common pairing scenarios

[Permalink: Common pairing scenarios](https://github.com/outsourc-e/hermes-workspace#common-pairing-scenarios)

| Scenario | Set this |
| --- | --- |
| Workspace + gateway on the same machine | `HERMES_API_URL=http://127.0.0.1:8642`, `HERMES_DASHBOARD_URL=http://127.0.0.1:9119` |
| Gateway on a remote server (Tailscale / VPN) | Set both URLs to the reachable IP (e.g. `http://100.x.y.z:8642`) and add `API_SERVER_HOST=0.0.0.0` to the gateway's `~/.hermes/.env` |
| Already-running `hermes-agent` from upstream installer | Just set `HERMES_API_URL` \+ `HERMES_DASHBOARD_URL` and skip the one-liner installer |
| Multiple agent profiles | Profiles live under `~/.hermes/profiles/<name>` — the dashboard switches between them at runtime; workspace follows automatically |

### Live re-pairing (no restart)

[Permalink: Live re-pairing (no restart)](https://github.com/outsourc-e/hermes-workspace#live-re-pairing-no-restart)

If you've already started the workspace, change either URL from **Settings → Connection** without restarting. Values persist to `~/.hermes/workspace-overrides.json` and gateway capabilities are reprobed on save.

### Troubleshooting

[Permalink: Troubleshooting](https://github.com/outsourc-e/hermes-workspace#troubleshooting)

- **`Could not reach Hermes gateway on 8645, 8642, or 8643`** — gateway isn't running, or `HERMES_API_URL` points somewhere unreachable. Run `hermes gateway run` and re-check.
- **Workspace shows "portable mode" / extended APIs missing** — dashboard isn't running. Start `hermes dashboard` in another terminal and refresh.
- **`Unauthorized` on every API call** — gateway has `API_SERVER_KEY` set but workspace is missing `HERMES_API_TOKEN`. Match them.
- **`Could not connect` from your phone over Tailscale** — gateway is bound to loopback. Set `API_SERVER_HOST=0.0.0.0` in `~/.hermes/.env` and restart it.

* * *

## 🐳 Docker Quickstart

[Permalink: 🐳 Docker Quickstart](https://github.com/outsourc-e/hermes-workspace#-docker-quickstart)

[![Open in GitHub Codespaces](https://camo.githubusercontent.com/13c539702bae25c57df3024e4b3d8acc0b5ab38176440b0d4e77a8e24daa5080/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f476974487562253230436f64657370616365732d4f70656e2d3138313731373f6c6f676f3d676974687562)](https://github.com/codespaces/new?hide_repo_select=true&ref=main&repo=outsourc-e/hermes-workspace)

The Docker setup runs both the **Hermes Agent gateway** and **Hermes Workspace** together.

### Prerequisites

[Permalink: Prerequisites](https://github.com/outsourc-e/hermes-workspace#prerequisites-1)

- **Docker**
- **Docker Compose**
- **Anthropic API Key** — [Get one here](https://console.anthropic.com/settings/keys) (required for the agent gateway)

### Step 1: Configure Environment

[Permalink: Step 1: Configure Environment](https://github.com/outsourc-e/hermes-workspace#step-1-configure-environment)

```
git clone https://github.com/outsourc-e/hermes-workspace.git
cd hermes-workspace
cp .env.example .env
```

Edit `.env` and add **at least one** LLM provider key — whichever provider you want hermes-agent to use:

```
# Pick one (or more). You do NOT need all of these.
# ANTHROPIC_API_KEY=***         # Anthropic
# OPENAI_API_KEY=sk-...                # GPT / o-series
# OPENROUTER_API_KEY=sk-or-v1-...      # OpenRouter (free models available)
# GOOGLE_API_KEY=AIza...               # Gemini
```

Using **Ollama, LM Studio, or another local server**? No key needed — just point hermes-agent at your local endpoint via the onboarding flow.

> **Heads up:**`hermes-agent` needs to be able to reach _some_ model. If you don't configure any provider (API key or local server), chat will fail on first message.

### Step 2: Start the Services

[Permalink: Step 2: Start the Services](https://github.com/outsourc-e/hermes-workspace#step-2-start-the-services)

```
docker compose up
```

This pulls two pre-built images and starts them:

- **hermes-agent** → `nousresearch/hermes-agent:latest` on port **8642**
- **hermes-workspace** → `ghcr.io/outsourc-e/hermes-workspace:latest` on port **3000**

No local build. First run takes a minute to pull; subsequent starts are instant.
Agent state (config, sessions, skills, memory, credentials) persists in the
legacy-named `claude-data` Docker volume, so containers can be recreated without data loss.

### Step 3: Access the Workspace

[Permalink: Step 3: Access the Workspace](https://github.com/outsourc-e/hermes-workspace#step-3-access-the-workspace)

Open `http://localhost:3000` and complete the onboarding.

> **Verify:** Check the Docker logs for `[gateway] Connected to Hermes Agent` — this confirms the workspace successfully connected to the agent.

### Building from source

[Permalink: Building from source](https://github.com/outsourc-e/hermes-workspace#building-from-source)

Want to hack on the workspace and have local changes hot-built into the
container? Use the dev overlay:

```
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

The base `docker-compose.yml` stays untouched — the overlay adds a `build:`
block for the `hermes-workspace` service so the local repo is compiled
instead of pulled. The Hermes Agent service still uses the canonical
`nousresearch/hermes-agent:latest` image; if you need a custom agent
build, tag it locally and override `image:` in your own
`compose.override.yml`.

### Using a Pre-Built Image (Coolify / Easypanel / Dokploy / Unraid)

[Permalink: Using a Pre-Built Image (Coolify / Easypanel / Dokploy / Unraid)](https://github.com/outsourc-e/hermes-workspace#using-a-pre-built-image-coolify--easypanel--dokploy--unraid)

Deploying Hermes Workspace to a PaaS or home-lab stack? Pull the image
directly from GitHub Container Registry:

```
ghcr.io/outsourc-e/hermes-workspace:latest
```

Available tags:

| Tag | What it is |
| --- | --- |
| `latest` | Latest `main` commit (stable; recommended) |
| `v2.0.0` | Pinned semver tag |
| `main-<sha>` | Specific commit |

Minimal Coolify / Easypanel config:

```
service: hermes-workspace
image: ghcr.io/outsourc-e/hermes-workspace:latest
port: 3000
env:
  HERMES_API_URL: http://hermes-agent:8642   # point at your gateway
  HERMES_API_TOKEN: ${API_SERVER_KEY}        # if gateway auth is enabled
```

The image is built for `linux/amd64` and `linux/arm64`. Pair it with either
a `nousresearch/hermes-agent:latest` container (what our `docker-compose.yml`
does by default) or an existing gateway on another host.

* * *

## 📱 Install as App (Recommended)

[Permalink: 📱 Install as App (Recommended)](https://github.com/outsourc-e/hermes-workspace#-install-as-app-recommended)

Hermes Workspace is a **Progressive Web App (PWA)** — install it for the full native app experience with no browser chrome, keyboard shortcuts, and offline support.

### 🖥️ Desktop (macOS / Windows / Linux)

[Permalink: 🖥️ Desktop (macOS / Windows / Linux)](https://github.com/outsourc-e/hermes-workspace#%EF%B8%8F-desktop-macos--windows--linux)

1. Open Hermes Workspace in **Chrome** or **Edge** at `http://localhost:3000`
2. Click the **install icon** (⊕) in the address bar
3. Click **Install** — Hermes Workspace opens as a standalone desktop app
4. Pin to Dock / Taskbar for quick access

> **macOS users:** After installing, you can also add it to your Launchpad.

### 📱 iPhone / iPad (iOS Safari)

[Permalink: 📱 iPhone / iPad (iOS Safari)](https://github.com/outsourc-e/hermes-workspace#-iphone--ipad-ios-safari)

1. Open Hermes Workspace in **Safari** on your iPhone
2. Tap the **Share** button (□↑)
3. Scroll down and tap **"Add to Home Screen"**
4. Tap **Add** — the Hermes Workspace icon appears on your home screen
5. Launch from home screen for the full native app experience

### 🤖 Android

[Permalink: 🤖 Android](https://github.com/outsourc-e/hermes-workspace#-android)

1. Open Hermes Workspace in **Chrome** on your Android device
2. Tap the **three-dot menu** (⋮) → **"Add to Home screen"**
3. Tap **Add** — Hermes Workspace is now a native-feeling app on your device

* * *

## 📡 Mobile Access via Tailscale

[Permalink: 📡 Mobile Access via Tailscale](https://github.com/outsourc-e/hermes-workspace#-mobile-access-via-tailscale)

Access Hermes Workspace from anywhere on your devices — no port forwarding, no VPN complexity.

### Setup

[Permalink: Setup](https://github.com/outsourc-e/hermes-workspace#setup)

1. **Install Tailscale** on your Mac and mobile device:
   - Mac: [tailscale.com/download](https://tailscale.com/download)
   - iPhone/Android: Search "Tailscale" in the App Store / Play Store
2. **Sign in** to the same Tailscale account on both devices

3. **Find your Mac's Tailscale IP:**



```
tailscale ip -4
# Example output: 100.x.x.x
```

4. **Open Hermes Workspace on your phone:**



```
http://100.x.x.x:3000
```

5. **Add to Home Screen** using the steps above for the full app experience


> 💡 Tailscale works over any network — home wifi, mobile data, even across countries. Your traffic stays end-to-end encrypted.

* * *

## 🖥️ Native Desktop App

[Permalink: 🖥️ Native Desktop App](https://github.com/outsourc-e/hermes-workspace#%EF%B8%8F-native-desktop-app)

> **Status: In Development** — A native Electron-based desktop app is in active development.

The desktop app will offer:

- Native window management and tray icon
- System notifications for agent events and mission completions
- Auto-launch on startup
- Deep OS integration (macOS menu bar, Windows taskbar)

**In the meantime:** Install Hermes Workspace as a PWA (see above) for a near-native desktop experience — it works great.

* * *

## ☁️ Cloud & Hosted Setup

[Permalink: ☁️ Cloud & Hosted Setup](https://github.com/outsourc-e/hermes-workspace#%EF%B8%8F-cloud--hosted-setup)

> **Status: Coming Soon**

A fully managed cloud version of Hermes Workspace is in development:

- **One-click deploy** — No self-hosting required
- **Multi-device sync** — Access your agents from any device
- **Team collaboration** — Shared mission control for your whole team
- **Automatic updates** — Always on the latest version

Features pending cloud infrastructure:

- Cross-device session sync
- Team shared memory and workspaces
- Cloud-hosted backend with managed uptime
- Webhook integrations and external triggers

* * *

## 🔒 Security & deployment env vars

[Permalink: 🔒 Security & deployment env vars](https://github.com/outsourc-e/hermes-workspace#-security--deployment-env-vars)

Key safeguards — most are on by default, the env vars below are for remote / Docker deployments where you opt out of the loopback default.

### Built-in safeguards

[Permalink: Built-in safeguards](https://github.com/outsourc-e/hermes-workspace#built-in-safeguards)

- Auth middleware on every API route
- CSP headers via meta tags
- Path-traversal prevention on file/memory routes (real-path boundary check, not string prefix)
- Rate limiting on endpoints
- Fail-closed startup guard: refuses to bind non-loopback without `HERMES_PASSWORD`
- Session cookies: `HttpOnly` \+ `SameSite=Strict` \+ `Secure` (in production)
- Optional password protection for the web UI

### Env vars for remote / Docker deployments

[Permalink: Env vars for remote / Docker deployments](https://github.com/outsourc-e/hermes-workspace#env-vars-for-remote--docker-deployments)

- `HERMES_PASSWORD` — required whenever `HOST ≠ 127.0.0.1` (legacy `CLAUDE_PASSWORD` still honored as a fallback)
- `COOKIE_SECURE=1` — force the `Secure` cookie flag when terminating HTTPS at a proxy
- `COOKIE_SECURE=0` — disable the `Secure` flag for plain-HTTP LAN deployments (`HOST=0.0.0.0` without HTTPS); without this, browsers silently drop session cookies and login fails (#149)
- `TRUST_PROXY=1` — trust `x-forwarded-for` / `x-real-ip` (only set behind a sanitizing reverse proxy)
- `HERMES_DASHBOARD_TOKEN` — explicit bearer for dashboard API (preferred over the legacy HTML-scrape fallback)
- `HERMES_API_TOKEN` — bearer for the Hermes Agent gateway when started with `API_SERVER_KEY` (legacy `CLAUDE_API_TOKEN` still honored)
- `HERMES_ALLOW_INSECURE_REMOTE=1` — bypass the fail-closed guard (not recommended)

See `.env.example` for the full list. Credits to [@kiosvantra](https://github.com/kiosvantra) for the security audit surfacing #121–#125.

* * *

## 🔧 Troubleshooting

[Permalink: 🔧 Troubleshooting](https://github.com/outsourc-e/hermes-workspace#-troubleshooting)

### "Workspace loads but chat doesn't work"

[Permalink: "Workspace loads but chat doesn't work"](https://github.com/outsourc-e/hermes-workspace#workspace-loads-but-chat-doesnt-work)

The workspace auto-detects your gateway's capabilities on startup. Check your terminal for a line like:

```
[gateway] http://127.0.0.1:8642 available: health, models; missing: sessions, skills, memory, config, jobs
[gateway] Missing Hermes Agent APIs detected. Update hermes-agent to the latest version.
```

**Fix:** Upgrade to the latest stock `hermes-agent`, which ships the extended endpoints:

```
cd ~/hermes-agent && git pull && uv pip install -e .
hermes gateway run
```

(If you installed via a different path, follow your Nous installer's upgrade instructions.) If you were on the old `outsourc-e/hermes-agent` fork, it's no longer needed as of v2 — uninstall it and use upstream instead.

### "Connection refused" or workspace hangs on load

[Permalink: "Connection refused" or workspace hangs on load](https://github.com/outsourc-e/hermes-workspace#connection-refused-or-workspace-hangs-on-load)

Your Hermes Agent gateway isn't running. Start it:

```
hermes gateway run
```

First-time run? Do `hermes setup` first to pick a provider and model.

### Ollama: chat returns empty or model shows "Offline"

[Permalink: Ollama: chat returns empty or model shows "Offline"](https://github.com/outsourc-e/hermes-workspace#ollama-chat-returns-empty-or-model-shows-offline)

Make sure your `~/.hermes/config.yaml` has the `custom_providers` section and `API_SERVER_ENABLED=true` in `~/.hermes/.env`. See [Local Models](https://github.com/outsourc-e/hermes-workspace#-local-models-ollama-lm-studio-vllm) above.

Also ensure Ollama is running with CORS enabled:

```
OLLAMA_ORIGINS=* ollama serve
```

Use `http://127.0.0.1:11434/v1` (not `localhost`) as the base URL.

Verify: `curl http://localhost:8642/health` should return `{"status": "ok"}`.

### "Using upstream NousResearch/hermes-agent"

[Permalink: "Using upstream NousResearch/hermes-agent"](https://github.com/outsourc-e/hermes-workspace#using-upstream-nousresearchhermes-agent)

v2+ runs on vanilla `hermes-agent`. **No fork required.** The upstream ships every endpoint the workspace needs for chat, sessions, memory, skills, config, jobs, MCP, terminal, and Agent View.

**One known exception:** **Conductor** uses a dashboard plugin that hasn't landed upstream yet. When the workspace detects the missing endpoint, the Conductor screen shows a clear "Upstream not ready" placeholder with a link to [issue #262](https://github.com/outsourc-e/hermes-workspace/issues/262) instead of failing mid-action. Everything else works.

If you're pinned to an older `hermes-agent` version and missing core endpoints, the workspace will degrade gracefully to **portable mode** with basic chat — upgrade upstream to restore full features.

### Docker: "Unauthorized" or "Connection refused" to hermes-agent

[Permalink: Docker: "Unauthorized" or "Connection refused" to hermes-agent](https://github.com/outsourc-e/hermes-workspace#docker-unauthorized-or-connection-refused-to-hermes-agent)

If using Docker Compose and getting auth errors:

1. **Check at least one provider key is set:**



```
grep -E '_API_KEY' .env
# Should show one of: ANTHROPIC_API_KEY, OPENAI_API_KEY, OPENROUTER_API_KEY, GOOGLE_API_KEY, ...
```







(hermes-agent reads whichever key matches the provider configured in `~/.hermes/config.yaml`.)

2. **View the agent container logs:**



```
docker compose logs hermes-agent
```







Look for startup errors or missing API key warnings.

3. **Verify the agent health endpoint:**



```
curl http://localhost:8642/health
# Should return: {"status": "ok"}
```

4. **Restart with fresh containers:**



```
docker compose down
docker compose up --build
```

5. **Check workspace logs for gateway status:**



```
docker compose logs hermes-workspace
```







Look for: `[gateway] http://hermes-agent:8642 mode=...` — if it shows `mode=disconnected`, the agent isn't running correctly.


### Docker: older `claude webapi` docs are wrong

[Permalink: Docker: older claude webapi docs are wrong](https://github.com/outsourc-e/hermes-workspace#docker-older-claude-webapi-docs-are-wrong)

The `claude webapi` command referenced in some pre-rename docs doesn't exist. The correct commands are:

```
hermes gateway run    # FastAPI gateway on :8642
hermes dashboard      # dashboard plugin on :9119 (sessions/skills/jobs/config)
```

The Docker setup runs both automatically — no action needed if using `docker compose up`.

* * *

## 🗺️ Roadmap

[Permalink: 🗺️ Roadmap](https://github.com/outsourc-e/hermes-workspace#%EF%B8%8F-roadmap)

### Shipped ✅

[Permalink: Shipped ✅](https://github.com/outsourc-e/hermes-workspace#shipped-)

| Feature | What it does |
| --- | --- |
| Chat + SSE streaming | Live agent output with tool call rendering |
| Files + Terminal | Full workspace file browser + cross-platform PTY |
| Memory + Skills browsers | Edit memory, browse 2,000+ skills with marketplace |
| Dashboard | Sessions, model mix, cost ledger, attention card |
| Operations | Multi-agent management with preset personas |
| Agent View | Live agent panel in chat |
| Swarm Mode | Persistent tmux-backed worker pool with role dispatch |
| MCP page | Full catalog + marketplace + sources |
| Mobile PWA + Tailscale | Install as native-feeling app on any device |
| Themes | Hermes / Nous / Bronze / Slate / Mono (light + dark) |
| Capability gates | Graceful 'upstream not ready' placeholders |
| Multi-provider | Anthropic, OpenAI, OpenRouter, Google, Ollama, LM Studio, vLLM, Atomic Chat |

### In progress 🔨

[Permalink: In progress 🔨](https://github.com/outsourc-e/hermes-workspace#in-progress-)

| Feature | Status |
| --- | --- |
| Conductor missions | Workspace UI is shipped; awaiting upstream dashboard plugin (see [#262](https://github.com/outsourc-e/hermes-workspace/issues/262)) |
| Native Desktop App (Electron) | Spec'd; PWA install path works today |

### Coming 🔜

[Permalink: Coming 🔜](https://github.com/outsourc-e/hermes-workspace#coming-)

| Feature | Status |
| --- | --- |
| Cloud / Hosted version | Pending infra |
| Team collaboration | Pending cloud + multi-tenant work |

* * *

## ⭐ Star History

[Permalink: ⭐ Star History](https://github.com/outsourc-e/hermes-workspace#-star-history)

## [![Star History Chart](https://camo.githubusercontent.com/a6d4fdf0a9e353b9408895c7e4fcc4d1a39bafee4db62500c4f77bd61338ddd1/68747470733a2f2f6170692e737461722d686973746f72792e636f6d2f7376673f7265706f733d6f7574736f7572632d652f6865726d65732d776f726b737061636526747970653d64617465266c6f677363616c65266c6567656e643d746f702d6c656674)](https://www.star-history.com/\#outsourc-e/hermes-workspace&type=date&logscale&legend=top-left)

[Permalink: ](https://github.com/outsourc-e/hermes-workspace#)

## 💛 Support the Project

[Permalink: 💛 Support the Project](https://github.com/outsourc-e/hermes-workspace#-support-the-project)

Hermes Workspace is free and open source. If it's saving you time and powering your workflow, consider supporting development:

**ETH:**`0xB332D4C60f6FBd94913e3Fd40d77e3FE901FAe22`

[![GitHub Sponsors](https://camo.githubusercontent.com/856bf8030a60ef09cec6b0ccacae765ece8eef592b2642a33dcfec11fb623e49/68747470733a2f2f696d672e736869656c64732e696f2f62616467652f53706f6e736f722d2545322539442541342d70696e6b3f6c6f676f3d676974687562)](https://github.com/sponsors/outsourc-e)

Every contribution helps keep this project moving. Thank you 🙏

* * *

## 🤝 Contributing

[Permalink: 🤝 Contributing](https://github.com/outsourc-e/hermes-workspace#-contributing)

PRs are welcome! See [CONTRIBUTING.md](https://github.com/outsourc-e/hermes-workspace/blob/main/CONTRIBUTING.md) for guidelines.

- Bug fixes → open a PR directly
- New features → open an issue first to discuss
- Security issues → see [SECURITY.md](https://github.com/outsourc-e/hermes-workspace/blob/main/SECURITY.md) for responsible disclosure

* * *

## 📄 License

[Permalink: 📄 License](https://github.com/outsourc-e/hermes-workspace#-license)

MIT — see [LICENSE](https://github.com/outsourc-e/hermes-workspace/blob/main/LICENSE) for details.

* * *

Built with ⚡ by [@outsourc-e](https://github.com/outsourc-e) and the Hermes Workspace community

## About

Native web workspace for Hermes Agent — chat, terminal, memory, skills, inspector.


[hermes-workspace.com](https://hermes-workspace.com/ "https://hermes-workspace.com")

### Topics

[react](https://github.com/topics/react "Topic: react") [typescript](https://github.com/topics/typescript "Topic: typescript") [hackathon](https://github.com/topics/hackathon "Topic: hackathon") [ai-workspace](https://github.com/topics/ai-workspace "Topic: ai-workspace") [agent-ui](https://github.com/topics/agent-ui "Topic: agent-ui") [hermes-agent](https://github.com/topics/hermes-agent "Topic: hermes-agent") [nous-research](https://github.com/topics/nous-research "Topic: nous-research")

### Resources

[Readme](https://github.com/outsourc-e/hermes-workspace#readme-ov-file)

### License

[MIT license](https://github.com/outsourc-e/hermes-workspace#MIT-1-ov-file)

### Contributing

[Contributing](https://github.com/outsourc-e/hermes-workspace#contributing-ov-file)

### Security policy

[Security policy](https://github.com/outsourc-e/hermes-workspace#security-ov-file)

### Uh oh!

There was an error while loading. [Please reload this page](https://github.com/outsourc-e/hermes-workspace).

[Activity](https://github.com/outsourc-e/hermes-workspace/activity)

### Stars

[**3.7k**\\
stars](https://github.com/outsourc-e/hermes-workspace/stargazers)

### Watchers

[**24**\\
watching](https://github.com/outsourc-e/hermes-workspace/watchers)

### Forks

[**464**\\
forks](https://github.com/outsourc-e/hermes-workspace/forks)

[Report repository](https://github.com/contact/report-content?content_url=https%3A%2F%2Fgithub.com%2Foutsourc-e%2Fhermes-workspace&report=outsourc-e+%28user%29)

## [Releases\  7](https://github.com/outsourc-e/hermes-workspace/releases)

[Hermes-Workspace v2.3.0 — HermesWorld integration, Agent View, Dashboard polish\\
Latest\\
\\
2 days agoMay 8, 2026](https://github.com/outsourc-e/hermes-workspace/releases/tag/v2.3.0)

[\+ 6 releases](https://github.com/outsourc-e/hermes-workspace/releases)

## [Packages\  1](https://github.com/users/outsourc-e/packages?repo_name=hermes-workspace)

- [hermes-workspace](https://github.com/users/outsourc-e/packages/container/package/hermes-workspace)

### Uh oh!

There was an error while loading. [Please reload this page](https://github.com/outsourc-e/hermes-workspace).

## [Contributors\  64](https://github.com/outsourc-e/hermes-workspace/graphs/contributors)

- [![@outsourc-e](https://avatars.githubusercontent.com/u/201563152?s=64&v=4)](https://github.com/outsourc-e)
- [![@Interstellar-code](https://avatars.githubusercontent.com/u/33978413?s=64&v=4)](https://github.com/Interstellar-code)
- [![@claude](https://avatars.githubusercontent.com/u/81847?s=64&v=4)](https://github.com/claude)
- [![@dontcallmejames](https://avatars.githubusercontent.com/u/7460674?s=64&v=4)](https://github.com/dontcallmejames)
- [![@kadeross](https://avatars.githubusercontent.com/u/3628192?s=64&v=4)](https://github.com/kadeross)
- [![@CrazySerGo](https://avatars.githubusercontent.com/u/11334923?s=64&v=4)](https://github.com/CrazySerGo)
- [![@PaulBlackSwan](https://avatars.githubusercontent.com/u/50180437?s=64&v=4)](https://github.com/PaulBlackSwan)
- [![@jarnodevries-byte](https://avatars.githubusercontent.com/u/245686800?s=64&v=4)](https://github.com/jarnodevries-byte)
- [![@kvncrw](https://avatars.githubusercontent.com/u/3759919?s=64&v=4)](https://github.com/kvncrw)
- [![@Sanjays2402](https://avatars.githubusercontent.com/u/51058514?s=64&v=4)](https://github.com/Sanjays2402)
- [![@Sn0wfly](https://avatars.githubusercontent.com/u/53617627?s=64&v=4)](https://github.com/Sn0wfly)
- [![@dterenyi](https://avatars.githubusercontent.com/u/54645613?s=64&v=4)](https://github.com/dterenyi)
- [![@DiamondEyesFox](https://avatars.githubusercontent.com/u/119838309?s=64&v=4)](https://github.com/DiamondEyesFox)
- [![@google-labs-jules[bot]](https://avatars.githubusercontent.com/in/842251?s=64&v=4)](https://github.com/apps/google-labs-jules)

[\+ 50 contributors](https://github.com/outsourc-e/hermes-workspace/graphs/contributors)

## Languages

- [JavaScript75.2%](https://github.com/outsourc-e/hermes-workspace/search?l=javascript)
- [TypeScript24.3%](https://github.com/outsourc-e/hermes-workspace/search?l=typescript)
- [CSS0.2%](https://github.com/outsourc-e/hermes-workspace/search?l=css)
- [Python0.2%](https://github.com/outsourc-e/hermes-workspace/search?l=python)
- [Shell0.1%](https://github.com/outsourc-e/hermes-workspace/search?l=shell)
- [HTML0.0%](https://github.com/outsourc-e/hermes-workspace/search?l=html)

You can’t perform that action at this time.