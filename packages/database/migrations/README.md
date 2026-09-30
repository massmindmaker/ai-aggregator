# Migration ownership after repository extraction

This directory is an ordered record of migrations historically applied from the combined repository. Do not delete, rename, reorder or reset these files, even when the active application owner has moved.

- Aggregator gateway, payments, organizations, models and provider routing remain owned here.
- Historical `tg_*`, agent, template, membership, TON and transfer migrations belong to Agents Market for future changes. Active code is `/home/bob/Projects/agents-market`.
- Historical contest, submission, evaluation and prize migrations belong to AI Arena for future changes. Active code is `/home/bob/Projects/aiarena`. Since 2026-09-30 the contest application code has also left this repository; the corresponding tables (`contests`, `contest_participants`, `contest_submissions`, `evaluations`, `evaluator_scripts`, `prize_awards`) were removed from the Drizzle schema but are intentionally **left in the database as dead tables**, because `0014_contest_marketplace.sql` created the FK `models.derived_from_contest_id -> contests(id)`. Dropping them is a separate decision for the Arena side, to be taken with a dump in hand. Author earnings, payouts and KYC migrations are NOT contest migrations and remain owned here.
- Some later migrations deliberately bridge product boundaries, such as the Agents Market gateway organization. Preserve them as integration history; do not use their location as an ownership signal.

The current Drizzle schema is not a complete representation of every historically applied table. `db:push` and automated production migration remain prohibited until schema parity and a migration baseline are established.
