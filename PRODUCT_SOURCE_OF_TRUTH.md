# NativeFrame — Product Source of Truth

Status: Approved build plan  
Purpose: This document is the controlling specification for the hackathon product. Implementation should not deviate from it unless we explicitly update this document first.

## 1. Product definition

NativeFrame is an internal AI platform for an ad-supported streaming company. It helps a content and advertising team identify, prototype, evaluate, and test contextual product-placement opportunities inside rights-cleared shows.

The product answers one business question:

> Can this advertiser be placed naturally in this scene, for this eligible audience, without harming viewer trust—and is the opportunity worth testing or scaling?

NativeFrame does not automatically publish advertisements into production content. It produces an evidence-backed placement preview, evaluates it, requires human approval, and recommends **Scale**, **Revise**, or **Stop**.

## 2. Target users and problem

Primary users:

- Streaming-platform ad product teams
- Content operations and rights teams
- Brand-safety and creative-review teams
- Advertising campaign managers

Current work is fragmented across catalogue review, scene analysis, advertiser matching, creative production, safety review, and experimentation. This makes contextual placements slow, expensive, and difficult to evaluate consistently.

NativeFrame coordinates those responsibilities while preserving specialist decisions and a human release gate.

## 3. Demo environment

The demonstration uses a fictional streaming company, fictional advertisers, synthetic subscriber records, and synthetic or properly licensed video content.

The catalogue contains:

- Ten shows, each represented by a 3–5 minute video
- A mixture of light comedy and lifestyle-style content
- Ownership, genre, tone, rating, actor-restriction, and placement metadata
- Three to five candidate scenes across the catalogue
- One or two shows enabled for the complete generation workflow
- One final placement used for the primary demonstration

The ten titles establish a believable streaming catalogue; they are not all processed through the expensive generation pipeline. Video binaries are stored in Supabase Storage or another approved object store, not committed directly to Git. The repository stores metadata, thumbnails, and asset URLs.

Synthetic experiments and metrics must always be labelled as simulated. The demo must not imply real viewer or advertiser results.

## 4. Agent team

Each agent is registered as a separate BAND participant with its own identity, instructions, tools, input evidence, output contract, and decision authority.

### 4.1 Content Curator

Responsibility: Select eligible content.

- Confirms platform ownership or approved usage rights
- Evaluates genre, tone, audience rating, and known restrictions
- Produces an eligible shortlist with evidence
- Can reject a title before scene analysis

### 4.2 Scene Scout

Responsibility: Find viable placement moments.

- Examines only eligible content
- Identifies timestamps and visible placement surfaces
- Prefers light, casual scenes with stable cameras
- Excludes close-up faces, sensitive moments, difficult motion, and restricted shots
- Produces ranked scene candidates with evidence
- Can reject every scene in a title

### 4.3 Campaign Matcher

Responsibility: Match the scene, advertiser, and audience.

- Prioritizes fast food and consumer electronics for the MVP
- Confirms contextual and brand-safety compatibility
- Includes only eligible adult, ad-supported viewers
- Excludes premium/ad-free subscribers and minors
- Produces a campaign brief and initial business assumptions
- Can reject an incompatible brand-scene-audience combination

### 4.4 Placement Director

Responsibility: Create the placement preview.

- Extracts the approved source frame
- Uses Nano Banana to insert one stationary product
- Uses Gemini to create a grounded motion prompt
- Uses Reactor Orbis to generate a 3–5 second animated preview
- Records prompts, inputs, outputs, latency, and cost
- Revises the preview when the Release Governor returns actionable feedback

### 4.5 Release Governor

Responsibility: Decide whether the result is safe and useful enough to test.

- Runs deterministic checks and HHH evaluation
- Compares the preview with the original scene
- Verifies evidence and detects unsupported claims
- Can veto the placement and require regeneration
- Sends passing work to the human approval gate
- After approval, creates the simulated A/B-test plan
- Uses experiment results to recommend **Scale**, **Revise**, or **Stop**

## 5. Required collaboration pattern

The normal BAND handoff is:

`Content Curator → Scene Scout → Campaign Matcher → Placement Director → Release Governor → Human approval`

The required correction loop is:

`Release Governor rejects V1 → sends evidence and correction → Placement Director creates V2 → Release Governor reevaluates`

Collaboration must be functional, not a status feed:

- Every handoff uses a shared case and artifact ID.
- The receiving agent must use the previous agent's evidence.
- Agents communicate through BAND `@mentions`.
- A rejection changes the workflow state and prevents release.
- No A/B test can begin without Release Governor clearance and human approval.
- Removing BAND should break the delegation, handoff, or veto process.

## 6. End-to-end closed loop

1. A human selects a campaign objective or opens a catalogue review.
2. Content Curator produces an evidence-backed eligible shortlist.
3. Scene Scout identifies and ranks candidate timestamps.
4. Campaign Matcher selects a compatible advertiser and eligible audience.
5. Placement Director generates the preview.
6. Release Governor evaluates HHH, technical quality, and policy compliance.
7. Failed work returns for one controlled regeneration attempt.
8. Passing work waits for explicit human approval.
9. The system constructs a simulated A/B test:
   - Cohort A receives the original scene.
   - Cohort B receives the placement version.
   - All other experiment conditions remain equal.
10. The system evaluates viewer, brand, cost, and revenue metrics.
11. Release Governor recommends **Scale**, **Revise**, or **Stop**.
12. The run, decision, evidence, and failure cases are stored for future evaluation.

The placement is not the end of the workflow. The business decision and captured learning close the loop.

## 7. Evaluation strategy

LangSmith is the tracing and evaluation system. It is not the agent orchestrator.

### 7.1 Definition of good

**Helpful**

- Produces an actionable placement candidate and campaign recommendation
- Improves the team's ability to decide whether to test or scale
- Avoids unnecessary work when no suitable opportunity exists

**Honest**

- Grounds important decisions in visible evidence
- Cites rights metadata, timestamps, audience rules, and experiment inputs
- Expresses uncertainty instead of inventing facts
- Clearly labels generated previews and simulated results

**Harmless**

- Respects rights and actor restrictions
- Excludes minors and premium/ad-free viewers
- Blocks sensitive scenes and unsafe brand combinations
- Protects viewer experience and requires human approval

Harmlessness is a hard gate. It cannot be offset by a high Helpful or ROI score.

### 7.2 Evaluation layers

Agent evaluation checks whether each specialist performed its assigned decision correctly.

Collaboration evaluation checks whether handoffs carried the correct artifacts and evidence, agents used prior findings, required steps were not skipped, and vetoes were respected.

Business evaluation checks whether the approved placement is sufficiently natural, safe, useful, and economically credible to test or scale.

### 7.3 Evaluation methods

- Deterministic checks validate duration, schema, rights fields, audience eligibility, approval state, and required artifacts.
- LLM-as-judge evaluates contextual fit, naturalness, evidence quality, helpfulness, and honesty.
- Human review owns the final visual, brand-safety, and release decision.
- LangSmith traces every agent run and tool call with agent name, case ID, scene ID, model, prompt version, latency, cost, and outcome.

An LLM judge must return a score, explanation, and supporting evidence. It is never the only safety control.

### 7.4 Offline benchmark

The evaluation dataset contains approximately 15 cases:

- Five clearly suitable opportunities
- Five clearly unsuitable or unsafe opportunities
- Five ambiguous opportunities requiring contextual reasoning

It includes unclear rights, minors, premium viewers, sensitive scenes, restricted actors, incompatible brands, and unnatural visual outputs.

Compare three implementations on the same dataset:

1. Rule-based baseline
2. One general-purpose agent
3. Five-agent NativeFrame system

The multi-agent design is justified only when it improves decision quality, evidence, or safety enough to warrant its additional latency and cost.

Failed production-style runs are added to the offline dataset for regression testing.

## 8. Experiment, metrics, and ROI

North-star metric:

- Scene naturalness score, target at least 8/10 for test approval

Supporting metrics:

- Brand-recall lift
- Show-completion-rate change
- Viewer-satisfaction change
- Placement approval rate

Guardrails:

- Subscription churn or cancellation intent
- Premium or minor exposure
- Rights, actor, or brand-safety violations
- Material decline in completion or satisfaction

Financial model:

- Incremental revenue = eligible impressions × CPM uplift ÷ 1,000
- Total cost = generation + model usage + human review + delivery cost
- Net value = incremental revenue − total cost
- ROI = net value ÷ total cost × 100

All inputs are visible and editable. Projected ROI is labelled as an estimate, not realized revenue.

A **Scale** recommendation requires:

- No harmlessness violation
- Evidence-backed decisions
- Naturalness threshold passed
- Positive brand-recall signal
- Viewer guardrails held
- Positive projected ROI

Otherwise the result is **Revise** or **Stop**.

## 9. Product experience

The product uses one cohesive streaming-style Mission Control rather than disconnected admin pages.

Required interface areas:

1. **Catalogue** — ten titles with cinematic artwork and eligibility metadata
2. **Scene workspace** — video playback, timestamp candidates, evidence, and ranking
3. **Agent room** — five Masky identities and live BAND handoffs
4. **Placement studio** — original frame, inserted frame, and generated preview
5. **Evaluation gate** — HHH results, deterministic checks, evidence, veto, and human approval
6. **Experiment dashboard** — cohorts, metrics, cost assumptions, projected ROI, and final Scale/Revise/Stop decision

The primary demo should remain understandable from a single main workflow screen. Secondary detail may appear in drawers or focused views.

Masky gives every agent a distinct face, personality, and voice. Voice is used sparingly: each agent may deliver one short result, with the Release Governor receiving the most prominent spoken moment.

## 10. Technical architecture

### Product application

- Next.js with React and TypeScript
- Tailwind CSS and shadcn/ui for the design system
- Motion for transitions and workflow animation
- Recharts for experiment and ROI visualization
- Vercel for the web application

### Agent system

- Five separately registered BAND agents
- Python agent workers hosted on Railway for persistent connections
- Structured input and output schemas for every handoff
- BAND rooms, `@mentions`, shared case IDs, events, and veto flow

### Media generation

- Nano Banana for product insertion into the selected source frame
- Gemini for scene understanding and grounded Reactor prompt generation
- Reactor Orbis for the animated 3–5 second placement preview
- Tenki for isolated video-processing and deterministic media checks where required

Reactor produces a generated preview from an approved scene frame. NativeFrame does not claim frame-perfect editing of an entire existing episode.

### Data and evaluation

- Supabase Database for catalogue, cases, decisions, experiments, and metrics
- Supabase Storage for videos, thumbnails, frames, and generated previews
- LangSmith for traces, offline datasets, evaluators, comparisons, and regressions
- Snyk for dependency and code-security scanning

### Explicit exclusions

- n8n is not used.
- RocketRide is not in the critical path.
- LangGraph or CrewAI will not be added unless BAND integration demonstrably requires one.
- Large video binaries are not stored in Git.
- Multiple model providers are not added merely to make the architecture appear more complex.

## 11. Reliability and demo safety

- Repeatedly test one stable scene before expanding the catalogue.
- Avoid close-up faces, hands interacting with the inserted object, reflections, camera movement, and complex motion.
- Permit one controlled regeneration attempt in the main demo.
- Cache completed upstream artifacts so a failed downstream call can be retried.
- Keep one known-good generated output as a clearly disclosed fallback.
- Provide a demo reset that returns the workflow to a known state.
- Record a complete backup demonstration.
- Keep secrets server-side and out of Git.
- Never depend on Vercel's local filesystem for persistent state.

## 12. Hackathon demonstration

The primary story is one case, not a tour of every feature:

1. Open the ten-title catalogue.
2. Start a campaign case.
3. Show Content Curator and Scene Scout making evidence-backed selections.
4. Show Campaign Matcher selecting the brand and eligible audience.
5. Show Placement Director create V1.
6. Show Release Governor reject V1 for a specific reason.
7. Generate or reveal corrected V2.
8. Show HHH and technical checks pass.
9. Request human approval.
10. Show the simulated A/B-test and transparent ROI calculation.
11. End with **Scale**, **Revise**, or **Stop** and the LangSmith trace.

The final pitch is:

> NativeFrame does not simply generate product placements. It helps streaming teams identify, prototype, evaluate, and safely test placements—and proves whether each opportunity is worth scaling.

## 13. Scope boundaries

### In scope

- Ten-title streaming catalogue
- One fictional streaming company
- Fictional brands and synthetic subscribers
- Five real agent identities and dependent BAND handoffs
- One or two pipeline-enabled shows
- Three to five candidate scenes
- One complete placement case
- One rejection and revision loop
- HHH evaluation and human approval
- Simulated A/B testing and projected ROI
- Exceptional, presentation-ready UI

### Out of scope

- Editing full episodes
- Processing all ten catalogue videos
- Deploying placements to real viewers
- Real advertiser purchasing or billing
- Real subscriber experimentation
- Pharmaceutical, political, gambling, alcohol, or child-directed advertising
- Autonomous production release
- Perfect preservation of actor identity across complex motion

## 14. Inspiration and implementation boundaries

The synthetic closed-loop infrastructure project informs the product pattern: operate inside a controlled environment, perform real work, evaluate the result, and feed the outcome back into the next decision.

The `ad-responder` project informs the streaming presentation and media pattern: a polished Next.js streaming interface, pre-warmed generation, image editing followed by grounded prompting, and Reactor-powered live video.

NativeFrame must implement its own product experience and agent workflow. Do not directly copy source code, styling, brand assets, or other protected material from the reference repository without confirmed license permission.

## 15. Definition of done

NativeFrame is demo-ready when:

- The catalogue displays ten believable titles from persistent metadata.
- Five distinct BAND agents complete a visible, dependent workflow.
- Every decision includes evidence or explicitly states uncertainty.
- Reactor produces or replays a 3–5 second placement preview.
- Release Governor can block V1 and trigger a revision.
- Harmlessness failures prevent human approval and experimentation.
- A human can approve a passing result.
- The experiment view clearly distinguishes simulated data.
- ROI assumptions and calculations are transparent.
- The final system produces Scale, Revise, or Stop.
- LangSmith contains an inspectable trace and evaluation result.
- The deployed UI is stable, polished, and understandable without verbal rescue.

