[Skip to content](https://github.com/xaspx/hermes-control-interface#start-of-content)

You signed in with another tab or window. [Reload](https://github.com/xaspx/hermes-control-interface) to refresh your session.You signed out in another tab or window. [Reload](https://github.com/xaspx/hermes-control-interface) to refresh your session.You switched accounts on another tab or window. [Reload](https://github.com/xaspx/hermes-control-interface) to refresh your session.Dismiss alert

{{ message }}

[xaspx](https://github.com/xaspx)/ **[hermes-control-interface](https://github.com/xaspx/hermes-control-interface)** Public

- [Notifications](https://github.com/login?return_to=%2Fxaspx%2Fhermes-control-interface) You must be signed in to change notification settings
- [Fork\\
96](https://github.com/login?return_to=%2Fxaspx%2Fhermes-control-interface)
- [Star\\
618](https://github.com/login?return_to=%2Fxaspx%2Fhermes-control-interface)


main

[**3** Branches](https://github.com/xaspx/hermes-control-interface/branches) [**25** Tags](https://github.com/xaspx/hermes-control-interface/tags)

[Go to Branches page](https://github.com/xaspx/hermes-control-interface/branches)[Go to Tags page](https://github.com/xaspx/hermes-control-interface/tags)

Go to file

Code

Open more actions menu

## Folders and files

| Name | Name | Last commit message | Last commit date |
| --- | --- | --- | --- |
| ## Latest commit<br>[![xaspx](https://avatars.githubusercontent.com/u/38959282?v=4&size=40)](https://github.com/xaspx)[xaspx](https://github.com/xaspx/hermes-control-interface/commits?author=xaspx)<br>[fix: surface TUI errors, profile switching UX, setup health, PTY resi…](https://github.com/xaspx/hermes-control-interface/commit/b4046e515dbe76e506679b144e085b14a6aafe1d)<br>Open commit details<br>2 days agoMay 7, 2026<br>[b4046e5](https://github.com/xaspx/hermes-control-interface/commit/b4046e515dbe76e506679b144e085b14a6aafe1d) · 2 days agoMay 7, 2026<br>## History<br>[236 Commits](https://github.com/xaspx/hermes-control-interface/commits/main/) <br>Open commit details<br>[View commit history for this file.](https://github.com/xaspx/hermes-control-interface/commits/main/) 236 Commits |
| [.github/ISSUE\_TEMPLATE](https://github.com/xaspx/hermes-control-interface/tree/main/.github/ISSUE_TEMPLATE "This path skips through empty directories") | [.github/ISSUE\_TEMPLATE](https://github.com/xaspx/hermes-control-interface/tree/main/.github/ISSUE_TEMPLATE "This path skips through empty directories") | [v1.5.0: Open source readiness — docs, templates, repo URLs](https://github.com/xaspx/hermes-control-interface/commit/9fcb87349b89073832f39db988d682a6371d796b "v1.5.0: Open source readiness — docs, templates, repo URLs  Open Source: - Add MIT LICENSE file - Add CONTRIBUTING.md with setup guide, code style, commit convention - Add CODE_OF_CONDUCT.md (Contributor Covenant v2.0) - Add GitHub issue templates (bug report, feature request) - Add engines field (node >= 20.0.0) to package.json  Repo URLs: - Replace all placeholder <repo-url> and YOUR_USERNAME with actual repo URL - README.md, CONTRIBUTING.md, docs/DEPLOY.md, docs/INSTALL.md - Repo: https://github.com/xaspx/hermes-control-interface  Other: - bcrypt password hashing + reset-password script - install.sh updates") | last monthApr 9, 2026 |
| [dist](https://github.com/xaspx/hermes-control-interface/tree/main/dist "dist") | [dist](https://github.com/xaspx/hermes-control-interface/tree/main/dist "dist") | [fix: show bridge errors as warnings not fatal errors](https://github.com/xaspx/hermes-control-interface/commit/4be18021950338b6892b3fde4874e09bdcf08691 "fix: show bridge errors as warnings not fatal errors  TUI gateway startup failures ('not ready', 'unavailable') are now shown as amber warnings instead of red errors. The chat recovers via CLI fallback automatically — the user doesn't need to see these as critical failures.") | 3 days agoMay 6, 2026 |
| [docs](https://github.com/xaspx/hermes-control-interface/tree/main/docs "docs") | [docs](https://github.com/xaspx/hermes-control-interface/tree/main/docs "docs") | [fix: surface TUI errors in chat, fix profile switching UX, add setup …](https://github.com/xaspx/hermes-control-interface/commit/d9708d307d6951aeb2707502a95d55fe3791ec4f "fix: surface TUI errors in chat, fix profile switching UX, add setup health card  - Surface TUI stderr/error events as visible warnings/errors in chat UI   instead of hiding them in console.log - Unlock chat UI when WebSocket disconnects mid-stream (was stuck forever) - Fix showChatError to use var(--red) not var(--error) - Don't revert profile selection when user cancels Set as Default modal;   keep selection for session - Persist chat profile selection in localStorage across page navigation - Make agent list items in sidebar clickable to switch profiles - Add /api/setup/check endpoint validating hermes CLI, gateway API,   TUI Python bridge, and hermes config.yaml - Add Setup Health card to Home dashboard with pass/fail indicators") | 3 days agoMay 6, 2026 |
| [lib](https://github.com/xaspx/hermes-control-interface/tree/main/lib "lib") | [lib](https://github.com/xaspx/hermes-control-interface/tree/main/lib "lib") | [fix: add Gateway API fallback chain, fix TUI bridge path for macOS](https://github.com/xaspx/hermes-control-interface/commit/b96a76563e662301a6024837732500ac0060b8d6 "fix: add Gateway API fallback chain, fix TUI bridge path for macOS  - Chat now tries: WebSocket → Gateway API → CLI (was WS → CLI) - Gateway API path (sendViaGatewayAPI) was already implemented but never   wired into the fallback chain — now it's the primary HTTP transport - Fixed TUI bridge default path from hardcoded /root to os.homedir()   so the Python bridge can start on macOS/non-root setups - Users with a healthy Gateway API (like the default profile on :8659)   get fast structured SSE streaming even when WS/TUI is unavailable") | 3 days agoMay 6, 2026 |
| [scripts](https://github.com/xaspx/hermes-control-interface/tree/main/scripts "scripts") | [scripts](https://github.com/xaspx/hermes-control-interface/tree/main/scripts "scripts") | [cleanup: remove outdated files - old website, v3.0.0 security audit, …](https://github.com/xaspx/hermes-control-interface/commit/0319a01e34ce1b7bc7c3a5218bbdbb67f55f98d4 "cleanup: remove outdated files - old website, v3.0.0 security audit, progress tracker, duplicate scripts (#13)  Co-authored-by: root <root@vm1.sg.bayendor>") | 3 weeks agoApr 16, 2026 |
| [src](https://github.com/xaspx/hermes-control-interface/tree/main/src "src") | [src](https://github.com/xaspx/hermes-control-interface/tree/main/src "src") | [fix: show bridge errors as warnings not fatal errors](https://github.com/xaspx/hermes-control-interface/commit/4be18021950338b6892b3fde4874e09bdcf08691 "fix: show bridge errors as warnings not fatal errors  TUI gateway startup failures ('not ready', 'unavailable') are now shown as amber warnings instead of red errors. The chat recovers via CLI fallback automatically — the user doesn't need to see these as critical failures.") | 3 days agoMay 6, 2026 |
| [test](https://github.com/xaspx/hermes-control-interface/tree/main/test "test") | [test](https://github.com/xaspx/hermes-control-interface/tree/main/test "test") | [chore: update deps and fix session-list test expectation](https://github.com/xaspx/hermes-control-interface/commit/df68ac46bd0ec12790d08afc7266eddf4e920b66 "chore: update deps and fix session-list test expectation") | last weekApr 30, 2026 |
| [.env.example](https://github.com/xaspx/hermes-control-interface/blob/main/.env.example ".env.example") | [.env.example](https://github.com/xaspx/hermes-control-interface/blob/main/.env.example ".env.example") | [docs: add GATEWAY\_API\_KEY and HCI\_CORS\_ORIGINS to .env.example](https://github.com/xaspx/hermes-control-interface/commit/88b569619ba0148bbdabcd8db5f528c17fccb72d "docs: add GATEWAY_API_KEY and HCI_CORS_ORIGINS to .env.example  Fresh installs need to know these optional env vars exist. Both have sensible defaults (config.yaml + auto-detect) so they're documented but commented out by default.") | 3 weeks agoApr 18, 2026 |
| [.gitignore](https://github.com/xaspx/hermes-control-interface/blob/main/.gitignore ".gitignore") | [.gitignore](https://github.com/xaspx/hermes-control-interface/blob/main/.gitignore ".gitignore") | [Release v3.5.0: dead code removal, XSS fixes, chat UX polish (](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") [#42](https://github.com/xaspx/hermes-control-interface/pull/42) [)](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") | 2 weeks agoApr 27, 2026 |\
| [CODE\_OF\_CONDUCT.md](https://github.com/xaspx/hermes-control-interface/blob/main/CODE_OF_CONDUCT.md "CODE_OF_CONDUCT.md") | [CODE\_OF\_CONDUCT.md](https://github.com/xaspx/hermes-control-interface/blob/main/CODE_OF_CONDUCT.md "CODE_OF_CONDUCT.md") | [v1.5.0: Open source readiness — docs, templates, repo URLs](https://github.com/xaspx/hermes-control-interface/commit/9fcb87349b89073832f39db988d682a6371d796b "v1.5.0: Open source readiness — docs, templates, repo URLs  Open Source: - Add MIT LICENSE file - Add CONTRIBUTING.md with setup guide, code style, commit convention - Add CODE_OF_CONDUCT.md (Contributor Covenant v2.0) - Add GitHub issue templates (bug report, feature request) - Add engines field (node >= 20.0.0) to package.json  Repo URLs: - Replace all placeholder <repo-url> and YOUR_USERNAME with actual repo URL - README.md, CONTRIBUTING.md, docs/DEPLOY.md, docs/INSTALL.md - Repo: https://github.com/xaspx/hermes-control-interface  Other: - bcrypt password hashing + reset-password script - install.sh updates") | last monthApr 9, 2026 |\
| [CONTRIBUTING.md](https://github.com/xaspx/hermes-control-interface/blob/main/CONTRIBUTING.md "CONTRIBUTING.md") | [CONTRIBUTING.md](https://github.com/xaspx/hermes-control-interface/blob/main/CONTRIBUTING.md "CONTRIBUTING.md") | [v1.5.0: Open source readiness — docs, templates, repo URLs](https://github.com/xaspx/hermes-control-interface/commit/9fcb87349b89073832f39db988d682a6371d796b "v1.5.0: Open source readiness — docs, templates, repo URLs  Open Source: - Add MIT LICENSE file - Add CONTRIBUTING.md with setup guide, code style, commit convention - Add CODE_OF_CONDUCT.md (Contributor Covenant v2.0) - Add GitHub issue templates (bug report, feature request) - Add engines field (node >= 20.0.0) to package.json  Repo URLs: - Replace all placeholder <repo-url> and YOUR_USERNAME with actual repo URL - README.md, CONTRIBUTING.md, docs/DEPLOY.md, docs/INSTALL.md - Repo: https://github.com/xaspx/hermes-control-interface  Other: - bcrypt password hashing + reset-password script - install.sh updates") | last monthApr 9, 2026 |\
| [LICENSE](https://github.com/xaspx/hermes-control-interface/blob/main/LICENSE "LICENSE") | [LICENSE](https://github.com/xaspx/hermes-control-interface/blob/main/LICENSE "LICENSE") | [feat: open-source Hermes Control Interface](https://github.com/xaspx/hermes-control-interface/commit/c0d32f80172f9d7c56ebeb26e774dde7fc3ad4ab "feat: open-source Hermes Control Interface") | last monthApr 8, 2026 |\
| [README.md](https://github.com/xaspx/hermes-control-interface/blob/main/README.md "README.md") | [README.md](https://github.com/xaspx/hermes-control-interface/blob/main/README.md "README.md") | [Release v3.5.0: dead code removal, XSS fixes, chat UX polish (](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") [#42](https://github.com/xaspx/hermes-control-interface/pull/42) [)](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") | 2 weeks agoApr 27, 2026 |\
| [SECURITY\_AUDIT.md](https://github.com/xaspx/hermes-control-interface/blob/main/SECURITY_AUDIT.md "SECURITY_AUDIT.md") | [SECURITY\_AUDIT.md](https://github.com/xaspx/hermes-control-interface/blob/main/SECURITY_AUDIT.md "SECURITY_AUDIT.md") | [Release v3.5.0: dead code removal, XSS fixes, chat UX polish (](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") [#42](https://github.com/xaspx/hermes-control-interface/pull/42) [)](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") | 2 weeks agoApr 27, 2026 |\
| [auth.js](https://github.com/xaspx/hermes-control-interface/blob/main/auth.js "auth.js") | [auth.js](https://github.com/xaspx/hermes-control-interface/blob/main/auth.js "auth.js") | [fix(users): 6 fixes - auto-refresh after create, add updateUserPermis…](https://github.com/xaspx/hermes-control-interface/commit/ad148b0248af4b6ab533e549e7555873d2bc581b "fix(users): 6 fixes - auto-refresh after create, add updateUserPermissions to auth.js, confirm password for reset, grouped permissions in create modal, color-coded audit log, remove duplicate audit panel from maintenance") | 3 weeks agoApr 17, 2026 |\
| [hci.config.yaml.example](https://github.com/xaspx/hermes-control-interface/blob/main/hci.config.yaml.example "hci.config.yaml.example") | [hci.config.yaml.example](https://github.com/xaspx/hermes-control-interface/blob/main/hci.config.yaml.example "hci.config.yaml.example") | [Release v3.5.0: dead code removal, XSS fixes, chat UX polish (](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") [#42](https://github.com/xaspx/hermes-control-interface/pull/42) [)](https://github.com/xaspx/hermes-control-interface/commit/363aa568680684a2689404c22b8796836c7bb558 "Release v3.5.0: dead code removal, XSS fixes, chat UX polish (#42)  * feat(ws): Gateway API streaming foundation  - Add WebSocket client (ws-client.js) with reconnect, ping/pong - Add WS bridge in server.js for /v1/responses proxy - Add thinking panel, tool progress handlers in main.js - Rewrite renderChatContent() with proper markdown + code blocks - Add chat.css thinking panel styles  This is a checkpoint before TUI integration revamp.  * feat(tui): TUI Gateway Bridge backend  - Add lib/tui-gateway-bridge.js: spawn python -m tui_gateway.entry - JSON-RPC over stdin/stdout with request/response tracking - Event transformation: TUI events → HCI WS events - Interactive support: clarify, approval, sudo, secret - Per-profile bridge isolation - Graceful shutdown cleanup  * feat(tui): Frontend event router + interactive modals  - Rewrite setupWsChatHandlers() for TUI event types - Add individual handlers: thinking, text, tool, status, subagent - Add modal handlers: clarify, approval, sudo, secret - Update ws-client.js with clarifyRespond, approvalRespond, etc.  * feat(ui): Bubble chat revamp + status bar + subagent panel  - Add OpenWebUI-style rounded bubble tails - Add chat-status-bar with agent-status-indicator - Add subagent-panel styles for sidebar - Add streaming pulse glow animation - Responsive bubble sizing  * feat(ui): Sidebar + status bar redesign  - Add subagent-panel to sidebar (auto show/hide) - Update status bar with left/right layout + agent-status-indicator - Update subagent handler to toggle panel visibility  * feat(ui): Polish — status indicator reset, subagent panel cleanup  - Reset agent-status-indicator to idle on chat complete - Auto-hide subagent panel after 6s delay - Smooth finalize transitions  * fix(tui): await bridge.start() before chatStart  - Bridge.start() now returns Promise that resolves on gateway.ready - Rejects on spawn error, exit, or startup timeout - Server awaits bridge.start() before adding client + calling chatStart - Fixes 'TUI gateway not ready' race condition  * fix(tui): use prompt.submit instead of session.sendPrompt  - TUI backend has prompt.submit, not session.sendPrompt - Params: { session_id, text }  * feat(chat): TUI revamp Phase 2 — session fix, queue, shortcuts, animations, lazy load  - Fix session fragmentation: bridge now tracks canonical DB session_key   instead of internal TUI sid, enabling proper session resume across chats - Fix reply merge bug: finalizeWsChat now always removes streaming element - Message queue: user can type while agent is busy, auto-dequeue on done - Keyboard shortcuts: Ctrl+Enter send, Esc stop/close modal, Ctrl+N new chat,   Ctrl+K focus search, Ctrl+[ toggle sidebar, Ctrl+/ show help - Session pin + draft: pinned sessions sorted to top, draft auto-save/restore   per session via localStorage - Animations: bubble fade-in, thinking pulse, tool slide-in, cursor blink - Virtual scroll: lazy-load older messages with 'Load older' button - TUI crash fallback: bridge auto-restart up to 3x before error  * fix(chat): revert reloadCurrentSessionMessages to simple refresh  reloadCurrentSessionMessages was incorrectly patched with lazy-load offset logic meant for loadChatSession only. This caused ReferenceError: offset is not defined when the stream finalized and tried to reload messages from DB.  - restore reloadCurrentSessionMessages to full refresh (no offset) - keep lazy-load logic only in loadChatSession  * fix(chat): undefined offset in toggleSessionDetail  toggleSessionDetail referenced 'offset' which was never defined in that scope, causing ReferenceError when expanding session details in the sessions view.  - hardcode offset=0 for session detail initial fetch  * fix(chat): result bubble missing after thinking + default profile reset  1. finalizeWsChat: convert streaming element to static message BEFORE    reloading from DB. This prevents the result bubble from disappearing    when the DB reload races ahead of the save (the assistant response    hadn't been persisted yet).  2. newChatSession: reset profile dropdown to the active/default profile    so new chats don't accidentally inherit the previous session's agent.    Store defaultProfile in state._defaultProfile during loadChat().  * security: fix #31-39 — input validation, shell→execHermes, path traversal, CSRF  - #31: Add regex validation /^[\w.\-]+$/ to /api/skills/install - #33: Replace string-based path traversal check with path.resolve() + startsWith('/tmp/') - #34: Add requireCsrf to logout, notifications, skills/check endpoints - #38: Convert 6 endpoints from shell() to execHermes() (skills/list, browse, check, profiles/use, insights, sessions/export) - #39: Add cron prompt (max 10k chars) and name (regex + max 128) validation - #32: Verified sanitizeProfileName() already blocks path traversal - #36: Verified escapeHtml() already covers all 5 special chars - #37: Verified session rename already uses execHermes + sanitizeTitle  * chat: phase 2 — tool call lifecycle + artifact rendering (v3.5.1)  - lib/sse-events.js: SSE event normalizer for gateway events - Live tool count: 🔨 N tools running indicator in chat header - Truncation: 500 → 4000 chars + click-to-expand Show more button - Both WS (chat.tool.*) and SSE (response.*) paths updated - Artifact rendering: handleArtifact() + CSS cards for code/text/image - artifact.created + artifact.chunk SSE events wired - subagent.completed SSE event wired  * fix: ws-conn-indicator race condition + duplicate function removal (v3.5.1-hotfix)  * feat: session restore + gateway badge + fork (v3.5.2)  * feat: config-driven architecture + system monitoring page (v3.6.0)  - NEW lib/hci-config.js: config loading from hci.config.yaml + env overrides - NEW hci.config.yaml.example: documented schema for open-source deployers - NEW /mon page: real-time CPU, RAM, Disk, Load, Network, Node.js memory, uptime - NEW /api/monitoring: system metrics endpoint (auth-protected) - NEW MON nav link between HOME and AGENTS - Auto-detect mode: Gateway API (fast) vs CLI fallback — already worked - docs/CONFIG.md: full hci.config.yaml schema reference - docs/DEPLOY.md: HCI_* env var documentation - .gitignore: hci.config.yaml added  * fix: session history, file viewer, insertBefore crash, streaming cleanup  Bug fixes: - File API (Bug #1): readFileSafe/writeFileSafe now use HERMES_HOME   (process.env.HERMES_HOME || cfg.hermesHome) instead of CONTROL_HOME.   Config hci.config.yaml corrected to ~/.hermes (was /tmp/hermes_test). - Sessions DB (Bug #3): getStateDbPath('default') now returns correct   ~/.hermes/state.db. /api/sessions/:id/messages uses same fix. - insertBefore crash (Bug #2): addToolCallCard guards with contains()   check before insertBefore to prevent DOMException. - Loading persist (Bug #5): finalizeWsChat now removes streaming   element and orphaned tool cards before reload. - File explorer: now correctly lists ~/.hermes files.  * fix: prevent insertBefore crash and stale message reload  Root causes fixed: - insertBefore crash: tool card WS events arriving AFTER finalizeWsChat   removed the streaming element → contentDiv orphaned → cursor not in   contentDiv → DOMException. Fix: add document.contains() guards   throughout the WS tool lifecycle (handleToolStart, handleToolDone,   handleToolProgress, updateStreamContent, addToolCallCard).  - Messages disappear: reloadCurrentSessionMessages() running while a new   stream is already active, overwriting new session's view with old   session data. Fix: stale guard — capture expectedSession before   fetch, discard response if currentSessionId changed mid-flight.  All WS tool handlers now guard with document.contains() to handle the case where finalizeWsChat has already removed the streaming element before late-arriving WS events.  * fix: insertBefore race in ensureThinkingPanel + list rendering HTML escaping  * fix: handleTextDelta re-query guard + TUI terminal/resume commands  * fix: capture streaming text before DB reload + profile switcher modal  * fix: correct showModal button values for profile switcher modal  * fix: profile switcher modal return + double-call race guards  * fix: profile selector sync on set-default + chat agent info panel (Bug #3)  * fix: sidebar agent panel always visible, remove collapsible panel, fix toggle not defined  * chore: remove dead code (D1+D2) and fix XSS in error handlers (S1)  D1: Remove unused getProjects() function D2: Remove unused formatBytes() function S1: Escape all e.message/err.message in innerHTML (15 locations)     - Error pages: loadPage, loadHomePage, loadAgentsPage, loadAgentDetailPage     - Sessions, logs, config, usage, users, audit, files pages     - Subagent payload.status escaped in WS handler     - Terminal error display escaped  Security: defense-in-depth for admin-only internal tool  * docs: update all documentation for v3.5.0  README.md: - Version bump 3.4.0 → 3.5.0 - RBAC: 28 perms/12 groups → 20 perms/3 roles - Security: comprehensive XSS protection note, score 7.0→7.5 - XSS in error handlers (15+ locations) added to security audit section - New v3.5.0 changelog entry: dead code removal (D1+D2), XSS audit S1, session sort, profile selector sync, race guards, showModal fix  API.md: - /api/login → /api/auth/login - /api/logout → /api/auth/logout - /api/session → /api/auth/status - Remove non-existent /api/dashboard-state  SECURITY.md: - Fix password comparison: plaintext → bcrypt (cost factor 10) - Fix auth tokens: HMAC tokens → session cookies - RBAC: 28 → 20 permissions - Add XSS audit completed note (2026-04-27)  SECURITY_AUDIT.md: - Add v3.5.0 S1 XSS audit summary (15+ error handlers fixed) - Mark finding #10 (escapeHtml quote escaping) as resolved v3.4.0 - Update Recommended Priority Fixes: all CRITICAL/HIGH done, backlog items clarified  * chore: bump version to v3.5.0") | 2 weeks agoApr 27, 2026 |\
| [package-lock.json](https://github.com/xaspx/hermes-control-interface/blob/main/package-lock.json "package-lock.json") | [package-lock.json](https://github.com/xaspx/hermes-control-interface/blob/main/package-lock.json "package-lock.json") | [fix: surface TUI errors in chat, fix profile switching UX, add setup …](https://github.com/xaspx/hermes-control-interface/commit/d9708d307d6951aeb2707502a95d55fe3791ec4f "fix: surface TUI errors in chat, fix profile switching UX, add setup health card  - Surface TUI stderr/error events as visible warnings/errors in chat UI   instead of hiding them in console.log - Unlock chat UI when WebSocket disconnects mid-stream (was stuck forever) - Fix showChatError to use var(--red) not var(--error) - Don't revert profile selection when user cancels Set as Default modal;   keep selection for session - Persist chat profile selection in localStorage across page navigation - Make agent list items in sidebar clickable to switch profiles - Add /api/setup/check endpoint validating hermes CLI, gateway API,   TUI Python bridge, and hermes config.yaml - Add Setup Health card to Home dashboard with pass/fail indicators") | 3 days agoMay 6, 2026 |\
| [package.json](https://github.com/xaspx/hermes-control-interface/blob/main/package.json "package.json") | [package.json](https://github.com/xaspx/hermes-control-interface/blob/main/package.json "package.json") | [chore: bump version to 3.5.1](https://github.com/xaspx/hermes-control-interface/commit/cc1e9a5e6fdb6ea408c9135bc0eb15e2c65971ae "chore: bump version to 3.5.1") | 5 days agoMay 3, 2026 |\
| [server.js](https://github.com/xaspx/hermes-control-interface/blob/main/server.js "server.js") | [server.js](https://github.com/xaspx/hermes-control-interface/blob/main/server.js "server.js") | [fix: make WS connection resilient to PTY spawn failures](https://github.com/xaspx/hermes-control-interface/commit/2254cdbc0aa0208558132841ded605ba4979ef72 "fix: make WS connection resilient to PTY spawn failures  - Wrap pty.spawn in try/catch so ensureTerminalSession returns a   degraded session instead of crashing when node-pty can't spawn bash - Degraded terminal has ready=false, no proc, no crash — WebSocket   connections continue working for chat, dashboard, etc. - Terminal panel shows 'PTY unavailable' status instead of killing   the entire WS connection on macOS arm64 posix_spawnp failures") | 3 days agoMay 6, 2026 |\
| [vite.config.js](https://github.com/xaspx/hermes-control-interface/blob/main/vite.config.js "vite.config.js") | [vite.config.js](https://github.com/xaspx/hermes-control-interface/blob/main/vite.config.js "vite.config.js") | [fix: cherry-pick cross-platform fixes from PR](https://github.com/xaspx/hermes-control-interface/commit/50ebfc4188f9a8eee2b2e54a2585121ac398c0bb "fix: cherry-pick cross-platform fixes from PR #43  - shell(): replace 'timeout' prefix with Node.js native timeout (macOS compat) - shell(): return stdout OR stderr, not just stdout on error - Add parseShellTimeout() — supports '8s', '500ms', '2m' formats - /api/system/health: use os module for CPU/RAM (no top/free dependency) - /api/monitoring: same cross-platform fix for CPU/RAM/load - vite.config.js: configurable backend URL via HCI_BACKEND_URL env var  Skipped from PR #43: docs updates (auth flow mismatch), HERMES_CONTROL_PASSWORD removal") [#43](https://github.com/xaspx/hermes-control-interface/pull/43) | 5 days agoMay 3, 2026 |\
| View all files |\
\
## Repository files navigation\
\
# Hermes Control Interface\
\
[Permalink: Hermes Control Interface](https://github.com/xaspx/hermes-control-interface#hermes-control-interface)\
\
A self-hosted web dashboard for the [Hermes AI agent](https://github.com/NousResearch/hermes-agent) stack. Manage terminals, files, sessions, cron jobs, token analytics, multi-agent gateways, and team access — all behind a password gate.\
\
**Stack:** Vanilla JS + Vite · Node.js · Express · WebSocket · xterm.js\
**Version:** 3.5.0\
\
* * *\
\
## Highlights\
\
[Permalink: Highlights](https://github.com/xaspx/hermes-control-interface#highlights)\
\
> **Chat via Gateway API** — Real-time streaming, tool call cards with JSON viewer, session resume, stop button, multi-profile support. Auto-fallback to CLI.\
\
> **RBAC v2** — 20 permissions across 3 roles. Admin, viewer, or custom roles per user.\
\
> **Multi-Agent Gateway** — Start/stop/configure multiple Hermes profiles. Real-time logs. Systemd service management.\
\
> **Token Analytics** — Track sessions, messages, tokens, cost by model, platform, and time range.\
\
> **Security Hardened** — Command injection fixes, CSRF on 21 endpoints, dynamic CORS, comprehensive XSS protection (escapeHtml on all error handlers), 18 findings addressed.\
\
* * *\
\
## Screenshots\
\
[Permalink: Screenshots](https://github.com/xaspx/hermes-control-interface#screenshots)\
\
### Navigation — 8 Pages\
\
[Permalink: Navigation — 8 Pages](https://github.com/xaspx/hermes-control-interface#navigation--8-pages)\
\
**Home · Agents · Usage · Skills · Chat · Logs · Maintenance · Files**\
\
### Dark Mode\
\
[Permalink: Dark Mode](https://github.com/xaspx/hermes-control-interface#dark-mode)\
\
| Home | Agents |\
| --- | --- |\
| [![Home](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/01-home.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/01-home.png) | [![Agents](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/02-agents.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/02-agents.png) |\
\
| Chat | Usage & Analytics |\
| --- | --- |\
| [![Chat](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/chat.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/chat.png) | [![Usage](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/03-usage.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/03-usage.png) |\
\
| Skills Hub | Maintenance |\
| --- | --- |\
| [![Skills](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/04-skills.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/04-skills.png) | [![Maintenance](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/05-maintenance.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/05-maintenance.png) |\
\
| File Explorer | Agent Dashboard |\
| --- | --- |\
| [![Files](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/06-files.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/06-files.png) | [![Dashboard](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/07-agent-dashboard.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/07-agent-dashboard.png) |\
\
| Agent Gateway | Agent Sessions |\
| --- | --- |\
| [![Gateway](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/09-agent-gateway.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/09-agent-gateway.png) | [![Sessions](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/08-agent-sessions.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/08-agent-sessions.png) |\
\
| Agent Config | Agent Memory |\
| --- | --- |\
| [![Config](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/10-agent-config.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/10-agent-config.png) | [![Memory](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/11-agent-memory.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/11-agent-memory.png) |\
\
| Agent Skills | Agent Cron |\
| --- | --- |\
| [![Skills](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/12-agent-skills.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/12-agent-skills.png) | [![Cron](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/dark/13-agent-cron.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/dark/13-agent-cron.png) |\
\
### Light Mode\
\
[Permalink: Light Mode](https://github.com/xaspx/hermes-control-interface#light-mode)\
\
| Home | Agents | Skills Hub |\
| --- | --- | --- |\
| [![Home](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/light/01-home.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/light/01-home.png) | [![Agents](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/light/02-agents.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/light/02-agents.png) | [![Skills](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/light/04-skills.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/light/04-skills.png) |\
\
| Gateway | Memory |\
| --- | --- |\
| [![Gateway](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/light/09-agent-gateway.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/light/09-agent-gateway.png) | [![Memory](https://github.com/xaspx/hermes-control-interface/raw/main/docs/screenshots/light/11-agent-memory.png)](https://github.com/xaspx/hermes-control-interface/blob/main/docs/screenshots/light/11-agent-memory.png) |\
\
* * *\
\
## Features\
\
[Permalink: Features](https://github.com/xaspx/hermes-control-interface#features)\
\
### 🔐 Authentication\
\
[Permalink: 🔐 Authentication](https://github.com/xaspx/hermes-control-interface#-authentication)\
\
- Single password login (configurable via `HERMES_CONTROL_PASSWORD`)\
- bcrypt password hashing (cost factor 10)\
- CSRF tokens on all mutating requests\
- Conditional Secure cookie flag (auto-detects HTTPS)\
- Rate limiting: 5 failed logins per 15 minutes per IP\
- Multi-user support with role-based access control (RBAC)\
\
* * *\
\
### 🏠 Home Dashboard\
\
[Permalink: 🏠 Home Dashboard](https://github.com/xaspx/hermes-control-interface#-home-dashboard)\
\
System overview at a glance:\
\
- **System Health**: CPU usage, RAM usage, Disk usage, Uptime\
- **Agent Overview**: active model, provider, gateway status, configured API keys, active platforms\
- **Gateway Status**: per-profile running/stopped indicators\
- **Token Usage (7d)**: sessions count, messages, total tokens, estimated cost, models used, platforms breakdown, top tools\
\
* * *\
\
### 🤖 Agents — Multi-Agent Management\
\
[Permalink: 🤖 Agents — Multi-Agent Management](https://github.com/xaspx/hermes-control-interface#-agents--multi-agent-management)\
\
Manage all Hermes profiles from one place:\
\
- List all profiles with status badge (running/stopped) and active model\
- Create new profile\
- Clone existing profile\
- Delete profile\
- Set default profile\
- Start/Stop/Restart gateway per profile\
- Quick gateway log viewer\
\
* * *\
\
### 💬 Chat — Revamped Interface\
\
[Permalink: 💬 Chat — Revamped Interface](https://github.com/xaspx/hermes-control-interface#-chat--revamped-interface)\
\
The chat interface got a full overhaul in v3.3.0:\
\
**Tool Call Cards**\
\
- Each tool call displayed as a collapsible card\
- Shows tool name, status (running/success/error), and execution time\
- Expand to see full JSON input/output\
- Collapsed by default for clean output\
\
**Session Sidebar**\
\
- List of past chat sessions with timestamps\
- Resume any session with one click\
- New chat button for fresh session\
- Shows active model tag\
\
**Clean Output**\
\
- Banner suppression (`-Q` flag) for noise-free responses\
- Auto-detects both new (`session_id:`) and legacy (`Session:`) session ID formats\
- `--continue ""` (empty) creates new session\
- Bare `--continue` resumes last session\
\
**Session Management**\
\
- Rename sessions\
- Delete sessions\
- Export session transcript\
\
* * *\
\
### 📊 Usage & Analytics — Token Insights\
\
[Permalink: 📊 Usage & Analytics — Token Insights](https://github.com/xaspx/hermes-control-interface#-usage--analytics--token-insights)\
\
Full breakdown of LLM usage:\
\
- **Time Range**: Today, 7d, 30d, 90d filters\
- **Agent Filter**: per-profile or all combined\
- **Overview Cards**: total sessions, messages, tokens, cost, active hours\
- **Models Table**: per-model breakdown — sessions count, total tokens, avg tokens/session\
- **Platforms Table**: per-platform breakdown (CLI, Telegram, WhatsApp, etc.)\
- **Top Tools**: most called tools with call counts and success rates\
\
* * *\
\
### 🛠️ Agent Detail — Per-Agent Management\
\
[Permalink: 🛠️ Agent Detail — Per-Agent Management](https://github.com/xaspx/hermes-control-interface#%EF%B8%8F-agent-detail--per-agent-management)\
\
Six-tab interface for deep agent configuration:\
\
#### Dashboard Tab\
\
[Permalink: Dashboard Tab](https://github.com/xaspx/hermes-control-interface#dashboard-tab)\
\
- Agent identity: name, model, provider\
- Gateway service status\
- Quick token usage summary\
- Active platforms\
\
#### Sessions Tab\
\
[Permalink: Sessions Tab](https://github.com/xaspx/hermes-control-interface#sessions-tab)\
\
- List all sessions for this profile\
- Search by keyword\
- Rename session\
- Delete session\
- Export session (JSON format)\
- Resume session in CLI (one click)\
\
#### Gateway Tab\
\
[Permalink: Gateway Tab](https://github.com/xaspx/hermes-control-interface#gateway-tab)\
\
- Start/Stop/Restart gateway service\
- Real-time log stream (WebSocket)\
- Systemd service management (for non-root users: `hermes-gateway-<profile>`)\
- Gateway configuration panel\
\
#### Config Tab\
\
[Permalink: Config Tab](https://github.com/xaspx/hermes-control-interface#config-tab)\
\
- 13 categories, 80+ settings\
- Structured form editor with labeled fields\
- Raw YAML editor toggle\
- Reset to defaults per category\
- Apply changes with validation\
\
#### Memory Tab\
\
[Permalink: Memory Tab](https://github.com/xaspx/hermes-control-interface#memory-tab)\
\
- Dynamic memory provider panel\
- Provider options: Built-in MEMORY.md, Honcho (self-hosted), External providers\
- Honcho status: connected/disconnected\
- Memory usage stats\
\
#### Cron Tab\
\
[Permalink: Cron Tab](https://github.com/xaspx/hermes-control-interface#cron-tab)\
\
- List all scheduled jobs for this profile\
- Create new cron job with schedule presets (hourly, daily, weekly, custom cron expression)\
- Pause/Resume scheduled jobs\
- Run job immediately (on-demand)\
- Edit/Delete cron jobs\
- Next run time display\
\
* * *\
\
### 📦 Skills Marketplace\
\
[Permalink: 📦 Skills Marketplace](https://github.com/xaspx/hermes-control-interface#-skills-marketplace)\
\
Browse and manage installed Hermes skills:\
\
- Grouped by category (devops, mlops, creative, etc.)\
- Shows skill name, description snippet, source (builtin/local), trust level\
- Search and filter skills\
- Install new skills from the Hermes skills registry\
- Check for updates\
- Uninstall skills\
\
* * *\
\
### 🔧 Maintenance — System Administration\
\
[Permalink: 🔧 Maintenance — System Administration](https://github.com/xaspx/hermes-control-interface#-maintenance--system-administration)\
\
Full admin panel:\
\
- **Doctor**: Run diagnostics — detects common issues, auto-fix where possible\
- **Dump**: Generate debug summary (system info, config, recent logs)\
- **Update**: Update Hermes agent to latest version\
- **Backup**: Download all Hermes data as a zip file\
- **Import**: Restore from backup zip\
- **HCI Restart**: Restart the Control Interface web server from UI (no SSH needed)\
- **Users** (NEW in v3.3.0): Create/edit/delete users, assign roles, manage permissions\
- **Auth**: View provider status (OpenRouter, Nous Portal, etc.), add/remove API keys\
- **Audit**: Timestampped activity log — who did what and when\
\
* * *\
\
### 📁 File Explorer\
\
[Permalink: 📁 File Explorer](https://github.com/xaspx/hermes-control-interface#-file-explorer)\
\
Split-view file editor:\
\
- **Left panel**: Directory tree browser\
- **Right panel**: Text editor with syntax highlighting\
- **Save**: Write changes back to disk\
- **Secure**: Paths scoped to `~/.hermes`, traversal attacks prevented\
- **Multiple roots**: Configurable via `HERMES_CONTROL_ROOTS`\
\
* * *\
\
### 💻 Terminal\
\
[Permalink: 💻 Terminal](https://github.com/xaspx/hermes-control-interface#-terminal)\
\
Real browser-based terminal:\
\
- Full PTY via node-pty + xterm.js over WebSocket\
- Touch-friendly controls (↑↓␣↵) for mobile\
- Fullscreen toggle\
- Auto-cleanup flow: Ctrl+C → clear → ready for next command\
- Rate limited: 30 commands/minute per IP\
\
* * *\
\
### 🔔 Notifications\
\
[Permalink: 🔔 Notifications](https://github.com/xaspx/hermes-control-interface#-notifications)\
\
- Bell icon with unread count badge (top-right)\
- Dropdown panel with notification list\
- Dismiss individual or clear all\
- Sources: system alerts (disk/RAM/CPU), gateway events, session CRUD, user management\
- Persistent: stored in `~/.hermes/hci-notifications.json`\
\
* * *\
\
### 🎨 Theme\
\
[Permalink: 🎨 Theme](https://github.com/xaspx/hermes-control-interface#-theme)\
\
- **Dark mode** (default): `#0b201f` background, `#dccbb5` foreground, `#7c945c` accent\
- **Light mode**: `#e4ebdf` background, `#0b201f` foreground, `#2e6fb0` accent\
- Toggle via header button\
- Preference persisted in localStorage\
- Login page: themed background image with overlay\
\
* * *\
\
### 🔒 Security\
\
[Permalink: 🔒 Security](https://github.com/xaspx/hermes-control-interface#-security)\
\
- **Multi-user RBAC**: 20 permissions across 3 roles\
- **Roles**: `admin` (full access), `viewer` (read-only), `custom` (your choice)\
- **bcrypt** password hashing (cost factor 10)\
- **CSRF tokens** on all mutating requests\
- **Secure cookie** flag (auto-detects HTTPS)\
- **WebSocket origin** verification (exact match)\
- **Input sanitization**: strict regex on all user inputs (profiles, sessions, titles, filenames)\
- **Path traversal prevention** in file explorer\
- **Rate limiting**: login (5 failed/15min), terminal exec (30/min)\
- **XSS protection**: all dynamic values escaped via escapeHtml() — code blocks extracted before render, error messages sanitized in all 15+ catch blocks\
- **Admin gate**: critical endpoints (`/api/plugins`, etc.) require admin role\
- **Token cleanup**: automatic session token cleanup every 15 minutes\
- **Unhandled exception handlers**: `unhandledRejection` \+ `uncaughtException` caught and logged\
\
See full security audit: [docs/SECURITY\_AUDIT.md](https://github.com/xaspx/hermes-control-interface/blob/main/docs/SECURITY_AUDIT.md)\
\
* * *\
\
## Where HCI Can Be Installed\
\
[Permalink: Where HCI Can Be Installed](https://github.com/xaspx/hermes-control-interface#where-hci-can-be-installed)\
\
HCI runs as a single Node.js process — any server environment that supports Node.js works.\
\
| Environment | Status | Notes |\
| --- | --- | --- |\
| Local Linux server | ✅ | Full support |\
| VPS (DigitalOcean, Hetzner, AWS EC2, Linode, etc.) | ✅ | Recommended for production |\
| macOS | ✅ | Works |\
| WSL2 (Windows Subsystem for Linux) | ✅ | Full support |\
| Raspberry Pi (arm64) | ✅ | Works |\
| Docker / Podman | ⚠️ | Works but not officially supported |\
| Shared hosting | ❌ | Requires Node.js + WebSocket + PTY support |\
| Browser-only (no server) | ❌ | Requires Node.js backend |\
\
* * *\
\
## Requirements\
\
[Permalink: Requirements](https://github.com/xaspx/hermes-control-interface#requirements)\
\
| Requirement | Minimum | Recommended |\
| --- | --- | --- |\
| Node.js | v18+ | v20 LTS |\
| RAM | 512 MB | 1 GB+ |\
| Disk | 200 MB | 500 MB+ |\
| OS | Linux / macOS / WSL2 | Ubuntu 22.04 LTS |\
| Hermes Agent | v0.3.x | Latest |\
| Build tools | python3, make, g++ | For node-pty native module |\
\
**Dependencies** (installed via `npm install`):\
\
- `express` — HTTP server\
- `ws` — WebSocket\
- `node-pty` — PTY support (requires build tools)\
- `xterm.js` — Terminal emulator in browser\
- `bcrypt` — Password hashing\
- `cookie-parser`, `dotenv`, `js-yaml`, etc.\
\
* * *\
\
## Installation Methods\
\
[Permalink: Installation Methods](https://github.com/xaspx/hermes-control-interface#installation-methods)\
\
### Manual (Recommended)\
\
[Permalink: Manual (Recommended)](https://github.com/xaspx/hermes-control-interface#manual-recommended)\
\
```\
# 1. Clone\
git clone https://github.com/xaspx/hermes-control-interface.git\
cd hermes-control-interface\
\
# 2. Install dependencies\
npm install\
\
# 3. Configure\
cp .env.example .env\
# Edit .env and set:\
#   HERMES_CONTROL_PASSWORD=your-secure-password\
#   HERMES_CONTROL_SECRET=$(openssl rand -hex 32)\
\
# 4. Build frontend\
npm run build\
\
# 5. Start\
npm start\
```\
\
Access at `http://localhost:10272` (default PORT).\
\
### Systemd Service (Production)\
\
[Permalink: Systemd Service (Production)](https://github.com/xaspx/hermes-control-interface#systemd-service-production)\
\
```\
# Use the provided gateway service script as reference\
bash scripts/setup-gateway-service.sh\
```\
\
Or create a simple systemd unit:\
\
```\
# /etc/systemd/system/hermes-control.service\
[Unit]\
Description=Hermes Control Interface\
After=network.target\
\
[Service]\
Type=simple\
User=root\
WorkingDirectory=/path/to/hermes-control-interface\
ExecStart=/usr/bin/node server.js\
Restart=always\
\
[Install]\
WantedBy=multi-user.target\
```\
\
```\
sudo systemctl enable hermes-control\
sudo systemctl start hermes-control\
```\
\
* * *\
\
## Environment Variables\
\
[Permalink: Environment Variables](https://github.com/xaspx/hermes-control-interface#environment-variables)\
\
| Variable | Required | Description |\
| --- | --- | --- |\
| `HERMES_CONTROL_PASSWORD` | Yes | Login password |\
| `HERMES_CONTROL_SECRET` | Yes | CSRF + internal auth secret |\
| `PORT` | No | Server port (default: 10272) |\
| `HERMES_CONTROL_HOME` | No | Hermes home dir (default: ~/.hermes) |\
| `HERMES_CONTROL_ROOTS` | No | File explorer roots (JSON array) |\
| `HERMES_PROJECTS_ROOT` | No | Projects directory |\
\
* * *\
\
## Reset Password Without Dashboard Access\
\
[Permalink: Reset Password Without Dashboard Access](https://github.com/xaspx/hermes-control-interface#reset-password-without-dashboard-access)\
\
If you can't log in to the dashboard, reset the password via CLI:\
\
**Option 1 — Edit .env directly**\
\
```\
# SSH into your server\
nano ~/.hermes/.env\
# Change HERMES_CONTROL_PASSWORD=your-new-password\
\
# Restart\
sudo systemctl restart hermes-control\
# or: pkill node; npm start &\
```\
\
**Option 2 — Generate bcrypt hash via Node.js**\
\
```\
node -e "const bcrypt=require('bcrypt'); bcrypt.hash(require('crypto').randomBytes(24).toString('hex'), 10).then(h=>console.log('HERMES_CONTROL_PASSWORD='+h))"\
# Copy the output to .env, then restart\
```\
\
**Key point:**`.env` is the source of truth. Dashboard access = server access. If you lose access to both, you must have server/SSH access to reset.\
\
* * *\
\
## Architecture\
\
[Permalink: Architecture](https://github.com/xaspx/hermes-control-interface#architecture)\
\
```\
src/                    # Vite source (ES modules)\
├── index.html          # Entry point\
├── js/main.js          # App logic (~4800 lines, modular sections)\
├── css/\
│   ├── theme.css       # Color palette (dark/light)\
│   ├── layout.css      # Topbar, modals, dropdowns, sidebar\
│   └── components.css  # Cards, tables, forms, editor, file explorer\
├── public/\
│   └── favicon.svg     # Served unhashed\
└── assets/             # SVG icons\
\
dist/                   # Vite build output (served by Express)\
server.js               # Express + WebSocket + PTY + API (~2300 lines)\
auth.js                 # Multi-user auth + RBAC (bcrypt, sessions, permissions)\
```\
\
* * *\
\
## Development\
\
[Permalink: Development](https://github.com/xaspx/hermes-control-interface#development)\
\
```\
# Edit source in src/\
npx vite build\
\
# Restart (never in foreground — use detached)\
kill $(lsof -t -i:10272) 2>/dev/null\
nohup node server.js &>/dev/null & disown\
```\
\
* * *\
\
## API\
\
[Permalink: API](https://github.com/xaspx/hermes-control-interface#api)\
\
100+ endpoints covering:\
\
- **Auth**: login, logout, session management, setup\
- **Users**: CRUD, role assignment, permission management, reset password\
- **Sessions**: list, rename, delete, export, resume\
- **Profiles**: list, create, clone, delete, use, gateway control\
- **Chat**: send message, stream response, tool calls\
- **Cron**: list, create, pause, resume, run, remove\
- **Config**: read, write, YAML parsing, reset\
- **Memory**: provider-specific panels (MEMORY.md, honcho, external)\
- **Skills**: list, parse, search, install, uninstall, check updates\
- **Files**: list, read, write, save (scoped to Hermes home)\
- **System**: health, insights, usage analytics, doctor, dump, update, backup\
- **Notifications**: list, dismiss, clear\
- **Plugins**: admin-only plugin management\
- **Terminal**: exec command via PTY\
- **Audit**: activity log\
\
See `docs/API.md` for full reference.\
\
* * *\
\
**Security Audit**\
\
Full audit report: [docs/SECURITY\_AUDIT.md](https://github.com/xaspx/hermes-control-interface/blob/main/docs/SECURITY_AUDIT.md) **Score: 7.5/10** — Production-ready.\
\
Issues found and fixed in v3.3.0 and later:\
\
- XSS in home cards (`loadHomeCards()`) — fixed with `escapeHtml()`\
- XSS in error handlers (15+ locations) — all `e.message` now sanitized in innerHTML (v3.5.0)\
- Missing admin gate on plugins API — fixed\
- Terminal exec rate limit — 30 commands/minute per IP\
- Token cleanup interval — now runs every 15 minutes\
\
* * *\
\
## Updating HCI\
\
[Permalink: Updating HCI](https://github.com/xaspx/hermes-control-interface#updating-hci)\
\
```\
# 1. Pull latest code\
cd /root/projects/hermes-control-interface\
git pull origin main\
\
# 2. Install dependencies (if package.json changed)\
npm install\
\
# 3. Rebuild frontend\
npm run build\
\
# 4. Restart production server\
kill $(lsof -t -i :10272) 2>/dev/null\
nohup node server.js &>/dev/null & disown\
```\
\
Or use the HCI UI: **Maintenance → HCI Restart** (restarts from browser).\
\
**Non-root users:** Replace `/root/projects` with your user's project directory.\
If running via systemd, use `sudo systemctl restart hermes-control`.\
\
* * *\
\
## Changelog\
\
[Permalink: Changelog](https://github.com/xaspx/hermes-control-interface#changelog)\
\
### v3.5.0 (2026-04-27)\
\
[Permalink: v3.5.0 (2026-04-27)](https://github.com/xaspx/hermes-control-interface#v350-2026-04-27)\
\
**🧹 Maintenance & Security Hardening:**\
\
- **Dead code removed:**`getProjects()` and `formatBytes()` functions (unused — never called anywhere)\
- **XSS audit complete (S1):** All 15+ `e.message` and `err.message` in `innerHTML` now wrapped with `escapeHtml()` — error handlers across all pages (home, agents, sessions, logs, config, files, terminal, modals, audit log, users)\
- **RBAC precision:** Permissions refined to 20 across 3 roles (admin/viewer/custom) — cleaner than 28 across 12 groups\
- **Session sorting:** Chat sessions sorted by last activity (MAX message timestamp from messages table)\
- **Audit log UX:** Newest-first ordering with Load More at bottom (consistent with other paginated lists)\
\
**🐛 Bug Fixes:**\
\
- **Profile selector sync:** Profile dropdown now correctly syncs after `hermes profile use` (no more stale state after setting default)\
- **Chat agent info panel:** Always visible inside sidebar (no toggle) — shows active agent with bold gold name, all agents list with status dots, ★ default badge\
- **`finalizeWsChat` race guard:**`_finalizeInProgress` flag prevents double-call race condition\
- **`reloadCurrentSessionMessages` race guard:**`_reloadInProgress` flag + all exit paths clear the flag\
- **`showModal` return fix:** Proper if/else with `return` in cancel branch (prevents undefined `.action`)\
\
### v3.4.0 (2026-04-19)\
\
[Permalink: v3.4.0 (2026-04-19)](https://github.com/xaspx/hermes-control-interface#v340-2026-04-19)\
\
**⚡ Chat Revamp (CLI → Gateway API):**\
\
- **Gateway API chat:** Full rewrite from CLI subprocess to Gateway API (`/v1/responses`) — real-time SSE streaming, structured events, no more waiting for full response\
- **Tool call cards:** Collapsible cards with JSON viewer for tool results (collapsed by default)\
- **Session resume:** Auto via `X-Hermes-Session-Id` header — conversations persist across page reloads\
- **Stop button:** Cancel running streams mid-response\
- **Multi-profile support:** All profiles (default/soci/cuan/david) work via Gateway API with auto port discovery\
- **CLI fallback:** Automatic fallback to CLI if gateway is down\
- **Session list:** Sorted by last activity, filter by source type (Telegram/Discord/API/CLI/Cron)\
- **Mobile UX:** Auto-hide sidebar on session select, responsive header, opaque topbar\
\
**🔒 Security (CRITICAL + HIGH):**\
\
- **Command injection fixed:** Skills uninstall/update endpoints use `execHermes()` \+ strict regex `^[\w.\-]+$` validation\
- **CSRF protection:** 21 admin endpoints now require `requireCsrf` (user mgmt, config, keys, skills, HCI update/rollback/restart, backup, doctor, profiles)\
- **Gateway API key:** Dynamic from `~/.hermes/config.yaml` (removed hardcoded `'hci-gateway-2026'` from source)\
- **Dynamic CORS origins:**`cors_origins` no longer hardcoded — supports `HCI_CORS_ORIGINS` env var, auto-detect from request, or localhost defaults\
- **`escapeHtml()` fix:** Added `"` and `'` escaping to prevent XSS via HTML attributes\
- **Debug CSRF logging removed:** Partial tokens no longer logged to console\
- **18-item security audit report** (SECURITY\_AUDIT.md)\
\
**🧹 Maintenance:**\
\
- ~270 lines dead code removed (unused functions, duplicate endpoints, redundant imports, duplicate CSS)\
- Session cache invalidation after rename and delete operations\
\
**🔌 Open-Source Ready:**\
\
- CORS origins: dynamic resolution for any deployment (env var → auto-detect → localhost defaults)\
- Gateway API key: reads from config.yaml, env var override supported\
- `.env.example` updated with `GATEWAY_API_KEY` and `HCI_CORS_ORIGINS` documentation\
\
### v3.3.3 (2026-04-19)\
\
[Permalink: v3.3.3 (2026-04-19)](https://github.com/xaspx/hermes-control-interface#v333-2026-04-19)\
\
**🔒 Security (Critical + High):**\
\
- **Command injection fix:** Skills uninstall/update endpoints now use `execHermes()` \+ strict regex validation `^[\w.\-]+$` on skill names (prevents shell metacharacter injection)\
- **CSRF protection:** Added `requireCsrf` to 21 admin endpoints (user mgmt, config, keys, skills, HCI update/rollback/restart, backup, doctor, profile create/delete)\
- **Hardcoded API key removed:** Gateway API key now reads from `~/.hermes/config.yaml` dynamically (was hardcoded `'hci-gateway-2026'` in source)\
- **Dynamic CORS origins:**`cors_origins` no longer hardcoded to specific domains — supports `HCI_CORS_ORIGINS` env var, auto-detect from request origin, or localhost defaults\
- **Session rename:** Switched from `shell()` to `execHermes()` (defense-in-depth)\
\
**🧹 Maintenance:**\
\
- **Dead code cleanup:** ~270 lines removed across 6 files (unused functions, duplicate endpoints, redundant imports, duplicate CSS)\
- **18-item security audit report** added (SECURITY\_AUDIT.md)\
\
**🐛 Bug Fixes:**\
\
- **Session list sorting:** Fixed sort order — backend now correctly sorts by last activity timestamp\
- **Delete session button:** Fixed operator precedence bug in `await showModal({...})?.action` that prevented delete API call\
- **Session list refresh:** Cache invalidated after rename and delete operations (stale 10s cache)\
- **Gateway session resume:** Gateway process restart fixed stale bytecode issue\
\
**🔌 Open-Source Ready:**\
\
- CORS origins: dynamic resolution (env var → auto-detect → localhost defaults)\
- Gateway API key: reads from config.yaml, env var override supported\
- `.env.example` updated with `GATEWAY_API_KEY` and `HCI_CORS_ORIGINS` docs\
\
### v3.3.2 (2026-04-17)\
\
[Permalink: v3.3.2 (2026-04-17)](https://github.com/xaspx/hermes-control-interface#v332-2026-04-17)\
\
**🐛 Bug Fixes:**\
\
- **HTTP-only deployments:** Disable `upgrade-insecure-requests` CSP directive that broke UI on Tailscale/LAN/dev environments\
- **HOST env var:** Support `HOST` env var for non-localhost server binding (Tailscale IP, LAN, specific interface)\
\
**🤝 Contributors:**\
\
- @hifiguy — 2 fixes (HOST env + CSP HTTP fix)\
\
### v3.3.0 (2026-04-17)\
\
[Permalink: v3.3.0 (2026-04-17)](https://github.com/xaspx/hermes-control-interface#v330-2026-04-17)\
\
**💬 Chat Revamp:**\
\
- Tool call cards: collapsible cards with JSON viewer, collapsed by default\
- Banner suppression: `-Q` flag passed to hermes for clean output\
- Session sidebar: model tag, session list, resume/new chat buttons\
- Auto-detect session ID format: new (`session_id: YYYYMMDD_HHMMSS_HEX`) and legacy (`Session: YYYYMMDD_HHMMSS_HEX`)\
- `--continue ""` (empty) creates fresh session; bare `--continue` resumes last session\
\
**👥 User Management v2 (RBAC):**\
\
- 20 permissions across 3 roles: Admin (full), Viewer (read-only), Custom (your choice)\
- Built-in roles: `admin` (full access), `viewer` (read-only), custom role\
- Create/edit user modal: role presets (Admin/Viewer), grouped permission checklist, reset password button\
- Permission gating on 9 previously-unprotected endpoints\
\
**🔒 Security:**\
\
- Full security audit (docs/SECURITY\_AUDIT.md) — score 7.0/10\
- XSS fix: `loadHomeCards()` now escapes all dynamic values with `escapeHtml()`\
- Rate limiter: terminal exec limited to 30 commands/minute per IP (429 on exceeded)\
- Token cleanup: proper `setInterval()` every 15 minutes (was only on token creation)\
- Admin-only gate: `GET /api/plugins` now requires admin role\
- Full activity audit log: Maintenance → Audit panel\
\
**📦 Skills:**\
\
- Check updates: handles "unavailable" source status gracefully (info message, not error)\
- Uninstall: uses stdin pipe (`echo y |`) instead of unsupported `--yes` flag\
\
**🐛 Bug Fixes:**\
\
- Notification dismiss: backend handles both `/api/notifications/:id/dismiss` and `/api/notifications/dismiss`\
- Sidebar: responsive CSS, `flex-shrink:0`, mobile breakpoints at 480px\
- Agent dropdown: follows dark/light theme correctly\
- Favicon 404 loop: moved to `public/` to prevent Vite hash mismatch\
- HCI Info panel: version, GitHub link, Twitter @bayendor link in Maintenance\
\
**📝 Docs:**\
\
- Security audit report (12 categories)\
- Removed outdated script references (install.sh, reset-password.sh)\
- Screenshots: 13 dark mode, 6 light mode\
\
### v3.2.0 (2026-04-14)\
\
[Permalink: v3.2.0 (2026-04-14)](https://github.com/xaspx/hermes-control-interface#v320-2026-04-14)\
\
**⚡ Performance:**\
\
- Insights speed: 60s+ timeout → 0.65s via IPv4 adapter on model\_metadata.py\
- Timeouts reduced: 10s → 5s (model metadata), 5s → 3s (llama.cpp props)\
\
**🔒 Security:**\
\
- WebSocket origin: exact match (was substring check)\
- Body limit: 10MB → 1MB global, 10MB only on avatar upload\
- Temp files: `crypto.randomUUID()` (no predictable paths)\
- Skills install/uninstall: `execHermes()` instead of shell interpolation\
- Username validation: 2-32 chars, alphanumeric/\_.- only\
\
**✨ Features:**\
\
- Log tabs: Agent, Error, and Gateway logs now working\
- Non-root user support: dynamic HCI identity, HOME-aware paths\
- Gateway service: auto-detect `hermes-gateway-<profile>` for non-root\
\
**🐛 Fixes:**\
\
- Terminal flow: transcript handling after sendCommand\
- XSS: 15+ escaped user-facing error messages\
- Auth panel: data loaded async, doesn't block page load\
- CPR stripping: removed ANSI escape from terminal\
\
### v3.1.0 (2026-04-12)\
\
[Permalink: v3.1.0 (2026-04-12)](https://github.com/xaspx/hermes-control-interface#v310-2026-04-12)\
\
- Skills Hub + Honcho panel + Gateway connections\
- HTTPS support\
- Maintenance UI: Backup & Import, HCI Restart buttons\
\
* * *\
\
## License\
\
[Permalink: License](https://github.com/xaspx/hermes-control-interface#license)\
\
MIT\
\
## Credits\
\
[Permalink: Credits](https://github.com/xaspx/hermes-control-interface#credits)\
\
Built for the [Hermes Agent](https://github.com/NousResearch/hermes-agent) ecosystem.\
\
[@bayendor](https://x.com/bayendor) — GitHub: [xaspx](https://github.com/xaspx)\
\
## About\
\
A self-hosted web dashboard for the Hermes AI agent stack. Provides a browser-based terminal, file explorer, session overview, cron management, system metrics, and an agent status panel — all behind a single password gate.\
\
\
[x.com/bayendor](https://x.com/bayendor "https://x.com/bayendor")\
\
### Topics\
\
[ai-agents](https://github.com/topics/ai-agents "Topic: ai-agents") [hermes-agent](https://github.com/topics/hermes-agent "Topic: hermes-agent")\
\
### Resources\
\
[Readme](https://github.com/xaspx/hermes-control-interface#readme-ov-file)\
\
### License\
\
[MIT license](https://github.com/xaspx/hermes-control-interface#MIT-1-ov-file)\
\
### Code of conduct\
\
[Code of conduct](https://github.com/xaspx/hermes-control-interface#coc-ov-file)\
\
### Contributing\
\
[Contributing](https://github.com/xaspx/hermes-control-interface#contributing-ov-file)\
\
### Security policy\
\
[Security policy](https://github.com/xaspx/hermes-control-interface#security-ov-file)\
\
### Uh oh!\
\
There was an error while loading. [Please reload this page](https://github.com/xaspx/hermes-control-interface).\
\
[Activity](https://github.com/xaspx/hermes-control-interface/activity)\
\
### Stars\
\
[**618**\\
stars](https://github.com/xaspx/hermes-control-interface/stargazers)\
\
### Watchers\
\
[**1**\\
watching](https://github.com/xaspx/hermes-control-interface/watchers)\
\
### Forks\
\
[**96**\\
forks](https://github.com/xaspx/hermes-control-interface/forks)\
\
[Report repository](https://github.com/contact/report-content?content_url=https%3A%2F%2Fgithub.com%2Fxaspx%2Fhermes-control-interface&report=xaspx+%28user%29)\
\
## [Releases\  22](https://github.com/xaspx/hermes-control-interface/releases)\
\
[v3.5.1\\
Latest\\
\\
5 days agoMay 3, 2026](https://github.com/xaspx/hermes-control-interface/releases/tag/v3.5.1)\
\
[\+ 21 releases](https://github.com/xaspx/hermes-control-interface/releases)\
\
## [Packages\  0](https://github.com/users/xaspx/packages?repo_name=hermes-control-interface)\
\
No packages published\
\
## [Contributors\  5](https://github.com/xaspx/hermes-control-interface/graphs/contributors)\
\
- [![@xaspx](https://avatars.githubusercontent.com/u/38959282?s=64&v=4)](https://github.com/xaspx)\
- [![@lo-nau](https://avatars.githubusercontent.com/u/130299787?s=64&v=4)](https://github.com/lo-nau)\
- [![@mass6](https://avatars.githubusercontent.com/u/2149382?s=64&v=4)](https://github.com/mass6)\
- [![@hifiguy](https://avatars.githubusercontent.com/u/34317110?s=64&v=4)](https://github.com/hifiguy)\
- [![@zinc-builds](https://avatars.githubusercontent.com/u/165220904?s=64&v=4)](https://github.com/zinc-builds)\
\
## Languages\
\
- [JavaScript86.2%](https://github.com/xaspx/hermes-control-interface/search?l=javascript)\
- [CSS11.8%](https://github.com/xaspx/hermes-control-interface/search?l=css)\
- [Shell1.1%](https://github.com/xaspx/hermes-control-interface/search?l=shell)\
- [HTML0.9%](https://github.com/xaspx/hermes-control-interface/search?l=html)\
\
You can’t perform that action at this time.