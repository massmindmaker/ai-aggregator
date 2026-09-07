# Продукт, marketplace и UX: ограниченный desk-срез

07.09.2026 · R01/R02/R03/R04/R07/R08/R16 · desk-срез включён в прошедшую review карту решений D01–D12. Исходные рамки: [программа](2026-09-07-research-program.md), [проверенный synthesis](2026-09-07-ai-hub-reviewed-synthesis.md), [функциональный срез](../ecosystem/2026-09-07-functional-checkpoint.md), [AM UX checkpoint](/home/bob/Projects/agents-market/docs/specs/2026-09-07-web-ux-research-checkpoint.md). Интервью, платные прогоны, авторизованные walkthrough и UI-реализация не выполнялись. Рекомендации ниже не повышают функциональные баллы.

**Рекомендация:** начать с одной проверяемой задачи каждого продукта: AG — интегрируемый текстовый API с контролируемым расходом; AM — отчёт по предоставленным материалам с проверяемыми источниками; Arena — воспроизводимое сравнение версий на такой задаче. Связать их паспортом версии, сохраняя самостоятельную ценность. Вход TON-кошельком предложить во всех трёх продуктах; авторизация, платёж и право доступа остаются разными действиями.

## 1. Что подтверждают первичные источники

Все ссылки проверены 07.09.2026. «Текущая docs» означает доступный публичный документ без установленной версии приложения; это не live-проверка тарифа, региональной доступности или внутренней архитектуры.

| Продукт / источник / свежесть | Наблюдаемый путь или ограничение | Следствие для нашего решения |
|---|---|---|
| OpenRouter, [provider routing](https://openrouter.ai/docs/guides/routing/provider-selection); повторное использование проверенного same-day synthesis, новый fetch ошибочен | Provider policy, fallback, parameter/data filters, предел цены | AG: выбор модели включает ограничения исполнения; «единый API» сам по себе не отличие |
| Replicate, [predictions](https://replicate.com/docs/topics/predictions/create-a-prediction); текущая docs | Version/input → prediction ID → status/output; sync wait и deadline различаются; есть polling, web URL и cancel | AG: истечение HTTP-ожидания не означает окончание run; результат восстанавливается по ID |
| Hugging Face, [Inference Providers](https://huggingface.co/docs/inference-providers/index); текущая docs | Playground → scoped token → OpenAI-compatible вызов; fastest/cheapest/preferred/provider selection | AG: выбор через собственную задачу и capability, затем перенос настроек в API |
| Apify, [monetization](https://docs.apify.com/actors/publishing/monetize), [rental sunset](https://docs.apify.com/actors/publishing/monetize/rental); текущая docs | PPE и platform usage; новые rental Actors запрещены с 01.04.2026, полный вывод запланирован 01.10.2026. Документ объясняет путаницу rental fee + usage | AM: не продавать наём как «всё включено»; решение об аренде проверять своим пилотом, а не популярностью чужой модели |
| Relevance, [Marketplace](https://relevanceai.com/docs/get-started/marketplace/introduction), [submission](https://relevanceai.com/docs/get-started/marketplace/relevance-builders/submit-agents); текущие docs | Покупки привязаны к проекту; приобретённое можно менять; cross-project clone зависит от listing. Обновления проходят review; secrets/OAuth defaults не копируются | AM: разные сущности listing, entitlement, version, instance; setup — часть поставляемого решения |
| Dify Cloud, [версии](https://docs.dify.ai/en/cloud/use-dify/build/version-control), [Marketplace](https://docs.dify.ai/en/cloud/use-dify/publish/publish-to-marketplace); modified 17.07/02.07.2026 | Draft/latest/previous для Workflow/Chatflow; pinned API version/restore — paid plans. Изменение содержимого marketplace template создаёт отдельный listing | AM: версия исполнения и редакция карточки не взаимозаменяемы; не обещать совместимость всех типов Dify |
| Lindy, [текущие integrations](https://docs.lindy.ai/integrations/overview), [главная docs](https://docs.lindy.ai/); текущий Teammate | Personal/team connections, health/reconnect; guardrails относятся к writes в shared Slack threads, не web chat/DM. Homepage обещает approvals шире, чем detailed docs | AM: permissions проверяет сервер одинаково в Web/TMA; homepage конкурента не является контрактом безопасности |
| Arena.ai, [methodology changelog](https://arena.ai/company/leaderboard-changelog); датированные изменения 2025–2026 | Публикуются изменения uncertainty, выборки и фильтрации голосов | Arena: показатель сопровождают версия методики, размер выборки и ограничения применимости |
| LangSmith, [evaluation](https://docs.langchain.com/langsmith/evaluation); текущая docs | Dataset/evaluator → experiment → сравнение; offline regression отделена от online evaluation | Arena: конкурс, regression и пользовательское предпочтение должны иметь отдельные результаты |

Dify закрывает дополнительный UX-пробел: [Workflow Web Apps](https://docs.dify.ai/en/cloud/use-dify/publish/webapp/workflow-webapp), modified 29.07.2026, описывает form → progress → copy/save/feedback, сохранённые input/output и ошибки отдельных batch-элементов. [Human Input](https://docs.dify.ai/en/cloud/use-dify/nodes/human-input), та же дата, включает решение и timeout branch. Следовательно, сохранение результата и человеческое подтверждение — ожидаемая база, не уникальная фича.

Старые Lindy builder/versions из [changelog](https://www.lindy.ai/changelog) — историческое evidence, не подтверждение текущего Teammate UI. Kaggle setup снова вернул пустой renderer: подробности его policy не включены в матрицу. Отсутствие сведений не означает отсутствие возможности.

## 2. Первые сегменты и самостоятельные journeys

Это **гипотезы**, основанные на соответствии задач текущему продукту; частота, стоимость проблемы и готовность платить не измерены.

| Приоритет / сегмент | JTBD и нынешняя альтернатива | Предполагаемая частота / проверяемый полезный исход |
|---|---|---|
| 1 · разработчик небольшого AI-сервиса / интегратор | Подключить подходящую модель без самостоятельной сборки нескольких billing/provider интеграций; альтернатива — прямые API, OpenRouter/HF | Ежедневные вызовы; тестовая задача проходит заданную схему, расход объясним, код интеграции повторяем |
| 2 · оператор небольшой команды / агентства | Из нескольких документов или таблиц получить готовый отчёт с источниками и пропусками; альтернатива — ручной ChatGPT + таблица | Еженедельная задача; отчёт принят после ограниченной правки, каждый существенный вывод проверяем |
| 3 · автор прикладного агента и технический заказчик оценки | Доказать улучшение версии на конкретном наборе задач и выбрать решение; альтернатива — ручное сравнение и скрипты/LangSmith | На каждом выпуске; заказчик понимает критерии, воспроизводит решение и видит неудачные случаи |

Стоимость проблемы сначала измерять минутами работы, числом ручных переносов и ошибок, затем фактическими расходами. Не подменять её выдуманным бюджетом. План следующей проверки: по три разбора последней реальной задачи для каждой роли, обезличенный пример входа/приемлемого выхода и разрешённый baseline; контакты пока не инициировать.

**AG standalone:** разработчик → native/TON вход → выбор модели и ограничений → playground → ключ со scope/cap → API-вызов → ответ и receipt → повторяемая интеграция. AG владеет key/quote/usage; покупатель владеет своим заданием. При timeout клиент открывает тот же request; при unknown outcome ждёт reconciliation. Оплаченный ошибочный исход показывает основание расчёта и маршрут спора.

**AM standalone:** покупатель → native/TON вход либо TMA identity → карточка с примером отчёта → доступ к версии → личный instance → файлы/подключения/лимит → run → сохранённый отчёт и расход → повторная задача. AM владеет instance/run/artifact ACL; подключения пользователя не становятся данными автора. Не хватает данных — запросить конкретное дополнение; revoked connection — остановить следующие действия и предложить reconnect; сбой — сохранить вход и установленный исход.

**Arena standalone:** организатор → native/TON вход → draft задачи, dataset, rubric и deadline → private submission точной версии участником → queued/running evaluation → результат, причины ошибок, сравнение → закрытие/апелляция. Arena владеет правилами и evidence, участник — правами на решение. Первый пилот бесплатный; денежный конкурс ждёт отдельно принятого funding/payout. Ошибка платформы не превращается в плохой score участника.

Три опциональных перехода: (1) AM вызывает AG и связывает run с receipt, не требуя от покупателя ручной регистрации в AG; (2) автор экспортирует из Arena разрешённый паспорт в draft AG/AM, после отдельного publish review; (3) разрешённый обезличенный провал AM/AG становится regression case Arena, новая версия возвращается на проверку. Недоступность Arena не блокирует обычный run; старый паспорт не подтверждает изменённую версию. Приватные traces не публикуются автоматически.

## 3. Непротиворечивая модель marketplace v1

**Предложение:** AG продаёт измеряемое использование endpoint конкретной версии, не веса модели. AM продаёт ограниченное по сроку право запускать управляемую версию в одном личном workspace; вычислительный расход показывается отдельно. Бесплатный clone — разрешённый автором fork с собственным instance, без секретов, истории и авторского обязательства обновлять копию. Платный clone/перепродажа, автопродление и торги отложены. Это сохраняет существующие rent/clone направления, не делает их полностью готовыми.

Listing обязан раскрывать предмет права, срок, workspace scope, изменяемые параметры, право на derivative/export, runtime/dependencies, required connections, ограничения результата, состав стоимости, поддержку и снятие с продажи. У автора требуется подтверждение прав на prompt/code/data/tools; согласие на Arena evidence отдельное. Точные лицензии и коммерческие условия проверяются перед выпуском, а не заимствуются у конкурента.

Lifecycle: draft → тест на безопасных данных → immutable version → moderation → published → deprecated/withdrawn. Новая версия не заменяет оплаченный instance молча: пользователь видит change/permission/cost diff и выбирает update; увеличение scope требует нового согласия. Clone не получает merge автоматически. При критической проблеме версия блокируется с объяснением и восстановлением обязательств; обычное снятие listing прекращает новые покупки, не стирает историю. После окончания доступа запрещены новые run и расписания; судьба уже принятого run фиксируется отдельной policy, результаты сохраняются по retention.

Доход автора: pending → available → payout/reversal; спор связывается с entitlement/run/version/receipt и ответственной стороной. Marketplace не обещает мгновенно вывести pending сумму. Для первого предложения достаточно трёх курируемых авторских решений одного JTBD; спрос проверять на десяти разрешённых пилотных задачах, не наполнять каталог сотнями неподдерживаемых карточек.

## 4. IA, состояния и права AM Web/TMA

Web после входа открывает **Работу**. TMA использует компактные вкладки **Работа / Агенты / Маркет / Аккаунт**; кошелёк, подключения и автор — вложенные разделы. «Работа» объединяет текущий dashboard/history и очередь approvals; отдельный второй dashboard не нужен. Desktop допускает список и результат рядом, mobile — последовательный переход с сохранением контекста.

| Экран | Обязательные состояния / действия | Кто вправе действовать |
|---|---|---|
| Вход и способы входа | native/TG/TON; signature pending/rejected/expired, disconnect, account conflict; повторить challenge, выбрать другой вход, привязать/отвязать | Владелец подтверждает обе стороны linking; адрес сам по себе не переносит чужой аккаунт |
| Маркет / карточка | loading/empty/no-results/unavailable/withdrawn; пример выхода, требования, версия, права, evidence; получить доступ/clone | Читать публично; приобретать только авторизованно и в разрешённом канале |
| Мои агенты / настройка | setup-required/ready/access-expired/update-available; входы, connection binding, scope/cap, update/rollback | Владелец instance; author не получает доступ к покупательским данным |
| Работа / run | queued/running/awaiting-input/awaiting-approval/cancel-requested/completed/failed/unknown; дополнить, approve/deny, cancel, восстановить | Владелец или явно назначенный approver; решение проверяется повторно сервером |
| Результат / история | partial/final/unavailable/retention-expired; просмотреть, скачать, оценить, открыть receipt/спор | Resource ACL; share закрыт по умолчанию, клиентские ссылки не обходят проверку |
| Подключения | absent/connecting/healthy/expired/revoked/failed; connect/probe/reconnect/revoke, список затронутых агентов | Владелец connection; team sharing позже, с отдельным scope |
| Кошелёк / расходы | available/reserved/settled/refunded/pending-reconciliation; детали операции и обязательств | Владелец; платёжное подтверждение не равно входу; TMA без нового digital checkout |
| Автор / версии / доход | draft/testing/review/rejected/published/withdrawn; исправить, отправить, обновить, спорить | Автор редактирует свой draft, moderator принимает выпуск; выплаты по отдельному gate |

User story TON для **каждого** продукта: существующий пользователь входит прежним способом, подтверждает кошелёк и затем входит им в тот же аккаунт с прежними правами/историей. Новый пользователь выбирает кошелёк сразу. Потеря кошелька восстанавливается через заранее связанный способ; без доказательства владения поддержка не обещает восстановление. Нельзя отвязать последний пригодный способ без замены. Смена кошелька не меняет получателя старого pending invoice; login ничего не списывает и не даёт approval на внешнюю операцию.

Общие состояния всех экранов: loading, empty, offline/reconnect, forbidden, not-found, validation, unavailable; ошибка содержит причину и допустимое следующее действие. Refresh возвращает тот же runId; unknown не предлагает платный rerun. Изменившийся approval payload требует нового решения; повторный approve из второго клиента не повторяет эффект.

## 5. Общие DESIGN-принципы

Прочитаны AG `DESIGN.md` и Arena `design/DESIGN.md`; TMA tokens здесь опираются на source-срез UX checkpoint, повторного CSS-аудита нет. Общие роли: canvas/surface/text/muted/border/action/success/warning/danger/focus, Inter для текста, Mono для чисел, hairline и спокойная иерархия. Янтарный бренд не должен делать reward и действие неразличимыми; светлая Arena уже использует blue action — сохранить семантику без насильственного выравнивания оттенков.

Общее владение — версионируемый дизайн-контракт; локальные реализации в своих repo, без импорта соседнего checkout. В дальнейшем проверять token/component parity по версии. Рабочее состояние важнее декоративной анимации: reduced-motion, немедленный ввод, текст вместе с цветом, видимый focus, клавиатура, отсутствие потери данных при reflow. Основание проверки — [WCAG 2.2](https://www.w3.org/WAI/WCAG22/quickref/), включая contrast, focus, target size, status messages. Сейчас нет нового нормативного пакета tokens, мокапов или заявления WCAG-conformance.

## 6. Три killer-feature гипотезы и влияние на план

Пороги ниже — **предлагаемые decision rules**, не достигнутые результаты. Baseline ещё не измерен; маленькие пилоты дают направляющее evidence, не статистическую универсальность.

| Гипотеза | Pilot / outcome metric | Отказ или пересмотр |
|---|---|---|
| H1 · выбрать агента по образцу нужного результата | 10 задач пяти операторов; сравнить ручной путь и AM. Принято ≥8/10 результатов; медианное активное время ниже baseline ≥30%; ≥3/5 возвращаются за второй задачей в 14 дней | <6/10 принято либо setup съедает экономию; сузить JTBD, не расширять каталог |
| H2 · один сохраняемый run с понятным бюджетом и квитанцией | По 10 сценариев AG/AM, включая disconnect/retry/unknown. 100% traceable receipts, ноль повторных эффектов; ≥8/10 пользователей верно объясняют access fee/расход/резерв | Любое двойное списание блокирует выпуск; <8/10 понимают деньги — переработать flow до новых тарифов |
| H3 · паспорт точной версии помогает выбирать и обновляться | Три автора, две версии каждого, 20 разрешённых задач; сравнить выбор с паспортом и без. ≥4/5 заказчиков правильно понимают ограничения; три автора используют отчёт для решения release/rollback | Оценка не различает полезные изменения, mismatch версии или паспорт не влияет на решение — отложить публичный badge, оставить private evaluation |

**Взять сейчас:** R01/R02 как гипотезы для трёх вертикальных сценариев; outcome/artifact-first IA, wallet sign-in во всех продуктах, явные лицензии и pinned versions, паритет permissions Web/TMA. **Отложить:** командное sharing, paid clone, автоматическое renewal/merge, большой visual builder, batch, универсального автономного сотрудника. **Отклонить:** рейтинг по числу запусков, автоматический перенос приватной памяти, wallet connect как доказательство оплаты, платный доступ как неограниченный runtime, тихую замену версии и обход TMA checkout.

Точные дополнения к существующим волнам, без перестановки денежных gates:

- **AG-P1/P2:** receipt связывает request/model/provider/price revision; capability mismatch обнаруживается до dispatch. **AG-P3:** права и версии автора, withdrawal/update policy. **AG-P4/P5:** TON login и сохранение RUB/native identity; первый самостоятельный paid playground → API проверяется раньше широкого modality UX.
- **AM-P3:** native + TON identity, dual-proof TG linking и failure/recovery story выше. **AM-P4:** отчёт по входным материалам → artifact → receipt в обоих клиентах; добавить approval replay, revoked connection, access-expiry, update-diff acceptance. **AM-P5:** отдельно право доступа, compute и авторские обязательства. **AM-P6:** semantic/UI-state parity и H1/H2 evidence вместо витринного redesign.
- **AR-P2:** TON sign-in с сохранением команд/ownership и бесплатный submission→evaluation pilot. **AR-P3:** версия отчёта и ограничения оценки. **AR-P4:** денежный конкурс только после funding gate. **AR-P5:** opt-in export паспорта в draft и H3, без автоматической публикации.

Волна A получает desk-решения; R01 и R16 остаются частичными до наблюдений. Волна B получает конкретную IA/state/rights спецификацию; R07/R08 не объявляются завершёнными без operation-by-operation API сверки и review. Волна C измеряет пользу и стоимость поддержки двух клиентов. Региональная доступность, реальные лицензии/коммерческие условия и весь пользовательский lifecycle ещё требуют проверки. Ближайшая реализация — один полный AM useful-run плюс соответствующий AG receipt; Arena развивается самостоятельным воспроизводимым пилотом, не блокируя их паспортом.
