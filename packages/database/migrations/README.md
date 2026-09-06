# Migration ownership after repository extraction

This directory is an ordered record of migrations historically applied from the combined repository. Do not delete, rename, reorder or reset these files, even when the active application owner has moved.

- Aggregator gateway, payments, organizations, models and provider routing remain owned here.
- Historical `tg_*`, agent, template, membership, TON and transfer migrations belong to Agents Market for future changes. Active code is `/home/bob/Projects/agents-market`.
- Historical contest, submission, evaluation and prize migrations belong to AI Arena for future changes. Active code is `/home/bob/Projects/aiarena`.
- Some later migrations deliberately bridge product boundaries, such as the Agents Market gateway organization. Preserve them as integration history; do not use their location as an ownership signal.

The current Drizzle schema is not a complete representation of every historically applied table. `db:push` and automated production migration remain prohibited until schema parity and a migration baseline are established.
