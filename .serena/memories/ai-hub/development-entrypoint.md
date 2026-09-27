# Historical navigation snapshot — as of 2026-09-13

The evidence block below is preserved verbatim as historical context from 13.09.2026. Its unqualified acceptance/review states are superseded for current continuation and must not be read as the current Aggregator checkpoint. Start current work from the section `Accepted durable-batches navigation refresh — 2026-09-28`, then verify `docs/DEVELOPMENT-ENTRYPOINT.md`, `docs/product/acceptance/AG-P1.md`, `docs/product/acceptance/AG-P1-route-coverage.md`, the applicable owner plan, and current git.

Canonical priority handoff: docs/consolidation/2026-09-13-aggregator-only-handoff.md (snapshot b4f22c1). Continue only AI Aggregator; AI Arena and Agents Market remain paused.

Accepted checkpoint: root 0cc6d95. Recovery pure Task1 a8a297f+6355185+ee2332b (root 0aeb0bc) is independently approved; it is a pure loop only. Recovery Task2 remains uncommitted partial WIP/static-only; native evidence and activation are not accepted.

BYOK legacy completions defect e5614e2 is accepted by 0cc6d95 with local route→real-adapter→mock-transport proof. The route remains non-admitted and restricted mode returns 501; registry coupling is unchanged.

Catalog Task2 78f7e38+665a43b is under re-review, not accepted. TON continuation 522ac7c+5a39f64 is under design re-review, not accepted. Native TON adapter 76ff70c remains accepted only for historical native fixture verification; full jetton, Tasks3-6, runtime and settlement are open. Testnet budget is 20/20; no further RPC is in scope.

Read owner plans, acceptance and git before work. This locator is navigation only, not production, runtime, database, or full-index acceptance.

## Accepted durable-batches navigation refresh — 2026-09-28

Canonical accepted product source is `b949c8069d62425f9e0e3fe7586105265c958a34` in `/home/bob/Projects/ai-aggregator/.worktrees/durable-batches-20260927`. Durable batches are locally accepted only in explicit mode `stored_chat_embeddings_completions_stream_media_batches`: atomic per-item holds before 202, ID-only BullMQ payload, pinned provider/price, one-dispatch settlement, saved durable evidence, and recovery after lost ACK/crash without a second provider call. The exact checks and limits are recorded in `docs/product/acceptance/AG-P1.md`, `docs/product/acceptance/AG-P1-route-coverage.md`, and `docs/superpowers/plans/2026-09-27-durable-batch-lifecycle-implementation.md`.

The public/default runtime remains `legacy`. Production, paid provider calls and release activation were not performed. The next Aggregator checkpoints are AG-P2 (AG→AM catalog/receipt HTTP consumer without direct Aggregator SQL in Market) and AG-P3 (immutable author version → usage/sale → earnings/refund evidence).

Derived Graphify navigation was rebuilt AST-only under the shared lock from a clean `b949c80` snapshot: 12060 nodes / 20072 links; the tool reported 778 communities. This index is navigation, not additional acceptance or production evidence. Read current owner docs and git before continuation.
