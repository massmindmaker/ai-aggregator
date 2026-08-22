# Suite-Reorg AIAG — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Разложить AIAG на suite из 3 проектов (`aggregator/{core, ai-aggregator, agent-market/{tma,web-app}, ai-contest}`), создать 2 read-only зеркала на GitHub и перестроить дашборд на 11 зон — без изменений CI/деплоя.

**Architecture:** Монорепо остаётся каноном и переезжает в `core/`; зеркала = снапшот-синк префиксов монорепо в отдельные репо (force-push `main`, один коммит на синк). Привязки инструментов (Serena, auto-memory, graphify) перерегистрируются на новый путь.

**Tech Stack:** git, PowerShell 5.1, gh CLI, Serena MCP, graphify CLI, bun.

**Спека:** `docs/superpowers/specs/2026-08-22-suite-reorg-design.md`

**Уточнение к спеке (не конфликт):** зеркала делаются снапшот-синком (копия рабочего дерева префикса → коммит → force-push `main`) вместо `git subtree push`: на Windows это надёжнее, мульти-префиксный репо `agent-market` собирается тривиально, а история старого репо сохранена тегом архива. Зеркала самодокументируются файлами `_MIRROR.md`, добавленными ВНУТРЬ префиксов канона (шаг W5.0).

**Канонический корень до переезда:** `C:\Users\боб\projects\aggregator` (ниже `$agg`); после W4 он станет `$agg\core`.

---

## Task W1: Git-подготовка

- [ ] **W1.1 Запушить канон-ветку**

```powershell
$agg = "C:\Users\боб\projects\aggregator"
git -C $agg push origin feat/r2-readiness
```
Проверка: `git -C $agg log --oneline -1 origin/feat/r2-readiness` → содержит `a42f66e` или новее. Ожидаемо: push без ошибок.

- [ ] **W1.2 Тег-архив на старом agent-market**

```powershell
$am = "C:\Users\боб\projects\agent-market"
git -C $am tag archive/pre-reorg-2026-08-22 63c270b
git -C $am push origin archive/pre-reorg-2026-08-22
```
Проверка: `git -C $am ls-remote --tags origin` → виден `archive/pre-reorg-2026-08-22`.

## Task GATE: Действие основателя ⛔

- [ ] **GATE.1** Попросить основателя выполнить интерактивно `gh auth login` (HTTPS, browser).
- [ ] **GATE.2** Проверка: `gh auth status` → `Logged in to github.com`. Не зелёный — СТОП, дальше не идти.

## Task W2: Экспорт уникального из дублей

- [ ] **W2.1 Найти «только в aiag-web»**

```powershell
$aw = "C:\Users\боб\projects\aiag-web"; $agg = "C:\Users\боб\projects\aggregator"
$only = @()
Get-ChildItem "$aw\apps","$aw\packages" -Recurse -File -ErrorAction SilentlyContinue |
  Where-Object { $_.FullName -notmatch 'node_modules|\.next|dist|\.turbo' } | ForEach-Object {
    $rel = $_.FullName.Substring($aw.Length+1) -replace '\\','/'
    git -C $agg cat-file -e ("HEAD:" + $rel) 2>$null
    if ($LASTEXITCODE -ne 0) {
      $only += [pscustomobject]@{ Rel = $rel; Src = $_.FullName }
    }
  }
$only | Format-Table -AutoSize | Out-String
"COUNT=$($only.Count)"
```
Ожидаемо: COUNT ≈ 14 (NFT-admin, contests submissions upload/confirm, me/submit-model, theme/*). Если сильно больше — СТОП, показать список основателю.

- [ ] **W2.2 Скопировать найденное как reference**

```powershell
$dst = "$agg\docs\superpowers\recovered\aiag-web"
New-Item -ItemType Directory -Force $dst | Out-Null
foreach ($f in $only) {
  $t = Join-Path $dst $f.Rel; New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null
  Copy-Item $f.Src $t
}
```
Примечание: кладём под `docs/superpowers/recovered/` — НЕ в `src/`: июньские страницы могут импортировать модули, которых нет в HEAD, и сломать сборку. Это «задокументированные потерянные фичи» по спеке §W2.

- [ ] **W2.3 Два файла из старого клона agent-market**

```powershell
$amOld = "C:\Users\боб\projects\agent-market"; $rec = "$agg\docs\superpowers\recovered\agent-market"
foreach ($rel in @(
  'apps/tg-miniapp/app/api/tma/templates/[id]/clone/route.ts',
  'apps/tg-miniapp/src/components/CatalogNav.tsx')) {
  $src = Join-Path $amOld ($rel -replace '/','\')
  if ((Test-Path -LiteralPath $src) -and ((git -C $agg cat-file -e ("HEAD:" + $rel) 2>$null); $LASTEXITCODE -ne 0)) {
    $t = Join-Path $rec $rel; New-Item -ItemType Directory -Force (Split-Path $t) | Out-Null
    Copy-Item -LiteralPath $src $t; "copied: $rel"
  } else { "skip (нет в клоне ИЛИ есть в HEAD): $rel" }
}
```

- [ ] **W2.4 Коммит экспорта**

```powershell
git -C $agg add docs/superpowers/recovered
git -C $agg commit -m "restore unique features from stale splits (parked under docs/superpowers/recovered)"
```
Проверка: `git -C $agg status --porcelain docs/superpowers/recovered` пусто.

### Уроки исполнения (2026-08-22)
- Существование файла в HEAD проверять ТОЛЬКО `git cat-file -e HEAD:<rel>` по `$LASTEXITCODE`; stdout-проверки ненадёжны.
- Пути со скобками `[] ()` — исключительно `-LiteralPath` у Test-Path/Copy-Item.
- Факт: реально уникальных файлов оказалось 15 (14 aiag-web + 1 agent-market; clone-route в HEAD отсутствует — удалён историей fba98da). Зона contests upload/confirm спасена из дубля aiag-web.

## Task W3: Архивация дублей

⚠️ Все команды — из каталога ВНЕ перемещаемых папок (например, `workdir=C:\Users\боб\projects`).

- [ ] **W3.1 Архив aiag-web**

```powershell
New-Item -ItemType Directory -Force C:\Users\боб\projects\_archive | Out-Null
Move-Item C:\Users\боб\projects\aiag-web C:\Users\боб\projects\_archive\aiag-web-snapshot-2026-06-12
```
Проверка: `Test-Path C:\Users\боб\projects\_archive\aiag-web-snapshot-2026-06-12\.serena` → True.

- [ ] **W3.2 Удалить старый клон agent-market**

```powershell
git -C C:\Users\боб\projects\agent-market status --porcelain   # должно быть пусто
Remove-Item -Recurse -Force C:\Users\боб\projects\agent-market
```
Безопасно: история репо на GitHub, tip помечен тегом архива (W1.2).

## Task W4: Переезд в core/ + привязки

- [ ] **W4.1 Переставить папки**

```powershell
Rename-Item C:\Users\боб\projects\aggregator aggregator-tmp
New-Item -ItemType Directory C:\Users\боб\projects\aggregator | Out-Null
Move-Item C:\Users\боб\projects\aggregator-tmp C:\Users\боб\projects\aggregator\core
$agg = "C:\Users\боб\projects\aggregator\core"
git -C $agg status -sb        # ветка feat/r2-readiness, репо жив
```

- [ ] **W4.2 Убрать temp-worktree аудита**

```powershell
git -C $agg worktree remove C:\Users\2E1A~1\AppData\Local\Temp\opencode\aiag-head --force
git -C $agg worktree prune
```

- [ ] **W4.3 Бэкап + переименование ключа auto-memory Claude Code**

```powershell
$memKey = "C--Users-----projects-aggregator"
Copy-Item -Recurse "C:\Users\боб\.claude\projects\$memKey" "C:\Users\боб\.claude\projects\_backup-$memKey"
Rename-Item "C:\Users\боб\.claude\projects\$memKey" "C--Users-----projects-aggregator-core"
```
Проверка: обе папки существуют (рабочая + бэкап).

- [ ] **W4.4 Serena на новый путь** — вызвать `serena_activate_project("C:\Users\боб\projects\aggregator\core")`. Проверка: активация без ошибок.

- [ ] **W4.5 graphify перестроить**

```powershell
graphify update C:\Users\боб\projects\aggregator\core
```
Проверка: `graphify-out/graph.json` обновил mtime. (Долгая команда — timeout ≥ 10 мин.)

- [ ] **W4.6 Grep старых абсолютных путей**

```
Grep pattern: projects[/\\](aggregator\b|aiag-web)  path: C:\Users\боб\projects\aggregator\core  include: *.{md,yml,yaml,json,mjs,cjs,ts}
```
Править ТОЛЬКО конфиги/скрипты (не исторические доки-отчёты). Исторические упоминания в `docs/specs/*` не трогать.

- [ ] **W4.7 Верификация сборки**

```powershell
bun run --cwd C:\Users\боб\projects\aggregator\core\apps\web build
```
Ожидаемо: build завершается успехом (Next 14). При падении из-за окружения (env-переменные) — зафиксировать ошибку, продолжать можно только если причина не в переезде.

## Task W5: Зеркала + родительская карта

> В начале каждого блока: `$agg = "C:\Users\боб\projects\aggregator\core"`

- [ ] **W5.0 Шапки-зеркала внутрь канона (коммитится в core!)**

Создать 4 файла с содержимым ниже, подставив свой путь:
`apps/web/_MIRROR.md`, `apps/tg-miniapp/_MIRROR.md`, `apps/agent-worker/_MIRROR.md`, `packages/shared/_MIRROR.md`:

```markdown
# READ-ONLY MIRROR CONTENT
Этот каталог публикуется снапшот-синком в зеркало:
- (для apps/web) github.com/massmindmaker/ai-aggregator-web
- (для tg-miniapp/agent-worker/shared) github.com/massmindmaker/agent-market
КАНОН: github.com/massmindmaker/aiag-marketplace → core/<этот путь>. PR сюда не принимаются.
```

```powershell
git -C $agg add apps/web/_MIRROR.md apps/tg-miniapp/_MIRROR.md apps/agent-worker/_MIRROR.md packages/shared/_MIRROR.md
git -C $agg commit -m "chore(mirrors): add READ-ONLY mirror headers into mirrored prefixes"
```

- [ ] **W5.1 Создать репо ai-aggregator-web**

```powershell
gh repo create massmindmaker/ai-aggregator-web --private --description "READ-ONLY mirror of apps/web (canon: massmindmaker/aiag-marketplace)"
```

- [ ] **W5.2 Синк зеркала №1 (apps/web → root)**

```powershell
$tmp = "C:\Users\2E1A~1\AppData\Local\Temp\opencode\aaw-mirror"
Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
git clone https://github.com/massmindmaker/ai-aggregator-web.git $tmp
Get-ChildItem $tmp -Exclude .git | Remove-Item -Recurse -Force
Copy-Item -Recurse -Force "$agg\apps\web\*" $tmp
git -C $tmp add -A
git -C $tmp commit -m ("mirror: sync apps/web @ " + (git -C $agg rev-parse --short HEAD))
git -C $tmp push --force origin main
```

- [ ] **W5.3 Синк зеркала №2 (мульти-префикс → agent-market)**

```powershell
$tmp2 = "C:\Users\2E1A~1\AppData\Local\Temp\opencode\am-mirror"
Remove-Item -Recurse -Force $tmp2 -ErrorAction SilentlyContinue
git clone https://github.com/massmindmaker/agent-market.git $tmp2
git -C $tmp2 checkout -B main
Get-ChildItem $tmp2 -Exclude .git | Remove-Item -Recurse -Force
foreach ($p in @('apps\tg-miniapp','apps\agent-worker','packages\shared','packages\typescript-config')) {
  Copy-Item -Recurse -Force (Join-Path $agg $p) (Join-Path $tmp2 $p)
}
# вычистить мусор копии
Get-ChildItem $tmp2 -Recurse -Directory -Force | Where-Object Name -in '.next','node_modules','dist','.turbo' | Remove-Item -Recurse -Force
git -C $tmp2 add -A
git -C $tmp2 commit -m ("mirror: sync tma+agent-worker+shared @ " + (git -C $agg rev-parse --short HEAD))
git -C $tmp2 push --force origin main
```

- [ ] **W5.4 Локальные клоны зеркал + плейсхолдеры + карта родителя**

```powershell
$root = "C:\Users\боб\projects\aggregator"
git clone https://github.com/massmindmaker/ai-aggregator-web.git "$root\ai-aggregator"
git clone https://github.com/massmindmaker/agent-market.git "$root\agent-market\tma"
```

Создать `agent-market\web-app\README.md`:

```markdown
# Agent-Market · Web-App (плейсхолдер)
Канон кода: `core/apps/web` → роут `/agentmarket` (скрыт 404, запись: docs/specs/2026-07-15-agentmarket-web-hidden.md).
Выделение в отдельное приложение + свой репо = волна Фазы C.
```

Создать `ai-contest/README.md`:

```markdown
# AI-Contest (плейсхолдер)
Канон кода конкурсов: `core/apps/web` (routes contests*) + `core/apps/worker` (sink contest-eval — заглушка).
Известные дыры см. аудит 2026-08-22. Выделение в продукт = отдельная фаза.
```

Создать родительский `$root\README.md`:

```markdown
# AGGREGATOR SUITE — карта проектов
| Проект | Код (канон) | Деплой | Зеркало |
|---|---|---|---|
| ai-aggregator (маркет+модели) | core/apps/web + core/packages/api-gateway | GitHub Actions apps=web,gateway | ../ai-aggregator (read-only) |
| agent-market · TMA | core/apps/tg-miniapp + core/apps/agent-worker | apps=tma,agent-worker | agent-market/tma (read-only) |
| agent-market · Web-App | core/apps/web (/agentmarket, скрыт) | — | плейсхолдер web-app/ |
| ai-contest | core/apps/web (contests) + core/apps/worker | — | плейсхолдер ai-contest/ |

Ветка канона: `feat/r2-readiness` (master заморожен). Правила работы: core/CLAUDE.md.
```

## Task W6: Гигиена доков + дашборд

> В начале каждого блока: `$agg = "C:\Users\боб\projects\aggregator\core"`

- [ ] **W6.1 core/CLAUDE.md переписать**: топология `aggregator/core`, таблица 3 продуктов, канон-ветка `feat/r2-readiness`, удалить ссылки на несуществующие `.serena/memories/aiag_*.md`, добавить ссылку на карту `../README.md`.
- [ ] **W6.2 AGENTS.md/.agents/.codex**: вычитать корневой `AGENTS.md`, актуализировать, закоммитить; дописать в `.gitignore` строки `.agents/` и `.codex/`.
- [ ] **W6.3 apps/tg-miniapp/CLAUDE.md**: заменить утверждение «code still debits a RUB balance» на факт USD-микро-кредитов BIGINT (см. миграции 0056).
- [ ] **W6.4 DASHBOARD.html → 11 зон**: в массиве `TABS` завести зоны по таблице спеки §4 (Обзор suite; AI-Агрегатор; Agent-Market с подразделами TMA/Web-app; AI-Contest; Платформа; Деньги; Ресёрчи; Дизайн и интерфейс; Упаковка; Roadmap; Решения основателя). Карточки существующих вкладок перенести по маппингу «Откуда»; протухшим — бейдж `архив`; новые CARD'ы: аудит 2026-08-22 (в зоны 2 и 3), решения основателя (лог вердиктов со ссылками на спеки).
- [ ] **W6.5 Коммит гигиены**

```powershell
git -C $agg add -A :!graphify-out
git -C $agg commit -m "docs: hygiene pass — CLAUDE/AGENTS actualization, dashboard re-zoned to 11 tabs"
```

## Финальная приёмка (= §5 спеки)

- [ ] Родитель содержит ровно: `README.md`, `core/`, `ai-aggregator/`, `agent-market/{tma,web-app}/`, `ai-contest/`
- [ ] В `projects/` нет активных дублей (только `_archive/`)
- [ ] Оба зеркала = HEAD своего снапшота; `_MIRROR.md` видны в их корнях
- [ ] recovered-файлы закоммичены; build web зелёный; diff по `.github/workflows/**` пуст: `git -C $agg diff a8cc474..HEAD --stat -- .github/workflows` → пусто
- [ ] Serena/auto-memory/graphify работают из нового пути
- [ ] DASHBOARD: 11 зон, grep-подсчёт карточек ≥ исходного
