# AgentVerify (AV) — Revised Hackathon Plan

## 1. Product

**AgentVerify (AV)** is an AI agent that verifies if another deployed AI agent is performing according to its intent.

AV answers:

> "Looking at the agent's execution traces, production logs, and source code, is the deployed agent performing as intended?"

If AV finds a meaningful problem, it does not attempt to fix it. Instead, it:

1. gathers evidence from all sources,
2. produces a single diagnosis,
3. sends a Slack message asking a human whether a GitHub issue should be created,
4. creates the GitHub issue only after approval.

**Product boundary:** Observe → Investigate → Diagnose → Ask → Report.
No automatic code changes, PRs, deployments, or remediation.

---

## 2. Why this is a strong hackathon project

AV crosses four external systems with distinct roles, plus Mastra as the orchestration substrate for AV itself:

- **Lemma** — structured execution traces from the deployed agent.
  - **NOTE: Lemma receives traces from a live Mastra project `floperati`. Do not confuse this with the AgentVerify hackathon app (AV), which is also built on Mastra.**
- **Render** — production/runtime logs.
- **GitHub** — source of truth for implementation, and issue tracking.
- **Slack** — human approval and escalation.

AV triangulates:

| Question | Source |
|---|---|
| What the agent did | Lemma / Mastra trace |
| What happened in production | Render logs |
| What the code says should happen | GitHub |
| What a human wants done about it | Slack |

This creates a closed reliability loop without letting the auditor modify the system it audits.

---

## 3. Target demo agent

**NOTE: This is an example scenario. We will populate the real scenario from pulling live data.**

System under audit: the existing deployed **Flopsmith** agent.

### Failure A — Tool validation
- tool: `parallel_web_search`
- `search_queries` expected as an array; actual input was a string
- `Tool input validation failed`

### Failure B — Production model failure
- Render logs: `judge failed: model not found`
- HTTP 404, model: `nvidia/nemotron-3.5-lightning-30b-a3b`

### Healthy case
At least one successful run, to prove AV isn't just an error detector.

**Demo will lead with Failure A end-to-end. Failure B and the healthy case are shown as static before/after evidence, not replayed live** (see Section 10).

---

## 4. Architecture (single-pass reasoning)

```text
                    ┌─────────────────────┐
                    │   Deployed Agent    │
                    │     Flopsmith       │
                    └──────────┬──────────┘
                               │
                     execution / telemetry
                               ▼
                    ┌─────────────────────┐
                    │       Lemma         │
                    │  structured traces  │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │   AV Mastra         │
                    │      Workflow       │
                    └──────────┬──────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
        ┌───────────┐   ┌────────────┐   ┌─────────────┐
        │  Render   │   │  GitHub    │   │   Lemma     │
        │ runtime   │   │ source     │   │   trace     │
        │ evidence  │   │ of truth   │   │   detail    │
        └─────┬─────┘   └─────┬──────┘   └─────┬───────┘
              │               │                │
              └───────────────┼────────────────┘
                               ▼
                    ┌─────────────────────┐
                    │  AV Reasoner        │
                    │  (single call,      │
                    │  all evidence in)   │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │  Investigation      │
                    │      Verdict        │
                    └──────────┬──────────┘
                               ▼
                    ┌─────────────────────┐
                    │       Slack         │
                    │ Human approval      │
                    └──────────┬──────────┘
                               │
                         approved?
                     no ──────┴────── yes
                      │                │
                    stop                ▼
                             ┌────────────┐
                             │  GitHub    │
                             │   Issue    │
                             └────────────┘
```

**Key change from the original plan:** evidence gathering (Lemma + Render + GitHub) all happens *before* the reasoning agent is invoked. The reasoner runs **exactly once**, on the full evidence bundle — not incrementally after each source. This matches the diagram above, avoids the reasoner contradicting itself across passes, and cuts LLM round-trips.

---

## 4a. Interface

One page. Not four panels mimicking Lemma/Render/GitHub/Slack — that's surface area that doesn't serve the story. A single **investigation console** with two zones:

- **Left rail** — list of past agent runs pulled from Lemma, each with a status dot. This is where you pick which run to audit.
- **Main panel** — the investigation itself, unfolding.

**Trigger:** manual, by design. Click a run in the left rail, hit **Investigate**, and the main panel fills in live. Manual trigger keeps demo pacing in your control rather than depending on a webhook firing on cue.

### Where the wow lives

The product's thesis is triangulation — trace + logs + source converging into one verdict. That convergence is the single most demo-able idea in the project, so the main panel should not jump from spinner to final card. Evidence should arrive one source at a time, each one visibly correlating with the last, then converge into a verdict:

1. **Lemma card** — the actual trace call, the bad string arg, the validation error. Real data, not paraphrase.
2. **Render card** slides in below it — the matching log line, timestamp-aligned to the trace.
3. **GitHub card** — the actual schema snippet, mismatched line highlighted.
4. The three cards visibly **collapse/connect into a Verdict card** — status pill, cause, confidence, rationale.
5. **Slack thread preview** embeds inline, showing the approval ask and a human clicking yes.
6. **GitHub issue link** appears. Done.

Judges watching this see the actual reasoning chain rather than a black box — this covers "reliability & evaluation" (25% of the score) visually, for free.

### Style — Geist / Vercel minimalist, light mode

- Geist Sans for UI text; Geist Mono for raw technical content (run IDs, code snippets, log lines). The font switch doubles as a legibility cue: mono = raw evidence, sans = AV's own words.
- Monochrome base (white/black/grays). One accent color, reserved only for the status pill — green/amber/red for healthy/uncertain/problem. Don't let the accent leak anywhere else.
- 1px hairline borders, no heavy shadows, generous padding. Cards, not panels-with-chrome.
- Motion only where it means something: each evidence card fades/slides in over ~200–300ms as its data lands; a soft pulse while a fetch is in-flight. No spinners with percentages, no confetti — motion should read as "evidence arriving," not "app loading."

### Building it solo

Since this is a solo build, there's no separate UI track running in parallel with a second person — but the *sequencing* still holds: **scaffold the console against mock data early**, before the real Lemma/Render/GitHub calls exist, so you have something demo-able within the first hour and you're never staring at a blank screen while backend work is in progress. Swap in real data source-by-source as each phase lands — see Section 8, which now interleaves this.

---

## 5. Mastra's AgentVerify role

Mastra is the AgentVerify controller; Lemma, Render, GitHub, and Slack are evidence/action systems. AV itself is a relatively thin Mastra workflow, using:

- **deterministic workflow steps** for data gathering and side effects (Lemma fetch, Render query, GitHub read, Slack post, GitHub issue creation),
- **one AV reasoning agent** for judgment, invoked once all evidence is collected.
- **Do not confuse** this with the live project feeding Lemma (`floperati`), which is also built on Mastra.

---

## 6. Evidence sources

### Lemma (execution trace)
Structured records: agent/workflow runs, model generations, tool calls, inputs/outputs, errors, timing, thread/user IDs. Best signal for *what the agent did and why*.

**Status: API access confirmed, no trace pulled yet.** This is the first thing to de-risk (see Section 8, Phase 0).

### Render (production logs)
Programmatic log access filtered by time, resource, level, text, status code. Best signal for *what actually happened in production*. Purpose: corroborate or contradict the trace.

### GitHub (source of truth)
Do not read the whole repo. Instead:
1. identify the relevant agent/tool/config from the trace,
2. locate the likely source file,
3. inspect the relevant schema/implementation,
4. compare observed behavior against it.

Example: trace shows `search_queries = "foo"` (a string); tool schema requires `string[]`. Verdict: invalid argument shape, not a vague "validation error."

---

## 7. The AV reasoning layer

One call, fed the full bundle: trace + Render logs + GitHub source.

Question it answers: *Given the trace, production logs, and source code, did the deployed agent perform as intended?*

Structured output:
- overall status: `HEALTHY` / `PROBLEM DETECTED` / `UNCERTAIN`
- problem summary
- evidence (cited from trace/logs/source)
- likely cause
- affected component
- **confidence** — carry this through to the reliability brief; see Section 9
- relevant trace/run IDs
- relevant source-code location
- recommended human action

Category taxonomy (pick one, or `INSUFFICIENT EVIDENCE`):
1. Agent behavior defect
2. Tool/schema mismatch
3. Configuration/environment problem
4. External dependency failure
5. Infrastructure/runtime problem
6. Insufficient evidence / uncertain

---

## 8. Revised six-hour sequence (solo, UI interleaved)

**Build window: 9:30 AM–4:00 PM. Hard stop on feature work at 3:00 PM.**

Since this is a solo build, UI isn't a separate parallel track — it's interleaved: scaffold it early against mock data, then swap in real data as each backend phase lands. This avoids ending up with either a working backend and no visual story, or a pretty shell wired to nothing.

### Decisions and scope for implementation

- Work one phase at a time. Do not assume the entire six-hour sequence is authorized before the current phase is reviewed.
- Use the existing Flopsmith Mastra stack as the system under audit. The AV application may use the same current Mastra/TypeScript conventions when it is scaffolded.
- Use `gh` for GitHub access and the Render CLI for Render access.
- Lemma access is live through the configured project credentials. Phase 0 must query live Lemma data before creating any local evaluation record.
- Slack integration and reasoning-model selection are intentionally deferred. No Slack app, approval callback, model provider, or model identifier is a Phase 0 prerequisite.
- Evaluation is discovered from live data, not prescribed in advance. The examples in Section 3 are hypotheses to investigate, not required fixtures or guaranteed cases.
- Do not manufacture a healthy run, failure run, source citation, or log correlation. Record only observations supported by the live trace, Render logs, or GitHub source.
- A local record may identify candidate runs and evidence gaps. Final evaluation cases are selected only after the relevant live evidence has been inspected.

**Eval philosophy (simplified):** AV's actual job is to determine whether observed behavior (Lemma trace + Render logs) matches the intent encoded in the source (GitHub) — not just "did something error." So eval shouldn't just check whether AV picked the right status label; it should check whether AV's diagnosis is **grounded in real evidence** — did it actually cite the true GitHub source line and the true Render log line it based the verdict on, or did it produce a plausible-sounding but ungrounded answer? That's the reliability claim this product is actually making, and it's the one the rubric should reward.

The evaluation set is selected from live data after discovery. It may include healthy, failed, ambiguous, or insufficient-evidence runs; the final number and categories depend on what the deployed agent actually produced and what can be corroborated. For each selected case, check status, evidence grounding, confidence, and whether the evidence sources genuinely correlate. Do not treat the example failures in Section 3 as acceptance criteria.

### Phase 0 — De-risk Lemma + tag eval runs (9:30–10:00, 30 min)
- [x] Spike: use the Lemma API with the live project credentials and confirm that trace search and trace-detail retrieval work.
- [x] Use `gh` to identify the audited repository and relevant source locations, and use the Render CLI to query logs for the trace time window and service.
- [x] Record candidate runs from live data with their observed inputs, outputs, tool calls, errors, timestamps, source references, Render correlations, and unresolved gaps. Do not label a run healthy or problematic solely from a search result flag.
- [x] If Lemma retrieval fails, stop and report the exact failure before choosing a fallback. A static fixture is permitted only as an explicitly marked fallback after live retrieval has been attempted; it is not the default evaluation source.
- [x] Phase 0 is complete when the live-data manifest exists and each candidate has a trace ID, source provenance, Render query window, and an evidence status of `confirmed`, `contradicted`, or `unresolved`.

### Phase 0b — Scaffold the console on mock data (10:00–10:30, 30 min)
**NOTE: consider initial commit then using v0 to create interface from GitHub repo.**
**NOTE: REVISED. Defer v0 until Phase 3.5**
- [x] Build the two-zone layout: left rail (run list) + main panel (investigation).
- [x] Build the card components — trace, Render, GitHub, verdict, Slack, issue-link — populated from the live-data candidates discovered in Phase 0, not invented fixtures.
- [x] Get the reveal sequence and card styling (Section 4a) basically right now, while there's nothing else competing for attention. This is your insurance: you have something demo-able by 10:30 even if a later backend phase runs long.

### Phase 1 — Trace retrieval + single-pass reasoning stub (10:30–11:30)
- [x] Workflow: trigger → fetch Lemma trace → call reasoner with trace only (Render/GitHub evidence stubbed empty).
- [x] Run the live candidates selected from Phase 0 through it; do not assume a fixed case count.
- [x] Swap the mock trace card for the real Lemma response in the console.

### Phase 2 — Add Render (11:30–12:30)
- [x] Workflow: trace + Render query → feed both into the **same single reasoner call** (no separate "updated diagnosis" pass).
- [x] Re-run the selected live candidates; confirm Render evidence changes the verdict only when the correlation is supported.
- [x] Swap the mock Render card for the real log data.

**Render integration note:** Render's [log streams documentation](https://render.com/docs/log-streams)
describes forwarding logs to an external destination, not querying historical logs from an
application. The Phase 2 implementation uses the authenticated Render CLI's JSON log query
interface, which is the available read path for the selected service and time window.

### Phase 3 — Add GitHub source comparison (12:30–1:45)
- [x] Retrieve the selected source file live from `benschiller/floperati` through the authenticated GitHub CLI.
- [x] Show repository, path, source excerpt, and a human-readable explanation of the source intent as separate evidence.
- [x] Send Lemma trace, Render logs, GitHub source, and source intent to one server-side OpenAI-compatible reasoner call.
- [x] Validate structured reasoner output and surface unavailable or malformed model responses as errors.
- [x] Re-run the selected live candidates and verify the console shows a fully live investigation with real source and verdict output.

### Phase 4 — Slack approval (1:45–2:20)
- Reasoner verdict → concise Slack message → wait for human yes/no.
- No → stop. Yes → proceed to Phase 5.
- Wire the Slack card in the console to the real thread (embed or screenshot-on-completion).

### Phase 5 — GitHub issue creation (2:20–3:00)
- On approval, create the GitHub issue with: title, problem summary, observed vs. expected behavior, evidence, trace/run IDs, relevant Render logs, relevant source location, AV's diagnosis, confidence, and an explicit note that AV did not modify code.
- Run the live candidates selected from Phase 0 end-to-end through the full pipeline once. For each, capture not just the status output but the specific evidence AV cited (which GitHub line, which Render log line) so you can confirm in the brief that it's grounded in the real source rather than a plausible guess. This is your reliability evidence — save it (screenshot or JSON) for the brief.
- Wire the issue-link card to the real created issue.

### Hard stop: 3:00 PM — no more feature work.

### 3:00–3:30 — Record the demo (Section 10) and tune reveal-sequence timing so the card animations land inside the ~60-second live-demo window.

### 3:30–4:00 — Write/finalize the reliability brief (Section 9) using the Phase 5 outputs, buffer for last-minute issues, submit.

**If you're behind schedule at any checkpoint above, drop UI wiring for that phase first and keep the mock card in place** — a console with one mocked card and everything else real is a fine demo; a missing backend phase is not.

---

## 9. Reliability brief (own task, own owner)

This is a required submission artifact and now has explicit time on the schedule (Phase 5 output + 3:30–4:00). If team size > 1, assign an owner early so it can be drafted in parallel with Phase 3–5 rather than written cold at the end.

Minimal structure:
1. What AV checks and why (triangulation across trace/logs/source, against code intent in GitHub — one paragraph).
2. Each selected live eval case, reported against **two checks**, not one:
   - **Status match** — did AV output the expected label (`HEALTHY` / `PROBLEM DETECTED` + category)?
   - **Grounding match** — did AV's cited evidence actually point to the real GitHub line and real Render log line, or was the verdict right for the wrong / no reason? This is the check that actually validates the triangulation thesis, and it's the one worth stating explicitly rather than leaving implicit.
   - Also report the confidence value for each — high confidence on clear, well-grounded cases is a cheap, concrete signal of calibration. Add the stretch case here too if you got to it.
3. Known limitations, stated plainly rather than glossed over — e.g., which live categories were available, which evidence correlations remained unresolved, and whether ambiguous/uncertain cases were tested. Being explicit about what wasn't tested reads as more rigorous than implying full coverage.
4. Explicit statement of the human-approval boundary — AV never acts without it.

---

## 10. Demo (2 minutes, scoped down)

Original 8-beat narrative cut to fit 120 seconds:

1. **(20s)** One-line framing: "This agent runs in production. AgentVerify checks whether it's behaving correctly — and never acts without a human."
2. **(60s)** Live, end-to-end on **Failure A only**: trace → Render → GitHub → verdict → Slack ask → approval → GitHub issue appears.
3. **(20s)** Static contrast: side-by-side screenshot of selected live-run verdicts, if more than one sufficiently grounded case is available — otherwise show the evidence gap plainly rather than inventing a contrast.
4. **(20s)** Close on the boundary: "AV diagnoses. A human authorizes. GitHub records. AV never touches code."

---

## 11. What AV must NOT do

- modify source code
- create a pull request
- merge code
- deploy
- restart services
- change configuration
- automatically retry indefinitely
- claim certainty without evidence

---

## 12. Priority order if time runs short

1. Trace → single-pass diagnosis (Phases 0–1)
2. Console scaffold on mock data (Phase 0b) — keep this even under time pressure; it's cheap and is your fallback demo surface
3. Render corroboration (Phase 2)
4. GitHub source comparison (Phase 3)
5. Slack approval (Phase 4)
6. Reliability brief with the selected live cases, each scored on status match + evidence grounding, plus confidence values
7. GitHub issue creation (Phase 5)
8. Live-wiring every UI card to real data (mock cards are an acceptable fallback for any phase that runs long)
9. Stretch: second failure case, in a different category
10. Demo polish

Note the reordering versus the original plan: **the reliability brief now outranks live GitHub issue creation.** If you're down to the wire, a documented, evidenced diagnosis with a Slack approval ask is a complete-enough story for the rubric's reliability and usefulness weighting even if the issue-creation step is a mocked/manual call rather than a live API hit.

---

## 13. Final MVP boundary

> Select a deployed agent → gather trace + production evidence + source in one pass → produce a single diagnosis → ask a human in Slack → optionally create a GitHub issue → document reliability against live cases selected from observed data, each verified for correct status *and* correct grounding in the real GitHub/Render evidence, with confidence reported for each.

No automated fixing. No broad observability platform. No incremental re-diagnosis. No complex dashboard.
