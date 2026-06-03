<!-- Generated 2026-06-02, workflow wf_625ef75e-535 -->

# Hermes Agent — UIs that exist, and where TMA fits

*Plain-language synthesis for the owner. Today is 2026-06-02. Hermes Agent verified at v0.15.2.*

---

## 1. What UIs already exist for Hermes

**The official one (ships with Hermes):**
- **Hermes Dashboard** — a built-in web control panel you launch with `hermes dashboard` (opens on your own machine). It's an *operator's console*: chat, edit settings, manage skills/tools/schedules, see token-and-cost analytics, connect messaging channels. Single-user, runs on your computer. Not a polished chat product, not a marketplace.

**Community / open-source ones (a busy ecosystem):**
- **nesquena/hermes-webui** — the closest thing to "daily-driver chat from your phone"; mobile-friendly, passkey login. Single user.
- **outsourc-e/hermes-workspace** — the "most complete" GUI; chat + terminal + multi-agent orchestration.
- **EKKOLearnAI/hermes-web-ui** — streaming chat + cost analytics + channel config, one-command install.
- **mission-control / Hermes Control Interface** — fleet/team management with permissions (the only ones that gesture at multi-user).
- A dozen more (read-only dashboards, single-file glassmorphic UIs, desktop apps for Mac/Windows).

**Built-in chat bridges (you do NOT build these — Hermes has them):**
- Hermes natively connects to ~22 messaging platforms from one process: **Telegram, Discord, Slack, WhatsApp, Signal, Email, SMS** and more. So Hermes *already is a Telegram bot* out of the box.

**The honest gap that justifies TMA:**
Every UI above is a **single-operator tool you run on your own machine**, and the Telegram bridge is just chat. **Nobody offers a hosted, multi-user product with a marketplace of ready-made agent templates, a choice of paid models with our own ₽ billing, and a tool market.** That open space is exactly what TMA is for.

---

## 2. Where TMA fits

**Position TMA as: "the friendly, hosted web-UI for Hermes that lives inside Telegram — plus a marketplace of ready-made agents, models, and tools."**

What TMA should offer that bare Hermes does not:
- **Templates** — browse and one-tap clone proven agent setups (a "marketing assistant," a "research bot"), instead of hand-editing 150+ config fields in a localhost console.
- **₽ billing with markup** — our :4000 gateway acts as one model provider users can pay for in roubles, with our margin baked in. The open-source UIs assume you bring your own keys and make zero money.
- **Provider choice** — users pick our models, Gonka, their own Hermes, or bring-your-own keys — all behind one friendly picker.
- **Tool market** — agents buy tools, paid per-use. Completely absent everywhere else.
- **Hosted & multi-user** — no install, works on a phone, inside Telegram. The official dashboard and almost all community UIs are localhost, single-person.

**What we borrow (so Hermes users feel at home):** the same vocabulary the ecosystem standardized on — Sessions, Skills, Tools, MCP servers, Cron/schedules, cost analytics, memory. And we connect to a user's own Hermes through its standard "OpenAI-compatible" address (`http://their-host:8642/v1`), the universal plug everything uses.

---

## 3. What an agent is made of (the "spec")

An agent is **not** one file or one model — it's a *composition*. The parts:

- **Persona / identity** — a written "soul" (the `SOUL.md` file) plus named personality presets. This is the agent's character and instructions.
- **Model(s) — and YES, multiple-per-task is real and confirmed.** One main chat/brain model, **plus separate models** for: image generation, voice-out (text-to-speech), voice-in (speech-to-text), and vision (reading images). Each can be a different provider. (Confirmed against v0.15.2 config.)
- **Skills** — reusable text procedures + small scripts the agent follows. There's a real "skills hub" to browse and install more.
- **Tools / plugins** — which capabilities are switched on (web, terminal, files, image-gen, etc.), chosen per channel.
- **MCP servers** — external tool servers the agent can plug into (declared by address/command).
- **Knowledge base / memory** — the agent's private notes, user profile, full conversation history, and any attached memory database. *(See section 4 — this is private.)*
- **Schedules (cron)** — recurring jobs ("every morning, summarize my inbox") with their own prompt and skills.

---

## 4. Public template = what gets shared

The product rule "**share the SETTINGS, not the knowledge**" maps cleanly onto how Hermes stores things:

**Safe to share (the "spec" / settings — lets someone clone the setup):**
- The persona file (`SOUL.md`) and personality presets
- The model choices (which models/providers for chat, image, voice, vision) — **names only, never keys**
- The skills (text procedures + scripts — review scripts for hidden secrets)
- Which tools are switched on
- The MCP server *definitions* (addresses/commands — with any embedded tokens stripped)
- The schedules (with private chat-IDs and file paths scrubbed)

**Must stay private (the agent's knowledge/data + secrets):**
- All **API keys** (kept in a separate `.env` file)
- The agent's **memory notes** and **user profile**
- The full **conversation history** (and billing data inside it)
- Any **attached knowledge/memory database**
- Live login tokens for connected tool servers

So a "public agent" = persona + model choices + skills + tool selection + schedules — **with every secret and all the accumulated knowledge removed.** Exactly the model you described.

---

## 5. How this maps onto what we have today

**Reality check: we're not there yet.** Today, in our system, an "agent" is essentially a **single database row plus a stateless loop** that calls a model — there is no composable spec, no skills, no MCP, no per-agent memory, and **no templates or marketplace tables exist yet**. The rich, multi-part "spec" described above is what *Hermes* supports; our job is to build the data model and UI to capture it (and to let users connect a real Hermes). The marketplace, template-cloning, and tool-market features are all still to be built.

---

## 6. Honest unknowns

The research flagged these — treat as directional, not gospel:

- **Ports:** The two-port story (dashboard on `9119`, OpenAI-compatible API on `8642`) is from docs, consistent but **not byte-confirmed from source** in this environment (GitHub and the docs site couldn't be directly scraped — findings came from search summaries + a couple of reachable pages).
- **"Official dashboard is React 19 / Tailwind v4":** comes from a third-party guide, not read from source.
- **Multi-model support:** confirmed in the config docs (separate chat/image/voice/vision models). Solid, but verified from config examples, not a single official "this is the spec" schema.
- **Knowledge-base format:** confirmed that by default it's keyword-search over a local database plus two small notes files; richer vector/graph memory only exists if you attach an external provider. **There is no single official "export/import the whole agent" command** in v0.15.2 — our "template = persona + settings + skills + schedules" packaging is a *derived* conclusion, not an official file format Hermes ships.
- **Secondary details** (star counts, "28-permission RBAC," "hackathon winner") come from aggregator/SEO blogs, not primary repos.

---

**Bottom line:** Hermes has plenty of single-user, run-it-yourself dashboards and is already a Telegram bot — but **no hosted, friendly, marketplace-driven product**. That's TMA's lane. An agent is a rich, multi-part *spec* (persona + several models + skills + tools + MCP + private knowledge + schedules); we share the spec, keep the knowledge private; and we still have to build the data model and marketplace to make it real.