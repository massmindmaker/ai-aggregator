<!-- Generated 2026-06-02 by product-coherence-map workflow (wf_3b3e56ba-787). Owner-level map: promise vs reality vs mockups. -->

# AIAG — What's Real vs What We Promise (Plain-Language Map)

## 1. What the product actually does today

Today AIAG is a small Telegram mini-app with four tabs (Agents, NFT, Market, Profile). A person can make an AI helper three quick ways aren't all there yet — really it's pick-a-ready-template or fill-a-short-form — then talk to it and see its past answers (the chat updates by refreshing every second or two, not by streaming live). Each helper can use four built-in abilities: web search, a calculator, image generation, and a simple memory. The user keeps a balance in rubles, tops it up by paying with a TON crypto wallet, and every run charges that balance — UNLESS they plugged in their own AI account, in which case we charge them nothing and they pay their own provider. People can also browse a list of ~73 AI models and mint a collectible NFT. Logins are properly verified. That's the whole live product. Everything fancier — a real "Hermes" cloud brain, a tools/skills store, a multi-provider picker, scheduled tasks, posting into your Telegram channels — is written up in specs and drawn in mockups, but is not built.

## 2. Feature reality table

| Feature | Promised? | Works today? | Mockup? |
|---|---|---|---|
| Make an agent (template / form) | Yes | ✅ works | ✅ matches |
| "Describe it in words" AI builder | Yes | ⛔ not built | 🟡 old (drawn) |
| Run agent + see history | Yes | ✅ works (refresh, not live stream) | 🟡 old (shows live streaming) |
| Charge for our model (commission via our system) | Yes | ✅ works (see §4 caveat) | 🟡 old (shows USDT not ₽) |
| Bring your own AI key (no commission) | Yes | ✅ works (single "Свой агент" field) | 🟡 old (shows fancy provider picker) |
| Model catalog (~73 models, browse) | Yes | ✅ works (browse only) | 🟡 old |
| Multi-provider picker (OpenAI/Anthropic/OpenRouter per agent) | Yes | ⛔ not built (DB-only stub) | 🟡 old |
| Tools / Skills / MCP store | Yes | ⛔ not built (only 4 fixed tools) | 🟡 old |
| "Hermes" managed cloud brain (memory/cron/swarm) | Yes (tagged R&D) | ⛔ not built (just a model name) | 🟡 old (looks like a real dashboard) |
| Tasks board / scheduled / keyword triggers | Yes (claimed live) | ⛔ not built | 🟡 old |
| Post agent into your Telegram channels/groups | Yes | ⛔ not built | 🟡 old |
| RUB balance + top-up via TON | Yes | ✅ works | 🟡 old (shows USDT) |
| NFT mint via Startonus/TON | Yes | ✅ works | ✅ matches |
| Hardened login | Yes | ✅ works | n/a |

## 3. Discrepancies that could embarrass us

- **"Hermes" looks like a product but isn't one.** Mockups show a cloud "Hermes" with CPU/memory/sub-agents/swarm; in reality "Hermes" is just the name of the default model we call. → **Say this instead:** drop the word "Hermes" from anything a user sees; call it "your agent." **Hide for now:** the runtime-dashboard, swarm, and "spin up your cloud brain" screens until built.
- **Tools / Skills / MCP "marketplace."** We imply a store of installable skills and external tools. Reality: four fixed checkboxes (web search, calc, image, memory). → **Say this instead:** "Your agent has built-in tools: web search, calculator, image generation, memory." **Build later:** the store. **Hide for now:** the skills/MCP/tool-broker store screens.
- **Chat "streams" live.** Mockup shows live typing; product shows a list that refreshes. → **Build this (small):** real streaming, or **say** "answers appear when ready" and remove the blinking-cursor mockup.
- **Telegram deploy ("your agent works in your channels").** Fully drawn, zero code. → **Hide for now**; it's a headline promise with nothing behind it.
- **Scheduled tasks / kanban board.** Claimed as live in one spec; not built. → **Say:** "coming soon," remove from "live" lists.
- **Currency everywhere is wrong.** Every mockup shows USDT/TON/$; the product charges in **rubles (₽)**. → **Build/redraw:** make all mockups show ₽ — this is the single biggest mismatch and it's right in the money area the owner worries about.
- **Multi-provider picker + Gonka.** Drawn as polished chip-pickers; only a single raw "your URL + key" field exists, Gonka is nowhere. → **Hide Gonka**; **say** the BYOK field is the real "bring your own" path for now.

## 4. The commission question

**The code matches your rule for both live paths.** When the agent uses a model WE supply → we charge the user (commission taken). When the user connects their OWN account/key → we charge them **zero**, they pay their provider. Correct.

**One caveat to know (not user-facing):** our commission is currently calculated by a fixed price table inside the worker, not by the gateway's smarter markup, and if the gateway key is off, our-model runs go straight to OpenRouter (still charged, but our branding isn't hidden). It works and bills correctly; it's just simpler than the spec.

**The ONE decision you must make:** there's a half-built third path — *"pick a provider from OUR catalog, but pay with YOUR own key."* The code currently treats this as **billable (commission charged)**, which contradicts your rule. It's harmless today because nothing can reach it (no screen wires it up). **Decide before any provider-catalog screen ships:** if the user brings their own key → it must be **free (bring-your-own, no commission)**. If you instead want a small flat fee for the convenience of using our catalog, say so and we'll set a fixed fee — but it cannot silently charge full commission.

## 5. Core vs Defer

**Build now (to match the promise that's already live-facing):**
- Fix the currency in mockups to ₽ (and confirm one money unit everywhere).
- Wire the commission so our-model runs always pass through our own system (capture the markup reliably).
- Decide + correct the "catalog + your-own-key" billing branch (see §4).
- Real (or honestly-labeled) chat streaming.
- Make dead links real: agent author profile, "clone this agent."

**Safe to defer (and remove/label in copy + mockups):**
- "Hermes" cloud runtime, swarm, sub-agents, self-improving skills.
- Tools/Skills/MCP store and Tool Broker (Firecrawl).
- Telegram channel/group/Business deploy.
- Tasks kanban, scheduled & keyword triggers.
- Gonka, x402 micropayments, Telegram Stars.
- The whole manifesto puzzle/ARG (separate website, not the mini-app).

## 6. Mockups to draw or fix

- **Redraw all balance/budget/spend screens in ₽** (every one currently shows USDT/TON). Top priority.
- **Update the BYOK screen** to match reality: one "your endpoint URL + key + test" field — not the multi-chip picker — and clearly mark "no commission, you pay your provider."
- **Update agent-chat mockup** to match the refresh-style history (or build streaming first, then keep the live mockup).
- **Add a clear "R&D / not built yet" banner** to the Hermes-dashboard, swarm, tools-store, skills-store, MCP, Gonka, Telegram-deploy, and kanban artboards so nobody reads them as done.
- **Draw the missing real screens** that exist in product but not cleanly in mockups: agent author profile, "clone agent," low-balance warning, failed-payment/insufficient-funds states.
- Leave the older web/admin/contest mockups (Obsidian vault) labeled "unverified — older web product," since this pass only checked the Telegram app.

---

## Recommended next action (3 steps)

1. **Make a "honest labels" pass first (cheap, high-impact):** add "coming soon / in development" tags to every unbuilt screen (Hermes, tools/skills, MCP, Telegram-deploy, Gonka, kanban) and strip the word "Hermes" from user-facing copy. This removes the embarrassment risk in a day.
2. **Decide the one billing question in §4** ("catalog provider + your own key" = free or small flat fee?) so the half-built path can't ever charge wrongly — then fix that one line of code accordingly.
3. **Fix the currency everywhere to ₽** (mockups and any remaining USDT labels), and finish wiring our-model runs through our own system so the commission you're owed is reliably captured.

Everything your product *declares as live today* — make an agent, run it, bring your own key for free, pay in rubles via TON, mint an NFT, secure login — genuinely works and matches your rule. The risk is purely the gap between the ambitious mockups/specs and the simpler live app; the three steps above close that gap without building anything heavy.