# TON wallet and checkout implementation plan

Spec: ../specs/2026-09-29-ton-wallet-checkout-design.md
Execution: inline implementation with independent SpaceBunny design/source reviews; continuous approved roadmap. One heavy test/build at a time. No production/paid execution.

**Статус на 30.09.2026:** пункты 1–5 реализованы локально и закоммичены (`bc721b5`).
Пункт 6 выполнен частично: source commit и typecheck есть, независимое ревью, полный
unit-прогон после этих коммитов, browser acceptance и машинночитаемый evidence — нет.
Все три модели Codex на cooldown до 04.10, ревью ведётся через Space Bunny Alpha.
Runtime settlement остаётся выключенным, testnet/mainnet не затрагивались.

1. [x] Pure wallet proof contract and independent signatures RED/GREEN. Known code/address/publickey, boundedBoC, precise timestamp and domain/nonce. — `packages/shared/src/ton-wallet-proof.ts` + тесты.
2. [x] Add immutable challenge/credential/ticket schema and native state-machine regressions: issue/verify/link/login/unlink/replay/revoke, current auth and cookies preserved. — миграция `0091`, `packages/database/src/ton-wallet-auth.ts`, native-тесты.
3. [x] Implement guarded Web routes + optional NextAuth wallet login with fresh credential validation; actual native HTTP and unchanged email auth tests. — `apps/web/src/app/api/ton/**`, `auth.ts`, `login/page.tsx`, `ton-wallet-http.test.ts`, `ton-wallet-nextauth.test.ts`.
4. [x] Server checkout package/quote and one owned canonical invoice per intent, dispatch once/advisory state no credit; native financial regressions. — миграция `0092`, `packages/database/src/ton-wallet-checkout.ts`, `ton-checkout-http.test.ts`, `ton-wallet-checkout.native.integration.test.ts`.
5. [x] Optional TonConnect UI + manifest + wallet/security/login/billing; browser/unit flows and exact amounts, no duplicate sends. — `components/ton/`, `lib/ton-wallet/` (включая send-once), `tonconnect-manifest.json`, `dashboard/billing/page.tsx`, `ton-wallet-panel.test.tsx`, `ton-wallet-send.test.ts`.
6. [ ] Source security/financial/TypeScript review; fix concrete findings through RED/GREEN; final focused native, types builds, whole unit and browser acceptance. Source commit then evidence; proceed remaining AG modalities/release, not premature Arena.

   Выполнено в пункте 6: source commit `bc721b5`; strict `tsc --noEmit` exit0 для gateway,
   shared, database, worker и web; focused unit-наборы зелёные. **Не выполнено:** независимое
   ревью, полный unit-прогон после этих коммитов, browser acceptance кошелька,
   машинночитаемый evidence. Не считается закрытым.

## Остаток до включения в состав v1

- [ ] Независимое security/financial review волны.
- [ ] Browser acceptance кошелька и checkout (настоящие формы, реальные регистрация/вход).
- [ ] Внешний testnet/mainnet и реальные выплаты — отдельный release gate владельца.
- [ ] Перевод Web/API на worker-роли в развёрнутом сервисе (сейчас только локальный стенд).
