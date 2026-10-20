# NativeFrame · NeatFlix

NativeFrame is an internal AI platform that helps an ad-supported streaming team identify, prototype, evaluate, and safely test contextual product-placement opportunities inside rights-cleared shows. **NeatFlix** is its demo streaming catalogue: ten fictional titles, each screened for rights, actor restrictions, and brand safety before any placement work can start.

The recorded demo case, **NF-DEMO-0001**, places Daybreak Cold Brew on the two existing takeaway cups in the café scene of *The LUV Hypothesis*, from catalogue screening to human approval.

## Five agents

Each role is a separate BAND agent identity, reasoning with Anthropic Claude.

| Agent | Responsibility | Recorded decision for NF-DEMO-0001 |
|---|---|---|
| Content Curator | Title eligibility: rights, rating, sensitivity | Eligibility approved |
| Scene Scout | Scene guardrails: surface, framing, motion, tone | Café scene selected (5/5 guardrails) |
| Campaign Matcher | Campaign fit and audience rules | Daybreak Cold Brew recommended |
| Placement Director | The placement plan and edit instructions | Rebrand the two existing cups (plan v3) |
| Release Governor | Release checks before human review | 6/6 checks passed; sent for human review |

No placement ships without a recorded human approval.

## Runway video placement

Runway Aleph edited the complete 20-second source scene, guided by the approved edited still, to brand the two existing cups. A human reviewer **approved the result with a limitation**: the fine generated cup lettering shows minor temporal instability during motion, so it is a generated preview, not production-final typography. Its checksum is registered, and the public copy at `public/demo-videos/luv-hypothesis-daybreak-v4.mp4` is byte-identical to it. The Release Governor and the human approval covered the case's 3.5-second fallback preview, not this video.

## Masky avatars

The agents appear as an executive council. Masky's affordable plan allows two avatars, so only **Iris Vale** (Content Curator) is a real Masky identity, with stored audio. The other four agents use NativeFrame's deterministic local portraits and captions.

## LangSmith HHH evaluation

The case is published to LangSmith as a trace, which is a historical replay of the recorded runs; the recorded times are kept on every run. Feedback scores cover the Helpful, Honest, and Harmless dimensions plus release-gate checks. A per-agent evaluation scores each agent on HHH and on Groundedness, kept separate, with deterministic rules over registered records. **No LLM judge runs.** The `prompt_label_currency` evaluation honestly scores 0, because the Governor relied on historical prompt labels.

## Decision Memory Graph

The Decision Memory Graph is a read-only projection of the case's append-only records: plans, media, visual reviews, the Governor review, the human approval, and the trace. Every node names the stored record it comes from, and nothing is inferred. It is recorded memory, not learning.

## Snyk security

- **Snyk Open Source (production):** passes, after pinning `next` 16.4.1 to resolve a critical Next.js 16.4.0 advisory.
- **Snyk Open Source (development-only dependencies):** reports a failure, shown as a failure in the demo.
- **Snyk Code:** not available for this organization (HTTP 403); a targeted code review stands in for it.

Secret scans of the tracked files and of every commit also run. See [`SECURITY.md`](./SECURITY.md).

## Setup

Requirements: Node.js 20.9 or later, npm, and Google Chrome for the browser tests (`ffprobe` is optional; tests that need it skip without it).

```bash
npm install
cp .env.example .env.local   # server-only secrets; never commit .env* files

npm run dev                  # development server at http://localhost:3000
npm run lint
npm run typecheck
npm test                     # unit tests
npm run build && npm start   # production build and serve
npm run test:e2e             # browser tests (after npm run build)
```

`.env.example` documents every variable. None uses a `NEXT_PUBLIC_` prefix, so no credential reaches the browser. The catalogue and the hero preview need no secrets.

The full-case demo reads a verified, git-ignored snapshot in `.demo/`. `npm run demo:snapshot` builds it, read-only, from the Supabase workflow registry, and needs the Supabase variables. `npm run demo` builds the snapshot, then builds and serves the app. Without a snapshot, the demo pages show clear placeholders.

## Demo routes

| Route | What it shows |
|---|---|
| `/` | The NeatFlix catalogue: hover the hero (or press **Play preview**) to preview the approved video; placement stages for every title; title records with players |
| `/titles/luv-hypothesis/scenes/luv-scene-1/campaign` | Campaign matching for the case; **Continue to placement preview** |
| `/titles/luv-hypothesis/scenes/luv-scene-1/preview` | Recorded pipeline replay of the five agents, then the approved 20-second video |
| `/demo` | The full case, step by step, with its evidence, council, decision memory graph, and reliability checks |

The demo is a **recorded replay**: no Runway, Masky, Gemini, Anthropic, or other provider is called, and nothing is generated, while it runs.

## Product source of truth

[`PRODUCT_SOURCE_OF_TRUTH.md`](./PRODUCT_SOURCE_OF_TRUTH.md) is the controlling specification for NativeFrame. It governs all product, scope, architecture, and implementation decisions. Any change that would conflict with it must be proposed and agreed by updating that document first, before implementation.

## Reference material

The `ad-responder` repository is reference material only. It may inform presentation and media patterns, but its source code must not be copied into NativeFrame, and neither may its styling, brand assets, or other protected material.
