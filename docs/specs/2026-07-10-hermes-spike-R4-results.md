# Hermes Spike R4 — результаты (issue #16)

> Дата: 2026-07-10 (изначальный спайк), догон тем же днём. Хост: Hermes-VPS основателя `176.124.211.11`, user `hermes`, Hermes `v2026.6.19-923-g1b75b3fd9`.
> Статус: **ДОГОН ВЫПОЛНЕН.** Бокс очищен (spike-профили + попытка honcho-cleanup). Гейт (b)/(c) per-profile-ключ — эмпирически ПОДТВЕРЖДЁН. Гейт (a) RAM — идле-число снято, нагрузочная часть неубедительна (неверная форма запроса). Гейт (c) `/p/`-роутинг — частично снят. Cold-start снят (10с). Model-field-ignore — по-прежнему непроверяемо. См. «Догон 2026-07-10» ниже.
> ✅ Бокс очищен и повторно проверен в том же коннекте — хвостов не осталось (см. «Догон» → «Состояние бокса после догона»).

## Предохранители (baseline)
- `df -h /` → 38G, свободно **9.2G** (>2G порог — спайк допустим). После провижининга 5 профилей: свободно 8.7G.
- `free -m` → total 3915MB, available **~2100MB**, swap 2048MB. Боевой gateway (PID 1020) RSS ≈ **319MB** (systemd Memory 445MB вместе с MCP-детьми).
- Боевой процесс `hermes-gateway` (backend-eng, PID 1020) и профили `backend-eng`/`alisa` **не трогались и не рестартовались**. Их `config.yaml` не редактировался.

## Три гейта

| Гейт | Ответ |
|---|---|
| **(a) RAM multiplex 1/3/5 профилей, MB** | **непроверяемо**: SSH оборвался до запуска multiplex-прогона. Архитектурно (docs + код): multiplex = **ОДИН процесс** (gateway дефолт-профиля владеет мультиплексором и обслуживает ВСЕ профили; секции 1-5 в `website/docs/user-guide/multi-profile-gateways.md`). Baseline для оценки: одиночный gateway backend-eng = **319MB RSS** (ядро) / **445MB** с MCP-детьми. Число прироста на 1/3/5 активных сессий не снято. |
| **(b) Память между профилями изолирована?** | **Built-in память (MEMORY.md/USER.md): ДА, изолирована** — отдельные файлы на профиль, разные inode (spike_a `828289` ≠ spike_b `829537`). Кросс-чтение на уровне ФС невозможно. **Локальный `~/.hermes/memory_store.db` (провайдер holographic): не активен** (активен honcho), mtime не менялся весь спайк (`2026-06-24`) → живой утечки нет. **Активный провайдер honcho (удалённый хостед-сервис): непроверяемо + РИСК** — все профили делят один workspace `hermes` и один apiKey, изоляция только по peer-name (`aiPeer=<profile>`). Эмпирический кросс-тест не дал результата: `honcho_search` по канарейке в spike_b = «НИЧЕГО НЕ НАЙДЕНО», И self-read в spike_a тоже «НИЧЕГО НЕ НАЙДЕНО» → запись не персистнулась (honcho, как и telegram, судя по всему недоступен с бокса), поэтому положительную утечку не удалось воспроизвести. Один подозрительный лог (spike_b, 10:30:34): `Initializing Honcho client (host: hermes_spike_a, workspace: hermes)` — возможный сигнал кросс-вайринга peer-name, **не подтверждён**. **Вывод для найма: built-in изолирован; для honcho — shared-workspace+shared-key = не закрытая изоляция (совпадает с апстрим #4726), закрывать server-side.** |
| **(c) Per-profile ключ доходит?** | **непроверяемо**: эхо-листенер и прогон не стартовали (SSH оборвался). Документировано (docs): «credentials are never shared across profiles; each turn resolves the routed profile's config … and provider keys». Эмпирически не доказано в этом спайке. |

## Остальные пункты спеки

| Пункт | Команда | Наблюдение | Вердикт |
|---|---|---|---|
| **1. Провижининг** | `hermes profile create spike_X --clone-from backend-eng --clone-all --no-alias` | **1.7–2.1 сек** каждый; **~106MB** на профиль (родитель 122MB). Копирует: `config.yaml`, `.env`, `SOUL.md`, `memories/MEMORY.md`+`USER.md`, `skills/`, `auth.json`, `response_store.db`, кэши. **Исключает** session-history, backups, snapshots (сообщение CLI: «excluding session history, backups, and snapshots»). Honcho-конфиг клонируется (новый peer). | ✅ измерено. **Память (built-in MEMORY.md) КОПИРУЕТСЯ при `--clone-all`; история диалогов — нет.** Важно для найма: клон уносит MEMORY.md автора. |
| **5. REST под `/p/<profile>/`** | — | Живьём под multiplex **непроверяемо** (Batch B не запущен). На боевом ОДИНОЧНОМ gateway `:8642` (не multiplex) из его лога подтверждено: `GET /api/sessions`→200, `/v1/models`→200, `/v1/skills`→200, `/v1/toolsets`→200, `/v1/capabilities`→200, `/api/jobs`→200; `/api/model`→**404**, `/api/profiles`→**404**. Auth = `Bearer API_SERVER_KEY`. Multiplex-роутинг `/p/<profile>/` + `404` на неизвестный профиль — только по докам. | ⚠️ частично: эндпойнты живы на одиночном gateway; `/p/`-роутинг непроверяем. |
| **6. Холодный старт** | — | **непроверяемо** (Batch B не запущен). Косвенно: plugin-discovery в `-z`-прогонах ≈ 8с (51 плагин, 44 enabled); полная инициализация агента дольше. Чистого числа «старт процесса → первый ответ REST» нет. | непроверяемо. |
| **7. Поле `model` игнорируется?** | — | **непроверяемо** (эхо не запущен). Примечание: `GET /api/model`→404; смена модели — через конфиг / `/api/model/set` (по памяти research). | непроверяемо. |

## Ключевые находки по архитектуре
- **Профиль** = директория `~/.hermes/profiles/<name>/` с полным набором (`config.yaml`/`.env`/`SOUL.md`/`memories/`/`sessions/`/`skills/`/`state.db`/`response_store.db`/`auth.json`). Изоляция ФС — реальная (разные inode).
- **`honcho.json`** — НЕ локальное хранилище памяти, а **реестр пиров** удалённого Honcho-сервиса: общий `apiKey` + `workspaceId: hermes`, различается только `aiPeer` (= имя профиля). Т.е. память профилей физически лежит на удалённом honcho, разделяется по peer-name в ОДНОМ workspace. `recallMode: tools`, `writeFrequency: async`.
- **Multiplex** (`gateway.multiplex_profiles: true` на дефолт-профиле): один инбаунд-процесс на все профили; вторичным профилям запрещено поднимать свой gateway (hard-error); HTTP-инбаунд через префикс `/p/<profile>/` на одном порту; сессии неймспейсятся `agent:<profile>:…` (дефолт сохраняет `agent:main:…`); per-`.env` изоляция ключей «стрless, если что, строже» (docs). Порт-биндинг платформы (webhook/api_server/…) — только на дефолт-профиле.
- REST-порт боевого gateway = `:8642` (127.0.0.1). `:18642` = сторонний форвардер (pid 1019), не Hermes-core.

## Состояние бокса после обрыва (на последнем успешном коннекте, ~10:5x UTC)
- **backend-eng ЖИВ**: `gateway list` → `✓ backend-eng (current) — PID 1020`; `default`/`alisa` — stopped (как и было). Боевой не тронут.
- **Batch B НЕ выполнился** (SSH упал на banner-exchange ДО запуска скрипта) → эхо-листенер, изолированный `HERMES_HOME` (`~/spike_home`), multiplex-gateway, правки конфигов spike_a/spike_b — **НЕ создавались**. Никаких повисших процессов/портов от спайка нет (все `-z`-прогоны короткоживущие, завершились; последний `gateway list` показал все `spike_*` = stopped).

### 🔴 НЕ убрано (осталось на VPS):
1. **5 клон-профилей** (~530MB суммарно), не удалены:
   - `/home/hermes/.hermes/profiles/spike_a`
   - `/home/hermes/.hermes/profiles/spike_b`
   - `/home/hermes/.hermes/profiles/spike_c`
   - `/home/hermes/.hermes/profiles/spike_d`
   - `/home/hermes/.hermes/profiles/spike_e`
2. **Peer-записи `spike_*`** добавлены Hermes'ом в глобальный реестр `/home/hermes/.hermes/honcho.json` (аддитивно, безвредно, но для чистоты снять). `spike_b/honcho.json` внутри профиля — уйдёт вместе с профилем.

### Изменённые файлы / бэкапы
- Прямых правок существующих файлов в `~/.hermes` **я не делал** → своих бэкапов не создавал (не требовалось). Единственная косвенная правка — реестр `honcho.json` (сделана самим `hermes profile create`). Бэкап основателя `~/hermes-bak-20260624-142050` — предспайковый, к спайку отношения не имеет.

### Готовые команды очистки (владельцу, одной строкой каждая)
```bash
# 1) удалить spike-профили
rm -rf /home/hermes/.hermes/profiles/spike_a /home/hermes/.hermes/profiles/spike_b /home/hermes/.hermes/profiles/spike_c /home/hermes/.hermes/profiles/spike_d /home/hermes/.hermes/profiles/spike_e
# 2) снять spike-пиров из глобального honcho.json
/home/hermes/.hermes/hermes-agent/venv/bin/python -c "import json;p='/home/hermes/.hermes/honcho.json';d=json.load(open(p));h=d.get('hosts',{});[h.pop(k) for k in [x for x in list(h) if 'spike' in x.lower()]];json.dump(d,open(p,'w'),indent=2);print('cleaned')"
# 3) проверка: профилей spike не осталось, backend-eng жив
ls /home/hermes/.hermes/profiles/ ; curl -s -o /dev/null -w "sessions HTTP %{http_code}\n" http://127.0.0.1:8642/api/sessions
```
> Примечание: висящих процессов спайка нет — kill не требуется. Если владелец захочет через CLI: `hermes profile delete spike_a` … (может спросить подтверждение).

## SSH
- Точная ошибка (дословно): `Connection timed out during banner exchange` / `Connection to UNKNOWN port 65535 timed out`.
- Успешных батч-коннектов: 6 (recon1–5 + Batch A). Провалов на banner-exchange: 2 (recon6 и Batch B). Для Batch B — 1 попытка, далее по указанию координатора остановлено. Канал под always-on VPN интермиттентно флапает (не обязательно fail2ban — recon6b/Batch A прошёл между двумя провалами).

## Что доделать (следующий заход, ОДИН батч)
1. Выполнить команды очистки выше (сначала!).
2. Пере-прогнать Batch B (`scratchpad/reports/remote_batchB.sh`): эхо-листенер `:9099` → per-profile ключ (гейт c); изолированный `~/spike_home` + multiplex `:8643`, `API_SERVER_PORT/API_SERVER_KEY` → idle-RSS + нагрузка 1/3/5 через `POST /p/<profile>/v1/runs` (гейт a), REST-роутинг `/p/`, cold-start, bogus-`model` (пункты 5/6/7). MCP отключены в spike-конфигах, чтобы не OOM-ить 2GB-бокс.

---

## Догон 2026-07-10 (уборка + доизмерение)

Выполнено рукой-уборщиком в 2 SSH-батчах (протокол выдержан: 1 fail на banner-exchange → 20с пауза → успех; итого коннектов: 1 неуспех + 2 успеха из бюджета 5).

### Шаг 1 — очистка (успех со второй попытки)
- `df -h /` до: **8.7G свободно (77%)** → после: **9.2G свободно (76%)** — освобождено ~0.5G.
- `free -m`: 2140MB avail до → 2019MB avail после (обычные колебания, утечки процессов нет).
- `hermes gateway list` до: только `backend-eng` running (PID 1020); `spike_a..e` — not running (процессов спайка живых не было, как и фиксировал прошлый заход).
- `ls profiles/` до: `alisa, backend-eng, spike_a, spike_b, spike_c, spike_d, spike_e` → `rm -rf` → после: **`alisa, backend-eng`** только.
- `honcho.json`: сделан бэкап `honcho.json.bak` (сравнение показал diff=0). **16 пиров до и 16 после, ни один не матчится на `spike`** — предыдущее предположение «Hermes аддитивно пишет spike-пиров в ГЛОБАЛЬНЫЙ `~/.hermes/honcho.json`» **не подтвердилось** (см. ниже объяснение в Шаге 2).
- Живость: `gateway list` → `backend-eng (current) — PID 1020` (тот же PID, не рестартовался); `GET :8642/api/sessions` → `HTTP 401` (тот же сигнал живости, что использовался весь спайк — эндпоинт отвечает, просто требует auth).

### Шаг 2 — доизмерение (тот же успешный коннект, изолированный HERMES_HOME=`~/spike_home2`, профили `spike2_*`, само-очистка через `trap cleanup EXIT`)

| Гейт | Результат |
|---|---|
| **(a) RAM multiplex 1/3/5** | Idle RSS мультиплекс-процесса (root + 5 суб-профилей `spike2p1..5` в конфиге, все сплюснуты в один процесс) = **292MB** (1 процесс). После попыток нагрузки (POST `/p/spike2pN/v1/runs` для 1, затем 3, затем 5 профилей) RSS = **293MB** — то есть не выросло. **НО**: нагрузочные запросы сами провалились с `{"error":"Missing 'input' field"}` — реальный контракт `/v1/runs` ожидает поле `input`, а не OpenAI-style `messages` (наша ошибка формы тела, не факт архитектуры). Поэтому «не выросло» — **неубедительно как доказательство лёгкости нагрузки** (запросы не дошли до реального исполнения). Архитектурный факт подтверждён (один процесс на все профили, как и в доках), но RSS-под-реальной-нагрузкой остаётся неизмеренным. |
| **(b)/(c) per-profile ключ доходит** | **ПОДТВЕРЖДЕНО эмпирически.** Эхо-слушатель `:9199` залогировал: все запросы от `spike2_a` несли `Authorization: Bearer SPIKE2-KEY-AAA`, все запросы от `spike2_b` — `Bearer SPIKE2-KEY-BBB`. Ни одного случая перекрёстного ключа. (Сами `-z`-вызовы падали с «empty stream / no finish_reason» — наш эхо-сервер не умеет в SSE, которого ждёт клиент Hermes — но заголовок авторизации долетал до сервера на каждой retry-попытке ДО этого фейла, так что факт per-profile-ключа доказан независимо от финального результата вызова.) |
| **(c) REST под `/p/<profile>/`** | Частично: `/p/spike2p1/api/sessions` и `/p/spike2p3/api/sessions` (реальные профили) → **404**, `/p/nonexistent/api/sessions` → тоже **404** — то есть по `api/sessions` роутинг не различает известный/неизвестный профиль под `/p/` (либо этот эндпоинт не проброшен под `/p/` вовсе). Контраст: `/p/spike2p1/v1/runs` **был распознан** (вернул валидационную ошибку `Missing 'input' field`, а не 404) — значит `/p/`-префикс реально работает для `/v1/runs`, но не для `/api/sessions`. На корневых (немультиплексных) путях мультиплекс-шлюза: `/api/sessions`→200, `/v1/models`→200, `/v1/capabilities`→200, `/api/jobs`→200. |
| **(d) холодный старт профиля/gateway** | **10 секунд** от старта процесса `hermes gateway run` (HERMES_HOME=spike_home2, 6 профилей: root+5) до первого валидного ответа `:8644/api/sessions`. |
| **(e) поле `model` игнорируется?** | **Непроверяемо** — тот же баг формы тела (`input` vs `messages`) не дал запросу дойти до логики выбора модели; grep по логу шлюза на этот пробный запрос ничего не нашёл. |
| Провижининг (доп. замер) | `spike2_a` = 2с, `spike2_b` = 1с — согласуется с прошлым замером (1.7-2.1с). |

**Honcho — объяснение «0 spike-пиров в глобальном файле»:** и в исходном спайке (recon4/5), и в этом догоне запись в honcho **не персистилась** (сеть/воркспейс honcho с бокса недоступны или память отключена в конфиге). Похоже, что пир регистрируется в глобальном `~/.hermes/honcho.json` только при УСПЕШНОМ round-trip к удалённому Honcho API, а не просто при `profile create --clone-all` — этого round-trip ни разу не случилось. Прежняя формулировка «Hermes аддитивно пишет spike-пиров в глобальный реестр» была ошибочной догадкой, снимаю.

### Состояние бокса после догона (проверено в том же коннекте, внутри `trap cleanup`)
- `ls profiles/` → **`alisa`, `backend-eng`** — ничего лишнего.
- `~/spike_home2` → удалён (`ls`: No such file or directory).
- `honcho.json` spike2-пиров: 0 найдено (ожидаемо, см. выше).
- `backend-eng` жив: `PID 1020` (не менялся весь догон), `GET :8642/api/sessions` → `401` (тот же сигнал живости).
- `df -h /` финал: **9.2G свободно (76%)** — не деградировало относительно конца Шага 1.
- `free -m` финал: avail ~1994MB — без утечки процессов.
- Процессы эхо/gateway спайка убиты в trap (`kill`+`pkill -9 -f spike2_echo.py`), временные файлы `/tmp/spike2_*` удалены.

### Оставшийся долг
- Реальная нагрузочная RSS-кривая (1/3/5 **работающих** ранов) и model-field-ignore — нужен корректный body-shape (`{"input": ...}` вместо `{"messages": ...}`) для `/v1/runs`; в этом заходе не переигрывалось, чтобы не плодить лишний SSH-коннект сверх бюджета.
- `/p/<profile>/api/sessions` routing — стоит перепроверить с другим путём/методом (может быть, сессионные эндпоинты в multiplex экспонируются иначе, не под тем же суффиксом).
