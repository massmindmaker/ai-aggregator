# AG-TON3: граница источников chain evidence

Дата проверки: 13.09.2026. Статус: read-only source grounding для будущего узкого architecture review. Это не готовый verifier, RPC fixture, testnet run или новый trust policy. Runtime settlement остаётся выключен по принятому TON2 контракту. Принятые0072 и invoice core не менялись.

## Что подтверждено официальными источниками

TON прямо различает liteserver proofs и HTTP API: в сравнении API v2/v3 proof bundles отсутствуют, v3 является индексированным доступом. Следовательно, поле из REST-ответа само по себе нельзя описывать как локально проверенное криптографическое доказательство включения. [TON API overview](https://docs.ton.org/api/overview).

TON Center v3 хранит разобранные данные узла в PostgreSQL; testnet endpoint указан отдельно от mainnet. Это подходящий кандидат для обнаружения и получения trace, но само описание источника не определяет допустимый settlement trust policy проекта. [API v3 overview](https://docs.ton.org/api/v3/overview).

Документация transactions перечисляет account, hash/lt, block_ref, mc_block_seqno, emulated/finality, execution description, in_msg и out_msgs. Поля исполнения включают aborted, compute/action success и признаки bounce. Привязку этих полей к существующему VerifiedChainCredit ещё нужно зафиксировать по точной схеме выбранного провайдера и sanitized fixtures; generated example с boolean placeholders не является успешным переводом. [Get transactions](https://docs.ton.org/api/v3/blockchain-data/get-transactions).

Traces можно искать по transaction/message hash; mc_seqno выбирает traces, завершённые в соответствующем masterchain block. Документирована пагинация limit/offset и диапазоны времени/lt. MasterchainInfo возвращает первый и последний **индексированные** blocks, поэтому его latest value не следует без отдельной политики называть независимым finality anchor. [Get traces](https://docs.ton.org/api/v3/actions-and-traces/get-traces), [Get masterchain info](https://docs.ton.org/api/v3/blockchain-data/get-masterchain-info).

Jetton guidance требует allowlisted master и проверки соответствия merchant owner → get_wallet_address → ожидаемый jetton wallet. Для notification проверяются opcode0x7362d09c, amount в atomic units, sender и forward_payload; произвольные metadata/название токена не являются asset identity. Это дополняет обязательный по TON2 полный execution path и не разрешает заменить его одним notification. [Jetton payment processing](https://docs.ton.org/applications/payments/jettons).

## Следующий ограниченный architecture gate

Нужно явно выбрать и независимо проверить одну trust boundary: server-trusted RPC evidence с честным названием и pinned origin/policy либо locally verified liteserver proof chain с pinned trust anchor. Не выдавать первый вариант за второй и не ослаблять принятое требование full trace/inclusion/finality молча.

До реализации settlement caller определить: exact response manifest и bounds; native/jetton message linkage; network/recipient/reference/amount checks; policy pin и historical invoice obligations; finality evidence и отказ на missing/emulated/incomplete; observation/review persistence и restartable cursor. Клиент предоставляет лишь invoiceId. Непроверенный JSON/BOC не конструирует VerifiedChainCredit.

Первый последующий code slice должен сохранять runtime disabled и не менять0072. Успешные/неуспешные реальные sanitized RPC fixtures и import-boundary tests — самостоятельная проверка, которой это чтение документации не заменяет. Сетевые RPC вызовы, signer, broadcast, funds, mainnet, deploy и новые ключи в этой работе не использовались.
