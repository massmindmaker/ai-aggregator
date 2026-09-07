# Payment rails и паспорт результата: согласованный дизайн v1

Дата 07.09.2026. Основание — [проверенное исследование](../research/2026-09-07-ai-hub-reviewed-synthesis.md) и автономное продолжение трёх продуктов. Это проектные контракты, не перечень уже реализованных endpoints.

## Пользовательские сценарии и ценность

| ID | Пользовательский путь | Владелец эффекта | Доказательство приёмки |
|---|---|---|---|
| HUB-01 | Автор публикует версию модели/алгоритма; покупатель вызывает её с ограниченным ключом и видит расход; автор видит начисление | Aggregator | manifest digest → price revision → request/usage → charge → earnings; replay не удваивает деньги |
| HUB-02 | Участник отправляет модель, агента или RAG; организатор получает воспроизводимый final result | Arena | dataset/evaluator/runtime/input digest, quotas, hidden final, error classification, результат после restart |
| HUB-03 | Покупатель сравнивает разрешённые версии в одинаковых условиях и выбирает решение | Arena → draft AG/AM | blindness до голоса, budgets, uncertainty, права экспорта; смена версии не наследует evidence |
| HUB-04 | Пользователь Web без Telegram нанимает агента и получает полезный результат; связанный Telegram видит тот же run | AM Web + TMA + worker | dual-proof link, общий owner, один run и расход, reconnect/cancel/revoke, раздельная UI приёмка |
| HUB-05 | Клиент AG выбирает RUB или TON; клиент AM Web оплачивает TON; организатор Arena покрывает обязательства в TON | Ledger каждого продукта | invoice → chain/provider evidence → однократная проводка → расход/обязательство → refund/reconciliation |
| HUB-06 | Пользователь TMA открывает свой существующий agent run, результат, бюджет и статус платежа | AM | verified identity/ownership → тот же run/receipt, reconnect без новой покупки; новый digital checkout закрыт |
| HUB-07 | Оператор разбирает неизвестный исход run/payment и восстанавливает процесс | Каждый продукт | correlation IDs, неизменяемые внешние факты, pending queue, решение без повторной отправки денег/платного вызова |

Паспорт версии содержит `schemaVersion`, product/solution/version IDs, immutable digest, input/output schema refs, capabilities, permissions, license/rights, deployment/provenance ref, price revision и разрешённые evidence refs. Evidence содержит dataset/evaluator/environment digests, budget/time/tools, sample count/uncertainty, limits, checkedAt и validity policy. Непроверенный авторский claim отделён от Arena result. Receipt связывает version, run/request, исполнителя, usage, pricing, payment/ledger refs и статус результата. Приватные prompts/trace/память не публикуются; экспорт требует consent и redaction. Смена версии создаёт новый паспорт; недоступность Arena не ломает уже купленный run.

## Три независимые денежные границы

1. `PaymentRail` доставляет и проверяет внешние деньги: RUB provider, TON chain. Telegram Stars исключены из текущей реализации по указанию владельца. Его результат — проверяемый payment event, не бесконтрольное изменение баланса.
2. Merchant ledger продукта хранит обязательства, customer credits, holds, consumption, refunds и author earnings. AG, AM и Arena не пишут в чужую БД и не объединяют кошельки. AM покупает inference у AG отдельным service account; пользователь AM платит за AM-услугу.
3. Agent wallet — будущий инструмент делегированных внешних действий. Он не treasury, не login и не внутренний баланс. В preview только testnet, отдельный ограниченный эксперимент с revoke/rotation/receipts; отсутствие wallet adapter не блокирует v1.

AG RUB остаётся действующим rail с историческими pending/webhooks/refunds. TON добавляется рядом, без замены `amountRub` строкой «TON» и без переоценки старого ledger. Для crypto adapter суммы сериализуются decimal integer strings, внутри exact bigint/DECIMAL; не JS float. До BigInt/возведения10встепень проверять длину строк, decimal precision и exponent bounds; до persist — signed range конкретной колонки, включая умножения FX и суммы split. Server allowlist нормализует master/network, клиент её не расширяет. AM сохраняет свою историческую учётную единицу до отдельной проверенной миграции; Stars не приравниваются к USDT или USD по константе.

## Карта платежей по каналам

| Flow | Разрешённый проектный путь | Запрет/гейт |
|---|---|---|
| AG Web: top-up/API/subscription | RUB + TON testnet implementation; mainnet после отдельного release approval | Один и тот же заказ не оплачивать двумя rails; нет скрытой замены действующих банков |
| Arena Web: funding конкурса, платная evaluation при утверждённой цене, prize/refund | TON invoice и отдельный escrow-like ledger обязательств без собственного escrow smart contract v1 | Не объявлять funded по подписи кошелька; правила split/appeal/refund фиксируются до приёма денег |
| AM самостоятельный Web: hire/template/subscription/run credits | TON user-wallet invoice; привязка к account/order | Не считать этот Web обходом TMA rules; history/entitlement access отделён от нового checkout |
| AM TMA: hire, подписка, credits для платных agent/model/tool функций, membership с цифровыми преимуществами | Новый цифровой checkout не предоставляется; Stars не реализуем в текущем scope | TON top-up, NFT или внешняя ссылка не используются как обход; коммерческий TMA release boundary остаётся открытым |
| AM TMA: wallet connect/proof, отображение разрешённых blockchain assets | TON Connect; серверный proof и ownership | Proof не доказывает оплату; не маскировать цифровую подписку под NFT/перевод |
| AM TMA: старые TON invoices и поступления | Сервер продолжает сверку и разбор/refund по исходным обязательствам | Закрытие нового недопустимого checkout не удаляет pending деньги; прямой старый API также должен иметь policy gate |
| Cross-channel уже купленный доступ | Один account/entitlement, источник purchase сохраняется | Отдельно проверить точный UX/terms; запрещена автоматическая кнопка «купить дешевле криптой» из TMA. Не предполагать, что общий баланс снимает channel restrictions |

Классификация blockchain-only transfer/NFT flow не распространяется автоматически на membership/access; если это цифровая услуга внутри Telegram, применяется Stars. Сервер выбирает допустимый flow по продукту/заказу и опубликованной поверхности, не доверяет переданному клиентом `channel=web` как обходу. У отдельного Web свой auth/session/origin и политика; одного hidden button недостаточно.

## TON invoice contract

Целевая структура (wire contract v1):

```json
{
  "schemaVersion": 1,
  "product": "aggregator",
  "invoiceId": "server-uuid",
  "ownerId": "account-or-org-id",
  "orderId": "server-order-id",
  "idempotencyKey": "client-operation-id",
  "network": "tvm:-3",
  "asset": { "kind": "native", "decimals": 9 },
  "amountAtomic": "1250000000",
  "recipient": "normalized-raw-address",
  "reference": "unique-server-payment-reference",
  "quoteId": "immutable-quote-id",
  "expiresAt": "2026-09-07T12:00:00Z",
  "status": "pending"
}
```

Для jetton: `asset.kind=jetton`, обязательно `masterAddress` и pinned `decimals` из server allowlist. Идентичность = network + native/jetton + canonical master address; ticker/название/иконка не участвуют в доверии. Native token UI допускает текущую метку Gram (TON); код хранит стабильную идентичность. Stablecoin добавляется по проверенному master, не «любому USDT». Testnet mock jetton явно подписан test token и не называется настоящим USDt резервом. Активы mainnet не копируются в testnet allowlist.

Quote фиксирует исходную единицу цены продукта, целевой asset, amountAtomic, rational FX/источник/время/округление/expiry/fees. Рассчитывать один раз на сервере; повтор ключа возвращает тот же invoice, конфликт payload — 409. Новый quote не меняет уже созданную invoice. Неопределённый FX закрывает приём новых invoices; существующие сверяются по закреплённым условиям.

## Состояния, chain evidence и recovery

Invoice: `pending → observed → confirmed → settled`; `pending → expired`; `pending/observed/expired → review_required`. Позднее поступление не терять: invoice expired остаётся, платёж идёт в review/refund, а не автоматически выдаёт истёкший заказ. Недоплата/переплата, неверная reference, неизвестный asset, несколько переводов и неверный sender обрабатываются без автоматической выдачи. Для v1 нет silent aggregation split payments. Неверная сеть вообще не даёт settlement.

Подпись TON Connect, BOC отправки и HTTP 200 RPC не являются chain credit. Verifier требует правильные сеть/получателя/сумму/reference, inbound message и полный успешный execution path, отсутствие bounce/abort. Jetton требует allowlisted master, вычисленный merchant jetton wallet и его фактическое зачисление: notification с похожим ticker не доказательство. Хранить transaction hash/LT/account, message hash/index, block/masterchain anchor, verifier version, observedAt. Уникальность входящего события включает network, recipient account, tx hash и message identity; invoice тоже имеет unique settled event.

Finality policy pinned по сети и версии verifier: подтверждённое inclusion/успех в актуальном masterchain контексте и завершение нужного transfer path. Перед live testnet исполнитель сверяет [TON payment docs](https://docs.ton.org/applications/payments/overview) с выбранным RPC API и сохраняет реальные поля proof/finality в fixture. Не изобретать «N confirmations = безопасно» и не называть индексатор light-client proof. Если API не даёт требуемого evidence, событие остаётся observed/review, кредит не выдаётся.

Settlement всегда берёт locks в порядке owner/org → invoice → chain event → refund operation, совместимом с текущим AG organization→admission/payment. Refund начинает с того же owner/org; обратный порядок и внешний RPC под DB lock запрещены. Это обязательный lock order, а не порядок произвольных вызовов. В одной транзакции уникальный event, статус CAS и credit/obligation/ledger пишутся атомарно. Web check и background sweep вызывают одну domain function. Cursor обновляется с обработанными событиями, повтор overlap безопасен. Crash после chain success и до DB commit восстанавливается sweep; после commit до HTTP response replay возвращает receipt. Сбой provider/read timeout — unknown/reconciliation, не «failed, можно отправить ещё раз».

Refund/payout — отдельная durable операция: `requested → approved → dispatching → submitted → confirmed` либо `review_required`; failed используется только для доказанного отсутствия внешнего эффекта. Owner/получатель/asset/amount/reason и policy фиксируются до dispatch. Persist signed message identity/seqno/expiry до broadcast, проверять chain перед повтором; новый перевод запрещён при неизвестном исходе. Подписывающий ключ не в приложении/LLM/browser. Локальный v1 использует mock signer, testnet signer отдельно разрешается и изолируется. История не редактируется: обратная проводка ссылается на исходную. Refund не равен crypto chargeback; consumed credits/debt/disputes должны быть объяснимы оператору.

## Порядок и выпуск

Сначала закрыть принятые денежные/run/DB gates; затем TON invoice core, verifier, ledger binding и recovery; TMA owned run/status и legacy policy gate. Stars implementation исключён из текущего scope, коммерческий in-app checkout остаётся открытым продуктовым решением и не блокирует остальные работы. x402/agent wallet идут отдельными adapters после этих инвариантов, без новых production зависимостей. AG отдельный домен задаётся config origin/callback/CORS/cookies в том же repo и на существующем VPS; четвёртый продукт не создаётся. AM release target сохраняется; Web и TMA имеют раздельные build/acceptance и совместимый API.

Проверки: precision выше 2^53; fake jetton/decimals/network/reference; wallet cancel; expired/late/over/underpayment; replay/cross-tenant/concurrent sweep; bounce/abort/incomplete trace; provider gap/cursor restart; DB rollback; success-before-response crash; consumed credit refund; unknown payout; запрет нового TMA digital checkout/direct legacy bypass; linked/unlinked Web/TMA; отсутствующий upstream не включает платный fallback. Всё на изолированной БД и тестовых adapters; testnet evidence помечается отдельно от fixtures. Каждый gate содержит commit, command/result, environment, checkedAt, owner и unresolved limitations. Production approval требует release parity, backup restore и проверенные денежные/правовые условия; локальный PASS не становится O/PASS или 108/108.

## Последнее уточнение хостинга AM — 07.09

[Рекомендация и gate готовности AM Web к preview](/home/bob/Projects/agents-market/docs/product/hosting-decision.md): существующие TMA/API/worker/DB/Redis на VPS; отдельный `apps/web` — кандидат Vercel после versioned API/native Web auth/preview isolation. Текущий этап готовит проверяемый вариант локально, не создаёт project/deploy и не переносит работающий сервис. Эта рекомендация уточняет предыдущую формулировку сохранения deployment; окончательный внешний выпуск требует явного решения владельца.

Уточнение владельца07.09: «Забей на старс». Это исключение реализации Stars, а не изменение правил Telegram. Незакрытая граница нового коммерческого TMA checkout не даёт права объявить полный платный TMA journey готовым или молча заменить его TON.
