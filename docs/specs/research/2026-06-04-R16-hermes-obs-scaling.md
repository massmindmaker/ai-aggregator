<!-- Generated 2026-06-04. RESEARCH R-16: observability + scaling for managed-Hermes fleet. -->
<!-- Follows R-01 / docs/specs/2026-06-04-managed-hermes-spike-plan.md. Grounded in cited external sources + our code/canon. -->
<!-- Reality anchor: /CLAUDE.md (HERMES L33-41, resident ~300-600MB L35, 2GB-now VPS L39), -->
<!-- spike-plan §2 sizing table, §3 RSS thresholds, §4 control-plane. -->

# R-16 — Observability + scaling для парка managed-Hermes

> **Scope.** Парк персональных resident-инстансов рантайма (Hermes gateway, ~300-600 МБ резидент каждый — `/CLAUDE.md:35`) на одной коробке. Что мерить (метрики/трейсы), как усыплять/будить ради плотности (главный рычаг стоимости), как бэкапить пер-юзер state, и арифметика плотности на 16/32/64 ГБ. Всё привязано к нашей реальности: **сейчас 2 ГБ + 5 pm2-процессов, теста ради — отдельная ~16 ГБ коробка** (spike-plan §2). Это **до** постройки: сначала спайк (R-01 §3), потом control-plane, потом этот слой наблюдаемости.
>
> **Честная рамка.** Managed-Hermes НЕ построен. Числа резидента (300/600/1000 МБ) — триангуляция, не измеренная правда (`hermes-core-explainer.md:175`); этот документ описывает **как** инструментировать спайк и парк, а не подтверждённые прод-цифры. Все внешние механизмы — со ссылками; всё, что не проверено на нашей сборке, помечено ⚠️.

---

## 0. TL;DR — что строить, в каком порядке

| Слой | Минимальное решение для теста (16 ГБ) | Когда усложнять |
|---|---|---|
| (1) Метрики | **cAdvisor + node_exporter → один Prometheus + Grafana** (если агенты в Docker), ИЛИ pm2-метрики + кастомный heartbeat (если без Docker) | трейсы (OTel) — только когда появится control-plane и нужно дебажить латентность шагов |
| (2) Auto-sleep/wake | **stop-on-idle + wake-on-request через прокси-активатор** (паттерн Knative activator / Fly autostop) — наш control-plane уже в request-path | suspend/restore вместо stop, когда cold-start окажется > ~10 с |
| (3) Backups | **per-agent SQLite + Litestream → S3** (continuous WAL shipping) ИЛИ ночной `tar` каталога профиля → S3 | point-in-time recovery — когда появятся платящие юзеры |
| (4) Sizing | бюджет = (RAM − OS 2 ГБ − наши сервисы) / RSS_idle; **проверять только активные, не спящие** | пересчитать по реальному RSS из спайка |

**Самый высоколеверажный рычаг (вывод §2):** **auto-sleep с wake-on-request.** Он один превращает «сколько резидентов влезает по RAM» (~12-25 на 16 ГБ) в «сколько подписчиков обслуживаем» (×5-20), потому что в реальном парке одновременно активны единицы процентов. Без него платишь за RAM каждого юзера 24/7; с ним — только за тех, кто прямо сейчас в чате.

---

## 1. Per-instance метрики/трейсы (RAM / CPU / latency / cost)

### 1.1 Что именно мерить (на инстанс)

| Метрика | Зачем | Источник |
|---|---|---|
| **RSS / working-set память** | главный лимит плотности; триггер `max_memory_restart` и алертов | cgroup (`container_memory_working_set_bytes`) или `ps -o rss=` |
| **CPU seconds** | детектить «убежавший» агент-луп, биллинг по компьюту | `container_cpu_usage_seconds_total` |
| **idle-время (с последнего запроса)** | вход для auto-sleep | наш прокси/control-plane (см. §2) |
| **cold-start latency** | решает sleep vs keep-warm | таймер вокруг старта до первого 200 от `:port/v1` |
| **per-run latency + tokens + cost** | это уже частично есть — биллинг идёт через `:4000` | `agent-runner.ts` / gateway-транзакции |
| **status: running / sleeping / oom** | инвентарь, health | control-plane `GET /instances` (spike-plan §4) |

«Cost» НЕ надо изобретать заново: наценка/списание уже считаются на пути через шлюз `:4000` (`agent-runner.ts:96-108`, settleRun). Метрика стоимости на инстанс = сумма gateway-транзакций по `agentId`. Наблюдаемость нужна для **RAM/CPU/latency**, а cost берём из существующего money-path.

### 1.2 Практический подход — три варианта по нарастанию

**A. Если агенты живут в Docker-контейнерах (рекомендуемая изоляция, spike-plan §4):**
**cAdvisor** даёт per-container память/CPU/сеть из коробки, без правки контейнеров, и экспортит в Prometheus-формате (`container_memory_working_set_bytes` — точнее для OOM-решений чем `usage_bytes`, `container_cpu_usage_seconds_total`, `container_network_*`) — scrape-конфиг тривиальный (`targets: [cadvisor:8080]`, scrape_interval 5s) ([prometheus.io/docs/guides/cadvisor](https://prometheus.io/docs/guides/cadvisor/)). Плюс **node_exporter** для хост-уровня (свободная RAM, swap si/so, load) ([github.com/prometheus/node_exporter](https://github.com/prometheus/node_exporter)). Один Prometheus + Grafana на коробку. Это де-факто стандарт per-container observability и достаточно лёгкий для одной VPS.

**B. Если агенты — pm2-процессы (без Docker, быстрее для спайка):**
pm2 уже даёт per-process RAM/CPU (`pm2 monit`, `pm2 jlist` → JSON для скрейпа) и встроенный **`max_memory_restart`** (напр. `--max-memory-restart 700M`): внутренний воркер pm2 проверяет каждые ~30 с и при превышении делает reload/restart ([pm2 memory-limit docs](https://pm2.keymetrics.io/docs/usage/memory-limit/)). Это бесплатная защита от утечки-резидента — ставим порог чуть выше «active»-RSS из спайка. Метрики наружу: `pm2 jlist` → парсер → Prometheus textfile/pushgateway. Минус: pm2 на агента стоит дороже Docker по изоляции (нет file-isolation чужого `.env` — это прямой риск из spike-plan §1), так что pm2-режим только для измерительного спайка, не для мульти-тенант продакшена.

**C. Кастомный heartbeat (минимум, всегда нужен поверх A или B):**
Наш control-plane уже владеет lifecycle (spike-plan §4). Пусть каждый инстанс раз в ~15 с пишет в Redis/Postgres `{agentId, rss, lastRequestAt, status}`. Этого хватает для (1) inventory-дашборда, (2) входа в auto-sleep (§2), (3) детекта зависших. **Heartbeat обязателен независимо от A/B**, потому что `lastRequestAt` (idle-таймер) знает только наш прокси, не cAdvisor.

**Трейсы (latency по шагам агента):** отложить. OpenTelemetry-инструментирование шагов tool-call имеет смысл только когда (а) есть resident-Hermes с многошаговыми планами и (б) надо дебажить «почему агент тормозит». На стадии спайка/беты достаточно per-run latency из money-path. Когда дойдём — OTel SDK в control-plane + один Tempo/Jaeger; не раньше (coding-behavior: simplicity first).

**Рекомендация для теста:** вариант **A (cAdvisor + node_exporter + Prometheus/Grafana) + C (heartbeat)**. Одна коробка, ~150-250 МБ на весь observability-стек, покрывает RAM/CPU/плотность/health. Это та же инструментация, что снимает числа для спайка (RSS idle/active, swap-граница — spike-plan §3).

---

## 2. Auto-sleep / wake-on-request — ГЛАВНЫЙ рычаг стоимости

Это единственный механизм, который ломает потолок «плотность = RAM / RSS». Логика индустрии (scale-to-zero) одинакова у Knative, Fly.io и serverless-контейнеров: **прокси в request-path** + **буферизация запроса на cold-start** + **stop по простою**.

### 2.1 Эталонные механизмы (со ссылками)

- **Knative activator.** При scale-to-zero специальный сервис **activator** стоит в пути запроса, **принимает и буферит** запросы к «спящей» ревизии, поднимает поды и троттлит подачу — запрос не теряется, ждёт пока инстанс проснётся. Конфигурируемо: activator в пути **только при scale-from-zero** (target-burst-capacity=0) или всегда ([knative.dev target-burst-capacity](https://knative.dev/docs/serving/load-balancing/target-burst-capacity/)). Это ровно наш паттерн: наш control-plane/прокси = «activator», который держит входящий запрос, пока будит Hermes.
- **Fly.io autostop/autostart.** Прокси останавливает машины при избытке ёмкости (concurrency `soft_limit`) и **автостартует по входящему запросу**; есть два состояния — `stopped` (не платишь за CPU/RAM) и `suspended` (**стартует быстрее**, чем из stopped) ([fly.io autostop-autostart](http://fly.io/docs/launch/autostop-autostart/)). Важная оговорка прямо из доков Fly: механизм **«не справляется» с тысячами машин в одном app** — то есть на одной коробке наш потолок инстансов в любом случае десятки-сотни, не тысячи. Для нашей беты (12-50) это не проблема.

### 2.2 Как это ложится на нас (минимальная реализация)

Наш control-plane уже задуман как демон на хосте, владеющий start/stop/health (spike-plan §4) — добавляем ему роль активатора:

1. **Stop-on-idle.** Heartbeat (§1.C) знает `lastRequestAt`. Воркер раз в минуту: если `now − lastRequestAt > IDLE_TTL` (старт с ~5-10 мин) → `POST /instances/{id}/stop`. Один стоп за проход (как у Fly — «at most one Machine per pass»), чтобы не штормить.
2. **Wake-on-request.** Запросы агента идут НЕ напрямую в `:port/v1`, а через наш тонкий прокси. Если инстанс `sleeping` → прокси **держит** входящий HTTP (как activator буферит), вызывает `start`, ждёт первый 200 от `:port/v1`, затем стримит ответ. Юзер видит «агент просыпается…» + латентность cold-start один раз.
3. **stop vs suspend.** Начинаем со **stop** (полностью освобождает RAM — максимум плотности). Если спайк покажет cold-start > ~10 с (порог fail в spike-plan §3) → перейти на **suspend/restore** (быстрее, но держит часть RAM/диска — ⚠️ зависит от того, поддерживает ли это окружение; нативно у Fly/Firecracker, у Docker — `docker pause` освобождает CPU но НЕ RAM, значит для RAM-выигрыша нужен stop или checkpoint/CRIU ⚠️ непроверено на нашей сборке).
4. **keep-warm pool.** Опционально держать 1-2 «тёплых» пустых инстанса, чтобы первый юзер не ловил cold-start. Дёшево (1-2 × RSS), прячет худший случай.

### 2.3 Почему это и есть рычаг — арифметика

Без sleep: каждый подписчик = резидент 24/7. 16 ГБ → ~12-25 максимум (spike-plan §2), и это потолок **подписчиков**, не активных.
Со sleep: RAM держат только **активные** инстансы. В чат-продуктах одновременная активность обычно единицы % от базы. Если активны ~5-10% → те же 16 ГБ обслуживают **120-500 подписчиков** при пиковой одновременности 12-25. Это ×5-20 к экономике на той же железке — прямой ответ на «big cost lever».
⚠️ Реальный коэффициент одновременности измеряется только на живой базе; закладывать консервативно (план под 10-15% активных, не 2%).

---

## 3. Бэкапы per-user agent state / memory

Что бэкапить (вывод из spike-plan §4 — config-инъекция через файлы): на агента это **каталог профиля** = `SOUL.md` (персона), конфиг (модель→`:4000`, tools, MCP-дефиниции БЕЗ ключей), **память/история**, состояние Jobs/cron. Ключи/секреты — отдельно (шифрованные, AES-256-GCM, `/SECURITY.md`), их в общий бэкап не класть.

### 3.1 Два уровня, выбирать по стадии

**Уровень A — простой (для беты): ночной снапшот каталога → S3.**
`tar` каталога профиля каждого агента (или `restic`/`borg` для дедупа+инкремента) → S3-совместимый bucket. Плюсы: тривиально, работает для любого формата файлов Hermes (включая ⚠️ невыясненный нативный формат памяти — у Hermes нет официального export/import всего агента, наша «спека» — выведенный формат, `hermes-webui-landscape.md:94`). Минус: RPO = сутки (теряешь до дня памяти при сбое). Для closed-беты приемлемо.

**Уровень B — continuous (когда есть платящие): SQLite + Litestream → S3.**
Если память/история агента лежит в SQLite (частый случай для embedded-агентов), **Litestream** непрерывно реплицирует через WAL-shipping в S3: стартует длинную read-транзакцию чтобы перехватить checkpoint, копит WAL-страницы в shadow-WAL, гонит их в объектное хранилище; восстановление = снапшот + проигрывание WAL до нужной точки (point-in-time), retention по умолчанию 24 ч ([litestream.io/how-it-works](https://litestream.io/how-it-works/)). RPO падает до секунд, overhead минимальный. ⚠️ Применимо только если Hermes хранит state в SQLite — **проверить на установленной сборке в спайке**; если не SQLite (plain-файлы/иной формат) — остаётся уровень A или per-format-репликация.

### 3.2 Привязка к нашей реальности

- Backup-демон — часть control-plane (он и так владеет файлами профиля). Один cron (наш BullMQ-планировщик уже есть, spike-plan §5) → tar/restic → S3 (S3-креды уже в `/srv/aiag/shared/.env`, memory `project_aiag_api_keys`).
- **Restore = часть lifecycle:** `POST /instances` при `agentId` с существующим бэкапом → сначала восстановить каталог из S3, потом start. Так «пересоздание после OOM/смены коробки» бесплатно.
- Не класть секреты в бэкап профиля (BYOK-ключи шифрованы и живут в Postgres, не в каталоге Hermes — `/SECURITY.md`).

---

## 4. Sizing math для роста (16 / 32 / 64 ГБ)

### 4.1 Формула

```
N_resident_max = (RAM_total − OS_overhead − co-located_services) / RSS_per_instance
N_subscribers  ≈ N_resident_max / concurrency_ratio        ← только при auto-sleep (§2)
```
- `OS_overhead` ≈ 2 ГБ (ядро+служебка, spike-plan §2).
- `co-located_services` ≈ 0 на **выделенной** Hermes-коробке (рекомендация spike-plan §2 — не со-размещать с боевым 2-ГБ ради изоляции `.env`); ≈ 2-3 ГБ если со-размещать.
- `RSS_per_instance` — берём канон 300-600 МБ резидент (`/CLAUDE.md:35`); под нагрузкой пик ~1 ГБ. ⚠️ Реальное число — из спайка; всё ниже пересчитать по нему.
- `concurrency_ratio` — доля одновременно-активных. Консервативно 10-15% (1 из 7-10).
- Минус observability-стек ~0.2 ГБ (§1) + keep-warm 1-2 инстанса.

### 4.2 Таблица плотности (выделенная коробка, браузер агента ВЫКЛЮЧЕН)

| Коробка | Под Hermes (− OS 2 ГБ − obs 0.2 ГБ) | Резидентов @300 МБ | Резидентов @600 МБ | Подписчиков при sleep (10% активных, @600 МБ) |
|---|---|---|---|---|
| **16 ГБ** (тест) | ~13.8 ГБ | ~45 | ~23 | **~230** |
| **32 ГБ** | ~29.8 ГБ | ~99 | ~49 | **~490** |
| **64 ГБ** | ~61.8 ГБ | ~205 | ~102 | **~1020** |

Реалистичный «без свопа, с запасом на пики до ~1 ГБ под активной нагрузкой» ориентир **одновременно активных**: ~12-25 (16 ГБ), ~30-50 (32 ГБ), ~60-100 (64 ГБ) — совпадает с spike-plan §2. Колонка «подписчиков при sleep» — это и есть выигрыш рычага §2 (то, ради чего он строится).

**Поправки (важно — не переоценить коробку):**
- **С включённым браузером агента** делить на 3-4 (`hermes-core-explainer.md:45`).
- **Своп — это fail-граница, не ёмкость:** при первом si/so латентность взрывается; планировать строго ниже OOM/swap-порога из спайка (spike-plan §3, `vmstat` si/so).
- Fly-оговорка: одна коробка-парк практически тянет десятки-сотни инстансов, **не тысячи** — за ~64 ГБ/100+ активных нужен второй узел + роутинг по `agentId`, а не один гигантский хост.
- **2 ГБ сейчас = 0 резидентов** (5 pm2-процессов уже съели RAM, `/CLAUDE.md:39`) — отсюда и весь блокер: тест невозможен без отдельной коробки.

### 4.3 Триггеры роста (когда добавлять RAM/узел)

- Метрика из §1: `node_exporter` свободная RAM < ~15% **или** первый ненулевой swap si/so → пора на следующий размер.
- Активных инстансов приближается к `N_resident_max` (из дашборда инвентаря) → или поднять `IDLE_TTL` агрессивнее (быстрее усыплять), или +RAM.
- Cold-start p95 растёт (пул просыпается слишком часто) → увеличить keep-warm pool ИЛИ перейти на suspend/restore.

---

## 5. Что НЕ делать (контроль объёма)

- Не ставить полноценный кластер-стек (Kubernetes/Knative сам по себе) на одну VPS ради scale-to-zero — взять **паттерн** activator, реализовать в нашем тонком control-plane-прокси. K8s overhead не окупается на 16-64 ГБ.
- Не строить трейсинг (OTel/Tempo) до появления resident-Hermes и реальной потребности дебажить шаги.
- Не изобретать cost-метрику — она уже в money-path через `:4000`.
- Не класть секреты в бэкап профиля.
- Не обещать managed-Hermes в UI как работающее, пока спайк не дал «go» (spike-plan §6, PRODUCT.md «UI = reality»).

---

## Источники

- Knative activator / scale-to-zero буферизация: https://knative.dev/docs/serving/load-balancing/target-burst-capacity/ (fetched 2026-06-04)
- Fly.io autostop/autostart, stop vs suspend, «не тысячи машин»: http://fly.io/docs/launch/autostop-autostart/ (fetched 2026-06-04)
- cAdvisor per-container метрики + Prometheus scrape: https://prometheus.io/docs/guides/cadvisor/ (fetched 2026-06-04)
- node_exporter (host-level): https://github.com/prometheus/node_exporter
- pm2 max_memory_restart (порог ~30 с воркер): https://pm2.keymetrics.io/docs/usage/memory-limit/ (fetched 2026-06-04)
- pm2 per-process monit/jlist: https://pm2.keymetrics.io/docs/usage/process-management/ (fetched 2026-06-04)
- Litestream WAL-shipping → S3 (continuous SQLite backup, PITR): https://litestream.io/how-it-works/ (fetched 2026-06-04)
- Внутренние якоря: `/CLAUDE.md` (L35 resident 300-600МБ, L39 2ГБ-сейчас), `docs/specs/2026-06-04-managed-hermes-spike-plan.md` (§2 sizing, §3 пороги, §4 control-plane, §5 buildable-now), `hermes-core-explainer.md:45,175,94`.

> **Главный вывод (single highest-leverage cost lever):** **auto-sleep с wake-on-request (scale-to-zero) через прокси-активатор в нашем control-plane.** Память держат только активные инстансы, а не каждый подписчик 24/7 — это превращает потолок «12-25 резидентов на 16 ГБ» в «~230 подписчиков» при 10% одновременной активности (×5-20 экономики на той же железке). Всё остальное (cAdvisor-метрики, Litestream-бэкапы, sizing) — поддержка этого рычага.
