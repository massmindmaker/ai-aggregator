# TON wallet and checkout implementation plan

Spec: ../specs/2026-09-29-ton-wallet-checkout-design.md
Execution: inline implementation with independent SpaceBunny design/source reviews; continuous approved roadmap. One heavy test/build at a time. No production/paid execution.

1. [ ] Pure wallet proof contract and independent signatures RED/GREEN. Known code/address/publickey, boundedBoC, precise timestamp and domain/nonce.
2. [ ] Add immutable challenge/credential/ticket schema and native state-machine regressions: issue/verify/link/login/unlink/replay/revoke, current auth and cookies preserved.
3. [ ] Implement guarded Web routes + optional NextAuth wallet login with fresh credential validation; actual native HTTP and unchanged email auth tests.
4. [ ] Server checkout package/quote and one owned canonical invoice perintent, dispatch once/advisory state no credit; nativefinancial regressions.
5. [ ] Optional TonConnect UI + manifest + wallet/security/login/billing; browser/unit flows and exact amounts, no duplicate sends.
6. [ ] Source security/financial/TypeScript review; fix concretefindings through RED/GREEN; final focusednative, typesbuilds, wholeunit and browser acceptance. Sourcecommit then evidence; proceed remainingAGmodalities/release, not prematureArena.
