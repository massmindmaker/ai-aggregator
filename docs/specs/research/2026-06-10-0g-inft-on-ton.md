# 0G (Zero Gravity) + iNFT (ERC-7857) на TON — ресёрч под наш кейс

> **Дата:** 2026-06-10 · **Режим:** deep (5 параллельных суб-агентов, 53 источника, adversarial-проверка).
> **Вопрос основателя:** можно ли и КАК реализовать концепции 0G Network и iNFT/ERC-7857 на TON под нашу TMA — так, чтобы это усиливало author-rent и НЕ скатывалось в Virtuals-казино.
> **Канон:** `/CLAUDE.md` (NFT удалён, анти-референс Virtuals, two-entity, USD-кредит-леджер). Формат вывода — «реальное против фантазии».

---

## Executive Summary

**Главный вывод в одну строку: МЕХАНИЗМ iNFT (передаваемый агент + приватная память, которая ре-шифруется новому владельцу при передаче) воспроизводим на TON уже сейчас — но НЕ как торгуемый спекулятивный токен, а как продуктовая фича «передать/подарить настроенного агента». Сам 0G как чейн/сторадж нам почти не нужен.**

Три отдельных ответа:

1. **iNFT-механизм на TON — СТРОИТСЯ СЕЙЧАС (off-chain).** Четыре строительных блока iNFT [14] чейн-агностичны. TON даёт нативно: токен-владение (TEP-62 [23]), указатель на off-chain данные (TEP-64 [22] + TON DNS [28]), и ключи (Ed25519→X25519 для ECDH-бокса, тот же путь, что TonConnect [29]). Чего TON НЕ даёт: шифрование/ре-шифрование на чейне, TEE, oracle — **это 100% работа нашего backend** [23]. Решение: TEP-62 NFT = владение; зашифрованная память агента в нашем S3; наш backend ловит событие transfer, расшифровывает старым ключом и **ре-шифрует на X25519-ключ нового владельца**. Это архитектура ERC-7857 [14], переписанная off-chain с одним доверенным backend (а это и есть наша модель зарубежного юрлица) — без TEE-сети и без 0G.

2. **0G Storage/Compute как слой памяти агента — НЕ НУЖЕН.** Скептическая гипотеза подтверждена: децентрализованный сторадж — неверный инструмент для горячей интерактивной памяти. SDK-аплоад 0G целится в «<5 минут» [4-A5], вся категория меряется против 45-сек Filecoin-retrieval [4-Fil]. pgvector в нашем Postgres (уже работает, уже зашифрован AES-256-GCM, sub-ms) выигрывает по всем осям [40]. **Нативного моста 0G↔TON нет** (0G — EVM-L1, TON — non-EVM) [37] — 0G не добавляет «крипто-нативности» TON-продукту, только второй сторадж. Использовать максимум как дешёвый *холодный* blob-архив, и то S3 проще.

3. **«iNFT-на-TON» без казино — ДА, при жёсткой дисциплине.** Доказательная база однозначна: торгуемый агент-токен = казино. Virtuals −90%, usage→0, фрод BasisOS на $500K [52]; Alethea ALI −97% [53]. **Передаваемый агент должен быть «вещь, которую отдаёшь», а не «доля, которой торгуешь»**: фикс-цена автора (наш author-rent pass-through, 0% cut), без bonding-curve, без вторичного-рынка-как-фичи. По 259-ФЗ utility-право (доступ к услуге) явно ВЫВЕДЕНО из ЦФА [49]; торгуемость+аппресиация затягивают в ЦФА/ценные бумаги.

**Критический блокер совместимости (новый, не был в нашей памяти):** Telegram blockchain guidelines [46] — **ЖЁСТКОЕ правило**: токены/NFT в Mini App только на TON, только TON-Connect; ETH/SOL запрещены = де-листинг. Значит «iNFT на 0G/Ethereum ради гранта 0G» делает продукт **несовместимым с Telegram-дистрибуцией**. Грант 0G ($88.88M ecosystem + $20M Apollo, явно финансирует ERC-7857-iNFT [13][42]) заманчив, но architecturally конфликтует с TON-only. Деньги по нашей дороге = **гранты TON** (AI-вертикаль [43] + $50K Mini-App migration ad-credits [44]).

---

## Введение

**Scope (внутри):** что такое 0G (4 модуля + iNFT/ERC-7857), зрелость; механизм ERC-7857 в деталях; чем TON располагает для его воспроизведения; годность 0G Storage как памяти агента; гранты 0G/TON; юр-фит передаваемого агент-токена (Telegram ToS + 259-ФЗ). **Снаружи:** реализация кода, аудит конкретных контрактов, дизайн UI.

**Методология:** 5 суб-агентов с web-поиском (WebSearch/WebFetch; Exa/Firecrawl частично падали — отмечено), structured-вывод {claim, цитата, URL, дата, credibility} + adversarial-нота. Триангуляция: ключевые факты ≥2 независимых источника. Первичные источники (EIP, TEP, docs TON/0G, статуты) отделены от vendor-PR и practitioner-блогов.

**Допущения:** наш кейс по `/CLAUDE.md` — TMA маркетплейс агентов, USD-кредит-леджер, TON Connect на вход, two-entity, NFT удалён, author-rent 0% cut.

---

## Находка 1 — Что такое 0G и его зрелость (СМЕШАННО: жив, но рискован)

0G (Zero Gravity) — модульный AI-L1 из 4 модулей: **Chain** (EVM-L1 исполнение), **Storage** (децентрализованный сторадж больших датасетов), **DA** (data availability), **Compute** (GPU-маркетплейс под inference/fine-tune) [1]. Storage — erasure-coding + Merkle-tree, слои Log (append-only) и KV (mutable), консенсус PoRA [2][3].

**Что реально (проверяемо третьими сторонами):** mainnet «Aristotle» с сентября 2025, токен 0G торгуется [3]. Но самые проверяемые факты — негативные: on-chain TVL всего **~$3M** (DefiLlama, независимо) [4]; токен **−92%** с ~$7 до ~$0.50, **делистинг с Binance 16.01.2026**, ~8-9M токенов разлок/мес + крупный team-клиф сентябрь-2026 [5]. Критика: обвинения в «soft rug» от Conflux, овервалюация (seed-cap >$2B при нуле выручки), расхождение «raise $290-401M» vs ~$13.7M реального кэша [11][13].

**Что хайп (только self-reported 0G):** все перф-цифры — «2 GB/s storage», «DA в 50,000× быстрее Ethereum», «95% дешевле AWS» — только из доков/блога/PR 0G, независимых бенчмарков НЕТ [6][10]. Compute крутит inference в TEE («Sealed Inference», Intel TDX + H100/H200) [9] — но в проде не подтверждено.

**Это означает:** 0G — реальный, но молодой, токеномически проблемный single-ecosystem чейн. Опираться на него как на инфраструктурную зависимость money-path — рискованно. SDK Storage (Go+TS, client-side AES-256/ECIES) [7] реален и пригоден точечно.

---

## Находка 2 — Механизм ERC-7857: 4 чейн-агностичных блока (ВЫСОКАЯ достоверность)

ERC-7857 («AI Agents NFT with Private Metadata», создан 02.01.2025) решает то, что ERC-721 не может: для агента **метаданные ЕСТЬ сам актив** и должны передаваться зашифрованно, а не быть статично-публичными [14].

**Механизм передачи (дословно):** доверенный oracle расшифровывает метаданные **внутри TEE**, генерит **новый ключ**, ре-шифрует, кладёт на off-chain сторадж (0G Storage), и шифрует новый ключ **на публичный ключ получателя** — старый владелец отрезан [15]. Получатель подписывает hash своим ключом; контракт проверяет «Transfer Validity Proof» и финализирует [14]. На чейне — только хэши + зашифрованные ключи, данные off-chain [14]. Верификация — TEE ИЛИ ZKP [14].

**Важная оговорка из самого спека:** ZKP-путь **протекает** — новые апдейты видны прошлому владельцу, пока не ре-шифровано; жёсткая гарантия держится только на TEE [14], у которого длинная история side-channel-атак (SGX), а ключевой «Sealed Executor» спек оставляет out-of-scope [21].

**Зрелость — НЕ финал:** статус спорный (рендер EIP-страницы показал «Final», но PR #824 несёт label `s-draft`, мердж 16.06.2025 ≠ финализация) [16]; докиs 0G по контрактам — без адресов и аудита («coming soon») [18]; «живой» маркетплейс AIverse (март-2026) — из vendor-PR, без верифицированного адреса контракта [17]. **Это single-ecosystem (0G) стандарт с vendor-driven adoption, не широко-провереннный.**

**4 строительных блока (синтез спека, чейн-агностичны)** [14][3]:
- **(a)** on-chain токен-владение (только tokenId + dataHashes);
- **(b)** off-chain зашифрованный blob-стор (метаданные/память);
- **(c)** механизм ре-шифрования: TEE ИЛИ proxy-re-encryption (PRE) ИЛИ ZKP;
- **(d)** verification-oracle, валидирующий transfer-proof до финализации.

Историческая справка: оригинальный iNFT — Alethea AI (2019-21, «Alice» на Sotheby's за $478K) [19], но это проприетарный протокол, не EIP. ERC-7007 (ORA) — про zkML-верификацию AI-генерации, другая задача [20]. ERC-7662 — ещё один agent-NFT-стандарт, тоже «шифруй off-chain, гейти владением» [31]. Все три — EVM, не TON.

---

## Находка 3 — TON: что даёт нативно, что строим сами (ВЫСОКАЯ достоверность)

**TON даёт нативно (прод-grade):**
- **(a) Токен-владение + transfer:** TEP-62 NFT (каждый item — свой контракт), обкатан на масштабе Telegram Gifts [23][34]. ✅
- **(b-указатель) off-chain метаданные:** TEP-64 off-chain layout (`0x01`+URI) [22]; TON DNS `dns_storage_address`→BagID [28]. NFT чисто указывает на off-chain данные агента. ✅
- **Ключи для off-chain крипты:** у каждого владельца Ed25519-кошелёк, конвертируемый в X25519 для ECDH/box-шифрования — тот же путь, что TonConnect и зашифрованные комментарии [29]. ✅

**TON НЕ даёт (строим off-chain сами):**
- ❌ Нет стандарта приватных/зашифрованных метаданных (TEP-62/64 молчат) [22].
- ❌ Нет mutable-on-transfer в ядре — нужен кастомный op контракта ИЛИ (чище) держать память off-chain, чтобы NFT не мутировал [24].
- ❌ **Нет on-chain шифрования, PRE, oracle/TEE** — TON-эквивалента инфраструктуры ре-шифрования ERC-7857 НЕТ. Весь шаг «ре-шифровать память на ключ покупателя при передаче» — **100% наш backend** [29][30].
- ❌ Нет managed зашифрованного blob-стора. **TON Storage хранит публичный-по-BagID blob** (шифруй сам перед загрузкой) [26][27], и его прод-готовность слабая (канонический блог 302-редиректит в Telegram-канал, нет зрелого JS/TS SDK) — **off-chain S3 надёжнее** [adversarial-3].

**Прецеденты на TON:** «Lobsters» (3,333 NFT-агента, «помнит и развивается») [32] — но память почти наверняка в централизованной off-chain БД, без описанного ре-шифрования. TON «Agentic Wallets» [33] — про право агента ТРАТИТЬ, не про передаваемую зашифрованную идентичность. Telegram Collectible Gifts — зрелые TON-NFT (TEP-62), но контент = фикс-арт, не зашифрованная память [34].

**Это означает:** если мы шипим «NFT=владение, память в нашей БД, ре-ключ при передаче» — мы **на уровне или впереди** TON-прецедентов. Но нельзя заявлять «on-chain зашифрованная память» — этого на TON никто доказуемо не делает.

---

## Находка 4 — 0G Storage как память агента: НЕ ГОДИТСЯ (скепсис подтверждён)

**Латентность vs маркетинг:** 0G заявляет «миллисекундный» KV, но SDK-гайд целит «<5 минут» на аплоад [4-A5], а вся категория меряется против 45-сек Filecoin [4-Fil]. Write-путь = on-chain commit + erasure-coding + proofs = blockchain-settlement, на порядки медленнее локального Postgres INSERT [4-A4]. Throughput (30 MB/s, 50 Gbps) — это потоковая пропускная для больших блобов, не латентность мелкой записи embedding [4-A2].

**Приватность DIY и хуже текущего:** децентрализованный сторадж публичен-по-умолчанию [36]; зашифрованная память требует client-side/TEE-шифрования + всё равно нет revocation/expiry [36]. У нас уже AES-256-GCM в Postgres — переход на 0G = больше движущихся частей.

**Нет TON-синергии:** нативного 0G↔TON моста нет (0G EVM, TON non-EVM); «мосты» — third-party свопы активов [37]. 0G был бы просто backend-SDK независимо от TON.

**Консенсус рынка:** ни один mainstream agent-memory-фреймворк (Mem0 — 20 backend'ов, включая pgvector) не имеет децентрализованного стораджа [40]; индустрия: горячие данные → S3/локальная БД, децентрализ → только холодные бэкапы [38][39].

**Вердикт:** держать горячую память на **Postgres+pgvector**; если понадобится дешёвый холодный blob-архив — сначала S3, и только потом думать о 0G/Filecoin/Arweave для genuinely-cold append-once артефактов.

---

## Находка 5 — Гранты + юр-фит (триангулировано)

**Гранты 0G (большие, но EVM):** $88.88M Ecosystem Program (явно «AI agents, iNFTs», $10K-$1M+) [12][41]; Guild on 0G $8.88M акселератор [41]; **Apollo $20M** (до $2M/команда + $200K Google Cloud, 10 команд, со Stanford+Privy) [42]; AIverse минтит агентов как ERC-7857-iNFT [13]. Заявка — hall.0g.ai / apollo.0g.ai.

**Гранты TON (наша дорога):** TON Champion grants — AI одна из 5 вертикалей («Agents... built on TON») [43]; **Mini App Migration Grant до $50K ad-credits** [44]; TON — эксклюзивный чейн Mini Apps с 21.02.2025 [45][46].

**Telegram ToS (ЖЁСТКОЕ правило):** Mini App может эмитить/распространять токены/NFT **только на TON**, **только TON-Connect**; ETH/SOL и форк TON-Connect = триггер де-листинга [46]. Цифровые товары — по интерпретации law-firm должны идти через Telegram Stars (Apple/Google IAP), но сам ToS Mini Apps этого дословно не мандатит [48][47] — серая зона, риск со стороны Apple/Google, не Telegram.

**259-ФЗ:** utility-цифровое-право (доступ к вещи/ИС/услуге) **явно выведено из ЦФА** [49]; в ЦФА/ценные бумаги затягивают денежные требования / права на ЦБ / участие в капитале [49]. Опасна **передаваемость+аппресиация**, не ярлык «NFT». С 2026 — штрафы за крипту-как-оплату (юрлица 700K-1M₽) → этим и оправдан foreign-entity [50].

**Казино-паттерн (доказан):** Virtuals VIRTUAL −90% ($5.07→$0.42), выручка $1.02M/день→<$500, новые агенты 1000/день→0, фрод BasisOS $500K [52]; Alethea ALI −97% за 2 года несмотря на продолжающуюся разработку [53]. Торгуемый токен НЕ забутстрапил спрос — он фронт-лоадил спекуляцию, ушедшую с ликвидностью.

---

## Synthesis & Insights

**Инсайт 1 — «iNFT» для нас = не токен, а механика владения+портативной памяти.** Ценная часть ERC-7857 — не «торгуй агентом», а «передай настроенного агента с его приватной памятью, не утекая секретов». Это ровно усиливает author-rent: автор может **продать готовый, «прожитый» экземпляр агента** за свою фикс-сумму (наш 0% cut), а покупатель получает рабочий агент + переходящую зашифрованную память. Никакого вторичного рынка, bonding-curve, плавающего токена.

**Инсайт 2 — мы уже почти всё имеем.** Наш стек = TEP-62-владение (через TON-инфру, которая уже на входе) + зашифрованный blob в S3 + backend, делающий ре-шифрование X25519-боксом при событии transfer. Блоки (a)+(b) — commodity; единственная новая работа — (c) ре-шифрование и (d) проверка, и оба — **один доверенный backend на зарубежном юрлице**, а не TEE-сеть. Это дешевле и проще, чем у 0G, и совместимо с Telegram (всё на TON).

**Инсайт 3 — 0G полезен ровно одним: грант, но он несовместим.** Деньги 0G заточены под ERC-7857-iNFT — но строить in-Mini-App-продукт на 0G/Ethereum нарушает TON-only Telegram-правило. Развязка: если хочется денег 0G — это **отдельный EVM-side R&D-трек на зарубежном юрлице** (вне Telegram-дистрибуции), не основной продукт. Для основного — гранты TON.

**Инсайт 4 — дисциплина против казино встроена в нашу же монетизацию.** Author-rent (фикс-сумма, 0% cut, payout в spendable-кредиты) — это уже non-speculative модель. «Передаваемый агент» должен наследовать ту же дисциплину: цена задаётся автором/владельцем, не рынком; «передача» рамкуется как дарение/продажа-вещи, не «инвестиция».

---

## Ограничения и оговорки (Counterevidence Register)

- **Статус ERC-7857 спорен** — рендер показал «Final», PR-label `s-draft` [16]. Трактуем как ранний/Draft single-ecosystem стандарт; перепроверить live-статус перед любым публичным заявлением.
- **Перф-цифры 0G — vendor-only**, независимых бенчмарков нет [6][10]. «AIverse live» — из PR, без адреса контракта [17].
- **TON Storage прод-готовность слабая** — канонический блог редиректит, нет зрелого SDK [26][27]; цитата про «wallet-key шифрует data» — из сниппета 2022, не переподтверждена на живой странице.
- **Stars-vs-крипта** — серая зона: мандат Stars — интерпретация app-store-политики, не дословный пункт Mini Apps ToS [47][48]. Риск Apple-driven; проверить Apple Guideline 3.1.1 напрямую.
- **Скептические источники тонкие** — по «казино» силён Decrypt/Virtuals [52], по ERC-7857-критике один forum-источник [21]; цены ALI частично из forecast-агрегаторов [53] (тренд надёжен, точные числа мягкие).
- **Инструменты:** Exa (400) и Firecrawl (404) частично падали; часть цитат — из search-снippets, не переfetch'нутых страниц (credibility помечена у агентов).

---

## Рекомендации

**Немедленно (без новых решений основателя):**
1. **0G как чейн/сторадж/iNFT-on-0G — НЕ внедрять** в основной TMA-продукт (несовместим с Telegram TON-only [46]; токен-риск [5]; сторадж не для горячей памяти [40]). Память агента остаётся на **pgvector** — менять нечего.
2. **Зафиксировать в каноне новый жёсткий факт:** Telegram blockchain guidelines = TON-only/TON-Connect-only для любых токенов/NFT в Mini App [46]. Это меняет любые «мульти-чейн wallet UI» планы — добавить в `/SECURITY.md` или `/CLAUDE.md`.

**Требуют решения основателя (продукт/деньги/бренд):**
3. **Делаем ли «передаваемого агента» на TON вообще?** Рекомендация: ДА, но строго как **non-speculative «передать/подарить настроенный агент»** (TEP-62 NFT владения + S3-зашифрованная память + backend-ре-шифрование), цена = фикс-сумма автора/владельца (наследует author-rent, 0% cut), **без вторичного рынка как фичи, без bonding-curve**. Это усиливает author-rent и НЕ воскрешает удалённый спекулятивный NFT. Юр-якорь: держать как **utility-право доступа** (вне ЦФА [49]), на зарубежном юрлице.
4. **Грант 0G ($1M+/Apollo $2M)** — преследовать ТОЛЬКО как отдельный EVM-R&D-трек на foreign-entity (не in-Telegram-продукт), иначе ломает TON-совместимость [42][46]. Альтернатива по нашей дороге: **гранты TON** (AI-вертикаль [43] + $50K migration ad-credits [44]) — выровнены с продуктом.

**Дальнейший ресёрч (если трек «передаваемый агент» одобрен):**
5. Спайк: proxy-re-encryption (Umbral/NuCypher-style) на X25519 vs простой backend-decrypt→re-encrypt — выбрать модель доверия (c). Проверить TEP-62 «editable NFT» op vs «память целиком off-chain».
6. Юр-заключение РФ-юриста: «передаваемый агент за фикс-сумму» как УЦП/utility vs ЦФА; и Apple 3.1.1 по крипта-кредитам за цифровой товар внутри iOS-клиента.

---

## Bibliography

[1] Gate Learn — Breaking Down 0G's Four-Layer Architecture, 2025 — https://www.gate.com/learn/articles/0g-four-layer-architecture-chain-storage-da-compute-ai
[2] 0G Labs — 0g-storage-node log-system docs, 2025 — https://github.com/0glabs/0g-storage-node/blob/main/docs/log-system.md
[3] Chainwire — 0G Labs Launches Aristotle Mainnet, 2025-09-22 — https://chainwire.org/2025/09/22/0g-labs-launches-aristotle-mainnet-with-largest-day-one-ecosystem-for-decentralized-ai/
[4] DefiLlama — 0G chain TVL/Fees, 2026 — https://defillama.com/chain/0g
[5] OurCryptoTalk — 0G (Zero Gravity) Review 2026 — https://ourcryptotalk.com/crypto-review/0g-zero-gravity-review
[6] 0G Documentation — 0G Storage, 2026 — https://docs.0g.ai/0g-storage
[7] 0G Documentation — Storage SDK, 2026 — https://docs.0g.ai/developer-hub/building-on-0g/storage/sdk
[8] 0G Documentation — Compute Inference, 2026 — https://docs.0g.ai/developer-hub/building-on-0g/compute-network/inference
[9] GlobeNewswire — 0G Introduces Sealed Inference, 2026-03-06 — https://www.globenewswire.com/news-release/2026/03/06/3250768/0/en/0G-Introduces-Sealed-Inference
[10] 0G blog — 0G's Data Availability Layer, 2025 — https://0g.ai/blog/0g-s-data-availability-layer
[11] WuBlockchain — Heated AMA Debate: 0G Team Responds, 2025 — https://wublockchain.medium.com/heated-ama-debate-0g-team-responds-to-allegations-of-cfx-soft-rug-overvaluation-and-token-ea7a9c58f848
[12] Chainwire — 0G Foundation $88.88M Ecosystem Growth Program, 2025-02-05 — https://chainwire.org/2025/02/05/0g-foundation-announces-88-88m-ecosystem-growth-program-to-accelerate-ai-agent-creation/
[13] 0G Foundation — Ecosystem, 2026 — https://www.0gfoundation.ai/ecosystem
[14] Ethereum — ERC-7857: AI Agents NFT with Private Metadata, 2025-01-02 — https://eips.ethereum.org/EIPS/eip-7857
[15] 0G blog — Introducing ERC-7857, 2025-01-17 — https://0g.ai/blog/0g-introducing-erc-7857
[16] GitHub — ethereum/ERCs PR #824, 2025-06-16 — https://github.com/ethereum/ERCs/pull/824
[17] ITBusinessNet — 0G & AIverse Web 4.0 Marketplace, 2026-03-04 — https://itbusinessnet.com/2026/03/decentralized-ai-company-0g-and-aiverse-introduce-the-first-web-4-0-marketplace-where-ai-agents-own-trade-and-evolve-on-chain/
[18] 0G Documentation — ERC-7857 Standard, 2026 — https://docs.0g.ai/developer-hub/building-on-0g/inft/erc7857
[19] Messari — Alethea AI: Fusing Intelligence into NFTs, 2021 — https://messari.io/report/alethea-ai-intelligent-nfts
[20] Ethereum — ERC-7007: Verifiable AI-Generated Content Token — https://github.com/ethereum/ercs/blob/master/ERCS/erc-7007.md
[21] BlockEden Forum — ERC-7857: Opportunity or IP Pandora's Box?, 2025 — https://blockeden.xyz/forum/t/erc-7857-when-ai-models-become-tradeable-nfts-a-billion-dollar-opportunity-or-an-ip-pandoras-box/846
[22] TON — TEP-64 Token Data Standard — https://github.com/ton-blockchain/TEPs/blob/master/text/0064-token-data-standard.md
[23] TON — TEP-62 NFT Standard — https://raw.githubusercontent.com/ton-blockchain/TEPs/master/text/0062-nft-standard.md
[24] TON Docs — NFT reference implementation — https://docs.ton.org/standard/tokens/nft/nft-reference
[25] TON — What is NFT 2.0 — https://ton.org/en/what-is-nft-2-0
[26] TON Docs — TON Storage — https://docs.ton.org/blockchain-basics/primitives/web3/ton-storage
[27] TON blog — TON Storage, 2022-12-29 — https://blog.ton.org/ton-storage
[28] TON Docs — TON DNS — https://docs.ton.org/blockchain-basics/primitives/web3/ton-dns
[29] Tonkeeper — TonConnect Specification — https://github.com/tonkeeper/ton-connect/blob/main/TonConnectSpecification.md
[30] Sam17-Labs — SamEncrypt (PRE over Ed25519) — https://github.com/Sam17-Labs/SamEncrypt
[31] Ethereum — ERC-7662: AI Agent NFTs — https://eips.ethereum.org/EIPS/eip-7662
[32] GetGems — Lobsters launchpad, 2025-26 — https://getgems.io/launchpad/lobsters
[33] Crypto Briefing — TON launches Agentic Wallets, 2026 — https://cryptobriefing.com/agentic-wallets-launch-ton-telegram/
[34] Telegram blog — Wear Collectible Gifts, Move Gifts to Blockchain, 2025 — https://telegram.org/blog/wear-gifts-blockchain-and-more
[35] 0G blog — Decentralized Storage: 0G vs Filecoin/Arweave, 2025 — https://0g.ai/blog/0g-storage-vs-filecoin-arweave
[36] Oasis — Decentralized Storage: Encryption & Access Management, 2025 — https://oasis.net/blog/storage-encryption-access-management
[37] XSwap (X) — 0G cross-chain via Chainlink CCIP, 2025-09 — https://x.com/xswap_link/status/1971223983463838189
[38] DoHost — Hybrid Stack: Object Storage Hot + IPFS Cold, 2026-05-10 — https://dohost.us/index.php/2026/05/10/the-hybrid-stack-using-object-storage-for-hot-data-and-ipfs-for-cold-backups/
[39] ACM IWQoS — Understanding I/O performance of IPFS storage, 2019 — https://dl.acm.org/doi/10.1145/3326285.3329052
[40] Mem0 — State of AI Agent Memory 2026 — https://mem0.ai/blog/state-of-ai-agent-memory-2026
[41] 0G blog — $88.88M Ecosystem Program / Guild on 0G, 2025-02-05 — https://0g.ai/blog/0g-ecosystem-program
[42] GlobeNewswire — 0G & Stanford Launch $20M Apollo AI Accelerator, 2026-02-27 — https://www.globenewswire.com/news-release/2026/02/27/3246238/0/en/0G-and-Stanford-Blockchain-Veterans-Launch-20M-Apollo-AI-Accelerator.html
[43] TON — Champion Grants / priority verticals, 2025 — https://ton.org/en/ton-grants
[44] TON (X) — Mini App Migration Grant (up to $50K ad credits), 2025-02-10 — https://x.com/ton_blockchain/status/1889245387250417666
[45] TON blog — TON–Telegram exclusive partnership, 2025 — https://blog.ton.org/ton-telegram-exclusive-partnership-2025
[46] Telegram — Blockchain Guidelines (TON-only, TON-Connect-only), 2025-02-21 — https://core.telegram.org/bots/blockchain-guidelines
[47] Telegram — Terms of Service for Mini Apps, 2025 — https://telegram.org/tos/mini-apps
[48] Aurum — Telegram Mini App Legal Checklist 2025 — https://aurum.law/newsroom/Telegram-Mini-App-Legal-Checklist-in-2025
[49] КонсультантПлюс — 259-ФЗ (ред. 2025-12-15) — https://www.consultant.ru/document/cons_doc_LAW_358753/
[50] Известия — штрафы за оплату криптой с 2026 — https://iz.ru/en/node/1922846
[51] Harant.ru — NFT и смарт-контракты в 2026: правовой гид — https://harant.ru/blog/grazhdanskoe-pravo/legalizacziya-czifrovyh-aktivov-yuridicheskie-aspekty-nft-i-smart-kontraktov-v-2026-godu-ot-yurista/
[52] Decrypt — Virtuals Protocol Revenue Crashes, 2025 — https://decrypt.co/309495/virtuals-protocol-revenue-crashes-as-ai-agent-demand-sinks
[53] Messari — Alethea AI project (ALI price history), 2026 — https://messari.io/project/alethea-ai

## Methodology Appendix

5 параллельных суб-агентов: (1) 0G-архитектура/зрелость/грант; (2) ERC-7857-механизм/история iNFT; (3) TON-возможности для iNFT; (4) 0G-storage vs pgvector + мост; (5) гранты + юр-фит/казино-паттерн. Каждый — web-поиск с structured JSON {claim, evidence_quote, source_url, source_date, credibility} + adversarial-нота. Триангуляция: 0G-mainnet/токен-крах (≥3 источника: [3][4][5]), ERC-7857-механизм (первичный EIP [14] + автор-блог [15]), TON-gap (первичные TEP [22][23] + docs [24][26][28][29]), 0G-storage-непригодность ([40] + [38][39] + vendor [35]), Telegram-TON-only ([46] первичный + [45]), казино ([52] первичный Decrypt). Первичные источники (EIP/TEP/статуты/docs) отделены от vendor-PR и practitioner-блогов; статус ERC-7857 и прод-готовность TON Storage помечены как неразрешённые.
