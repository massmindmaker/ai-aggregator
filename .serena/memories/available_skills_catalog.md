# Каталог доступных скиллов — снимок 2026-10-01 (заполнен один раз, не пересканировать)

Всего скиллов в /home/bob/.hermes/skills: 528.
Jev (`jev pick-skill`) на 2026-10-01 ОТДАВАЛ `fail_open: credits_exhausted` —
опросить его нельзя, поэтому каталог просканирован напрямую. Не тратить на него вызовы,
пока лимит не пополнен.

## Что реально нужно этому проекту

| Скилл | Зачем именно тут |
|---|---|
| `cso` | security audit with supported toolchains — the independent security review ECOSYSTEM never had |
| `review` | pre-landing review of a diff: spec compliance + code quality, findings by severity |
| `health` | code-quality dashboard across the repo, useful before declaring a service done |
| `investigate` | systematic root-cause debugging, four phases |
| `qa` | systematic QA of a running web app; qa-only = report without fixing |
| `careful` | safety railblast for destructive commands — we hit a prod migration this session |
| `guard` | full safety mode for destructive operations |
| `land-and-deploy` | land a reviewed branch and deploy it; handles the pm2 fork-mode problem |
| `setup-deploy` | wire deploy config for a repo — relevant, our deploy path is half-broken |
| `learn` | capture project learnings — this is the 'stop going in circles' lever |
| `retrospective` | engineering retrospective over commit history |
| `document-generate` | generate the missing documentation a repo lacks |
| `document-release` | update docs for a shipped change |
| `spec` | turn an idea into a concrete spec before building |
| `skillify` | capture a workflow that worked as a reusable skill |
| `context-restore` | restore session context from checkpoints |
| `context-save` | save context before a risky step |
| `codex` | delegate coding/review to Codex CLI as a second opinion (independent of my own review) |
| `claude-code` | delegate to Claude Code CLI — another independent pair of eyes |
| `zcode-reviewer` | ZCode GLM as headless reviewer — NOT USABLE, ZAI balance is empty |

## Важное ограничение

`zcode-reviewer` и `claude-code`/`codex` как независимые ревьюеры: ZAI-баланс пуст
(429 code 1113), GLM недоступен. Codex CLI требует рабочего OAuth. Space Bunny Alpha
использовать можно, но это тот же провайдер, что и у меня — независимость не даёт.
**Вывод: независимое ревью в этой среде ограничено мной. Не выдавать его за независимое.**

## Остальные наборы в каталоге

- `gstack-*` — 55 скиллов (см. таблицу выше как отобранные; полный список ниже).
- `ads-*` — реклама, нерелевантно.
- `genjutsu/_jutsu` — анимация и motion, нерелевантно.
- `21st-*` — UI-кит, пригодится когда дойдём до витрины.
- `superpowers/*` — цикл разработки, уже используется.
- `software-development/graphify` — граф кода, используется.
- `.archive/*` — архив, не использовать.
