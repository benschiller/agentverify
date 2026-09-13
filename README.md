# AgentVerify

AgentVerify is a multi-step reliability auditor for deployed AI agents. It gathers live evidence, compares observed behavior with the behavior described by source code, asks a human for approval in Slack when it finds a problem, and creates a GitHub issue only after that approval.

This is a hackathon project built around a real business problem: AI agents can appear healthy while silently skipping required tools, sending malformed inputs, or drifting from their intended workflow. AgentVerify turns those hard-to-review execution details into a short, evidence-backed decision for an engineering team.

## README & demo

### 1. Project overview

The core question is:

> **Looking at the agent's execution traces and source code, is the deployed agent performing as intended?**

The investigation flow is:

1. Select a live run from the Observed Runs rail.
2. Pull the actual Lemma trace from the deployed Mastra agent.
3. Explain what happened in human-readable language.
4. Retrieve the relevant source file from GitHub and explain what should happen.
5. Compare observed behavior with expected behavior.
6. For `PROBLEM` or `UNCERTAIN`, send a concise Slack approval request.
7. Create a GitHub issue only when a human approves it.

`MATCH` results stop without escalation. AgentVerify never edits code, opens a pull request, or deploys a fix.

### 2. External apps used

AgentVerify connects to these external systems:

| External app | Role |
| --- | --- |
| **Lemma** | Live trace feed from the Mastra-powered `floperati` agent. This is the evidence for what the deployed agent actually did. |
| **GitHub** | Live source-of-truth retrieval and approved issue creation in `benschiller/floperati`. |
| **Slack** | Human approval and escalation channel for non-matching or uncertain findings. |

The audited agent and the AgentVerify console are separate systems. Lemma receives traces from the live Mastra project; it is not the telemetry source for the console itself. AgentVerify itself runs locally as two monorepo apps for this hackathon demo.

### 3. Setup instructions

#### Prerequisites

- Node.js 20 or newer
- GitHub CLI authenticated with access to `benschiller/floperati`
- A Lemma project and API key
- An OpenAI-compatible model endpoint, API key, and model name
- A Slack app with Socket Mode enabled, bot/app tokens, and the approval channel ID

#### Local monorepo setup

```bash
git clone https://github.com/benschiller/agentverify.git
cd agentverify
npm install
cp .env.example .env
cp apps/slack/.env.sample apps/slack/.env
```

Fill in the root `.env` with Lemma, model, GitHub, and AgentVerify settings. Fill in `apps/slack/.env` with the Slack bot and app tokens. Never commit either `.env` file.

Start the AgentVerify console:

```bash
npm run dev --workspace apps/agentverify -- --host 127.0.0.1
```

Start the Slack app in a second terminal:

```bash
npm start --workspace apps/slack
```

The Slack app exposes the approval bridge on `SLACK_BRIDGE_PORT`. Set `SLACK_BRIDGE_URL` in the root `.env` to that local bridge URL and set `SLACK_CHANNEL_ID` to the channel where approval messages should appear. The Slack app still uses Socket Mode, so it does not require a public Slack Events webhook. The bridge can be protected with `SLACK_BRIDGE_TOKEN`.

### 4. Reliability testing

The project is tested against live data rather than canned success/failure fixtures:

```bash
npm run build
npm run lint:slack
npm run test:slack
```

The live verification sequence is:

1. `GET /api/runs` returns current Lemma runs and live `agent_name` labels.
2. `POST /api/lemma` retrieves the selected trace and summarizes what happened.
3. `POST /api/github/source` chooses and retrieves a real source file from the configured repository.
4. `POST /api/verdict` returns `MATCH`, `PROBLEM`, or `UNCERTAIN`.
5. `PROBLEM` and `UNCERTAIN` create a Slack approval request.
6. Pending and rejected approvals cannot create GitHub issues.
7. Approved requests create an issue in `benschiller/floperati`.
8. `MATCH` results do not send a Slack request.

This verifies the central claim: AgentVerify's finding is grounded in live traces, live source code, and explicit human approval rather than repeated demo text.

### 5. Demo video

[![Demo video](https://i.imgur.com/RfXJhEh.png)](https://youtu.be/nbG4E7K0rLM)

Here we walk you though AgentVerify with live data from a Mastra swarm being fed through Lemma. The traces are observed and the agent's function is compared against its original intent from the code on GitHub. Problems are flagged and forwarded for human review in Slack. From there, an issue can be created on GitHub to address the offending action.

## What success looks like

AgentVerify successfully achieves its target when it can make a concise, reviewable statement:

- **What happened:** based on the live Lemma/Mastra trace.
- **What should happen:** based on the live GitHub source.
- **Do they match?** `MATCH`, `PROBLEM`, or `UNCERTAIN`.
- **What happens next:** a human decides in Slack before any issue is created.

## Current limitations and future development

- The local Slack approval bridge currently keeps pending approvals in process memory; a durable store would be needed for restart-safe production operation.
- Future versions could add richer evidence citations, persistent findings, confidence calibration, hosted deployment, and support for additional source hosts and approval systems.
