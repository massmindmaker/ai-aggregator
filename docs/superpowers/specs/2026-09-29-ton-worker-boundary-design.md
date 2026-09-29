# TON worker-only PostgreSQL execution boundary

Date29.09.2026; base2b83fa6. Scope is the next Aggregator AG-4 acceptance gate, before external payments or Arena work.

## Accepted intent and constraints

User approved autonomous continuation of the complete Aggregator roadmap followed by Arena. Implement a real least-privilege local role candidate, not another diagnostic-only milestone. Keep existing monetary SQL and historical migrations unchanged; do not provision production credentials/roles, change balances outside disposable tests, enable mainnet or deploy.

## Design

Four distinct, precreated roles: Web LOGIN, API LOGIN, TON worker LOGIN and wrapper owner NOLOGIN. None owns existing product tables or has elevated attributes/membership. The installer owns a new bounded connection (never a borrowed caller transaction) and verifies actual connected disposable test identity, complete role separation, existing ACL safety and exact source/signature/security/trigger identities. No extra trigger on the five modified monetary tables is accepted. It refuses preexisting aiag_ton_worker schema, unexpected grants, missing/changed objects or unsafe PUBLIC/schema/default capabilities before privilege changes.

New fixed schema aiag_ton_worker belongs to the trusted migration principal. A narrow settle_invoice_v1(uuid,jsonb) SECURITY DEFINER wrapper belongs to the non-login owner. Its body checks session_user against the exact installed worker role and calls qualified public.aiag_settle_ton_invoice_v1. Explicit search_path=pg_catalog,public,pg_temp; PUBLIC execute revoked before commit. Only owner can execute core and has minimal necessary insert/update/read rights; worker receives wrapper EXECUTE, no direct writes/core permission. Deferred consistency triggers run at transaction completion and may need narrow SELECT and validation-helper execution; native tests decide the exact grants, not speculation. App principals cannot create shadow objects in trusted schemas or SET ROLE/SESSION AUTHORIZATION to owner.

The worker authority is trusted to submit verified chain evidence. This wrapper does not independently verify TON consensus and must never be callable by Web/API. Existing pure verifier and observed evidence remain required. Source attestations prevent accidentally granting authority to rewritten financial/trigger code. No role password is created or printed by implementation.

## Runtime client

Add a server-only settlement client that uses a dedicated URL and declared worker identity, checks connected session_user/current_user, calls only the restricted wrapper and reuses bounded database transactions. Keep ordinary public database exports free of settlement. Existing observe-only startup remains unchanged until deployed role/credential separation is explicitly accepted; tests exercise the real production-capable internal client through actual worker login. No test fixture may use administrator to execute the accepted positive settlement path.

## Acceptance

- Native actual Web/API/worker logins and exact non-login wrapper owner; successful worker settle, identical receipt replay, concurrent same invoice, one ledger credit.
- App and worker direct core execution and protected table/column DML fail; cross-role/SESSION AUTHORIZATION denied; app inheriting worker EXECUTE still blocked by session_user.
- Temporary-schema objects cannot redirect accesses; untrusted public schema creation denied.
- Rollback after successful function return leaves no event/receipt/balance; dropped ACK/reconnect returns existing receipt.
- Installer atomicity: unexpected schema/roles/grants/function body or trigger replacement refuses with no partial grants. Wrong/local-unmarked connection refuses before DDL.
- Deferred trigger checks remain enabled; no SET CONSTRAINTS or historical SQL edits to avoid failures.
- Private keys/customer records never appear in logs, reviews or docs. Native fixture owns and cleans all random roles/connections/database.

## Explicit limits

This is a deployable source candidate plus local rehearsal, not evidence of production role separation or real payment acceptance. The shared legacy Web/API credentials must not be relabeled secure without changing deployment. Existing diagnostic always returns runtimeSettlementAllowed=false; it is not overwritten by this acceptance.
