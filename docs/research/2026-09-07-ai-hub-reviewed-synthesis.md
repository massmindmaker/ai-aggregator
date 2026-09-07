# AI Hub: проверенные исследования и решения для выпуска

Проверено 07.09.2026. Статус: принятые архитектурные ориентиры для автономной локальной разработки; эксплуатационная готовность не подтверждается этим документом. Исследованы все четыре входных отчёта: конкурентный обзор, горизонт протоколов, граница Telegram/TON в исходниках и отчёт о рабочей памяти. Отчёты служили указателями; существенные внешние ограничения повторно проверены по первичным страницам. Публичные документы продуктов важнее приватного журнала исполнителя.

## Что берём у рынка

Ниже — наблюдаемые API/продуктовые свойства. Закрытая архитектура конкурентов не исследовалась; отсутствие возможности в выбранной документации не доказывает её отсутствия у продукта.

| Источник, проверенный 07.09 | Наблюдение | Решение AI Hub |
|---|---|---|
| [OpenRouter routing](https://openrouter.ai/docs/guides/routing/provider-selection) | Явные provider policies, fallback, parameter/data filters и price limits | Проверять capability и бюджет до платного dispatch; сохранять выбранную policy в receipt |
| [Replicate predictions](https://replicate.com/docs/topics/predictions/create-a-prediction) | Версионированные вызовы с sync/async результатом | Разделить immutable artifact и deployment; состояние run хранить сервером |
| [Apify monetization](https://docs.apify.com/actors/publishing/monetize), [API](https://docs.apify.com/api/v2) | Монетизируемые Actors; x402/Skyfire уже документированы как agentic payments | Крипта сама по себе не уникальна. Нужны schema, spend limit, run, output и квитанция одной версии |
| [Dify API](https://docs.dify.ai/en/api-reference/guides/get-started) | Опубликованное приложение имеет API и server-side ключ | Web/TMA вызывают общий backend; секреты и runtime не дублировать по клиентам |
| [Hugging Face Inference Providers](https://huggingface.co/docs/inference-providers/index) | Общий доступ к нескольким inference providers | Отдельно хранить модель, provider endpoint, тариф и проверенную capability |
| [Kaggle setup](https://www.kaggle.com/docs/competitions-setup) | Индекс официальной страницы показывает Public/Private/Ignored разметку solution; полный текст renderer не извлёк | Разделение public/final принимаем как собственное требование Arena. Детальные режимы Kaggle из старого отчёта здесь не переаттестованы |
| [Arena.ai methodology changelog](https://arena.ai/company/leaderboard-changelog) | Описаны uncertainty, фильтрация голосов, изменения методики и переход с lmarena.ai | Не переносить старый FAQ staging-домена в обещание текущих правил конкурента. У нас фиксировать eligibility, blindness, dataset и версию методики |
| [LangSmith Evaluation](https://docs.langchain.com/langsmith/evaluation) | Оценка результатов приложения и эксперименты | Соединять evidence с проверенной версией и приватной trace, раскрывать её только по разрешению |

Продуктовая гипотеза: **одна версия решения проходит разработку, независимую оценку, продажу, исполнение и повторную проверку с сохранением связи доказательств и расчётов**. Это гипотеза ценности, которую подтверждают пользовательские сценарии и пилот, а не утверждение «такого нет ни у кого».

## Протоколы и compute: что включается в продукт

| Источник | Проверенный смысл / граница | Решение |
|---|---|---|
| [A2A specification](https://a2a-protocol.org/latest/specification/) | Agent Card, tasks/messages/artifacts, streaming, auth; не платёжный ledger | Adapter к внутреннему Run API после рабочего runtime, по нужному сценарию; совместимость не обещать до conformance tests |
| [MCP 2026-07-28](https://modelcontextprotocol.io/specification/2026-07-28) | Доступ к tools/resources; версия протокола отдельна от модели продукта | Сохранять существующий полезный MCP; новый adapter по pinned revision после permissions/SSRF/secret boundary. Не переписывать runtime только ради новой ревизии |
| [x402 TON exact](https://github.com/x402-foundation/x402/blob/main/specs/schemes/exact/scheme_exact_ton.md), [TVM SDK](https://github.com/x402-foundation/x402/tree/main/typescript/packages/mechanisms/tvm) | TON схема и реализация существуют: TVM network IDs, W5R1 и jetton transfers. Это не универсальный native-coin checkout | Не писать «TON не поддерживается». Отдельный testnet пилот jetton exact; native TON/Gram invoice не зависит от x402 |
| [CDP facilitator](https://docs.cdp.coinbase.com/x402/seller/facilitator) | В опубликованном supported networks перечне TON отсутствует | Не обещать работающий hosted TON facilitator. Перед пилотом проверить конкретный `/supported`, settlement и возврат; текущая проверка — документация, не service transaction |
| [AP2 specification](https://github.com/google-agentic-commerce/AP2/blob/main/docs/ap2/specification.md) | Делегированное коммерческое намерение/mandates | Future adapter при реальной внешней покупке агентом; сейчас внутренние scopes, caps, expiry, approval и audit |
| [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) | Draft EVM identity/reputation/validation registries | Chain-neutral ID внутри; EVM export только по спросу. Не TON identity и не гарантия качества |
| [Gonka quickstart](https://gonka.ai/docs/developer/quickstart/) | Broker inference; документация оговаривает ограничение production access на время request validation | Опциональный HTTP provider pilot после model/license/price/cancel tests; не обязательный compute core |
| [Akash GPU deployments](https://akash.network/docs/learn/core-concepts/gpu-deployments/) | GPU/container workloads | Отдельный инфраструктурный пилот при необходимости собственного evaluator/runtime; не готовый inference provider |
| [Gravity docs](https://docs.gravity.xyz/) | Текущий fetch не удался; имя неоднозначно | Не принимать прежний RPC или гипотезу gravity.xyz за необходимую интеграцию. Зависимость не добавлять |

Убирается прежняя безусловная очередь «сразу сделать A2A/MCP/x402/Gonka»: сначала ценность работающего сценария, затем адаптер, который её открывает. Версия стандарта, код SDK, существование endpoint, успешная транзакция и эксплуатационная зрелость — пять разных доказательств. Прежние высоты RPC не повторялись и не доказывают inference/SLA. Будущий аудит, стабильность SDK и сроки сторонних релизов не обещаются.

## Telegram, TON и деньги: обязательная поправка

[Telegram digital payments](https://core.telegram.org/bots/payments-stars) требует Stars для цифровых товаров/услуг внутри bots/TMA, включая случай наличия отдельного сайта; криптовалюта прямо исключена как замена Stars. Выдача покупки — после `successful_payment`, возврат — через `refundStarPayment`. [Blockchain guidelines](https://core.telegram.org/bots/blockchain-guidelines) отдельно задают TON/TON Connect для blockchain-возможностей TMA; разрешение подключить кошелёк не разрешает продать цифровой доступ за TON. Поэтому старый вывод «crypto-only конфликтует только с внутренними credits» отвергнут. Карта каждого flow находится в [дизайне оплат](../ecosystem/payment-and-evidence-design.md).

[TON branding](https://ton.org/media/) сейчас называет сеть The Open Network/TON, а native token Gram/GRAM, ранее Toncoin/TON. Хранить chain/network и asset identity, display symbol — изменяемая метка. Старые API-поля TON не переименовывать массово и не менять денежные единицы из-за брендинга.

[Agentic wallet contracts](https://docs.ton.org/onboarding/ai/wallets) помечены developer preview, не прошли аудит; рекомендован testnet. Owner может отозвать operator, но действующий operator управляет всеми активами своего agent wallet. Это не доказательство встроенного лимита на покупку. Merchant treasury, внутренние credits и agent wallet — разные сущности. Для v1 пользователь оплачивает invoice своим кошельком; автономный agent wallet остаётся отдельным testnet исследованием без mainnet средств.

## Поправки к исходному состоянию

Локальный code-report: AG — RUB payments, AM — существующие TON/jetton top-up, wallet proof и reconciler, Arena — новый платёжный контур. Это снимок исходников, не подтверждение production настройки/денег. Рабочая память подтверждала только документацию и derived indexes, не принятые продуктовые сценарии. Фактические commits/tests/release продолжает вести [рабочий вход](../DEVELOPMENT-ENTRYPOINT.md).

По отдельной live-проверке контроллера 07.09 Aggregator homepage и исторический AM `/tg` отвечают HTTP 200; это не сверка deployed commit с тремя каноническими репозиториями. Существующий VPS Aggregator и существующий deployment AM сохраняются. Нового Vercel deployment и переноса AM в данном этапе нет.

Обязательный release gate — сопоставить публичные model prices/context, SLA/fallback, author share, срок автоматической оценки, конкурентные ограничения и межпродуктовые ссылки с действующим API/политикой и evidence. Тексты «99.9%», «70%» и «48 часов» не становятся утверждёнными условиями из-за наличия на старом homepage. Не подтверждённое обещание исправить до выпуска; не выдавать доступную страницу за доказательство работающей функции.

## Ограничения проверки

Не выполнялись платежи, подключение кошельков, production migrations, закупка compute, новые deployments и внешний publish. Kaggle дал только индексируемый фрагмент, старый LMArena help URL и Gravity не были читаемы; это ограничения извлечения. Внешние юридические, налоговые, payout и consumer-policy решения для реальных денег остаются release prerequisites и не выводятся из инженерной схемы. [Дизайн](../ecosystem/payment-and-evidence-design.md) и три плана продолжения превращают выводы в проверяемые задачи без заявления 108/108.

## Последнее уточнение хостинга AM — 07.09

[Рекомендация и gate готовности AM Web к preview](/home/bob/Projects/agents-market/docs/product/hosting-decision.md): существующие TMA/API/worker/DB/Redis на VPS; отдельный `apps/web` — кандидат Vercel после versioned API/native Web auth/preview isolation. Текущий этап готовит проверяемый вариант локально, не создаёт project/deploy и не переносит работающий сервис. Эта рекомендация уточняет предыдущую формулировку сохранения deployment; окончательный внешний выпуск требует явного решения владельца.

## Текущий scope после указания «Забей на старс»

Реализация Stars исключена из текущих задач и обязательных implementation gates. Factual правило Telegram выше остаётся: отказ от разработки Stars не разрешает TON вместо них. Продолжаются AG RUB+TON, AM самостоятельный Web TON, Arena TON; TMA — свои агенты/run/result/budget/status и разрешённые wallet flows без нового цифрового checkout или обходной внешней ссылки. Существующие pending TON средства сохраняют reconciliation/refund. Коммерческий TMA checkout остаётся открытым release boundary; остальная автономная разработка продолжается.
