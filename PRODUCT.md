# AI Aggregator product contract

AI Aggregator gives Russian-speaking teams and developers one web account and an OpenAI-compatible API for discovering and using AI models and algorithms.

## Users and core journeys

- A customer compares models, buys a ruble subscription or top-up, creates an organization key and makes billed API calls.
- A business controls keys, limits and usage for its organization.
- An author submits a model or algorithm and follows moderation, usage and payout status.
- An operator manages catalog, providers, payments, moderation and service health.

## Product boundary

The active product consists of the Next.js web app, API gateway, Aggregator async worker and their shared packages. Billing is in rubles through Aggregator payment providers and organization credit ledgers.

Agent templates, Telegram Mini App flows, crypto membership and agent execution belong to `/home/bob/Projects/agents-market`. Contests, evaluations, battles and prizes belong to `/home/bob/Projects/aiarena`.

The current web app and `apps/worker` still contain historical contest and marketplace surfaces. They remain only until audited extraction. UI or docs must not present those retained paths as proof that Aggregator owns the other products.

## Product truth

- Money flow is payment -> guarded settlement -> organization credits -> paid gateway usage.
- Provider and refund unification is pending dedicated P0 work; this extraction does not claim it complete.
- Operational acceptance requires isolated tests plus deployment evidence. A local build alone is not a production acceptance result.
- Prices come from the pricing contract, and upstream brands stay out of customer-facing errors.
