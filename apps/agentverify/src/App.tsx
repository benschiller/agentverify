import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";

type Candidate = {
  role: string;
  traceId: string;
  agent: string;
  observedAt: string;
  sourceEvidence: { repository: string; path: string };
  renderEvidence: { queryWindow: { start: string; end: string }; status: string };
  evidenceStatus: string;
  evaluationStatus: string;
};

type Trace = {
  agent_input?: unknown;
  agent_output?: unknown;
  stats?: { span_count?: number; error_count?: number; total_duration_ms?: number };
};

type GitHubSource = {
  repository: string;
  path: string;
  content: string;
  url: string;
  intentExplanation: string;
};

type Verdict = {
  verdict: "MATCH" | "PROBLEM" | "UNCERTAIN";
  observed: string;
  expected: string;
  comparison: string;
};

type Manifest = {
  sources: { lemma: { apiBase: string } };
  candidates: Candidate[];
};

const emptyManifest: Manifest = {
  sources: { lemma: { apiBase: "https://api.uselemma.ai" } },
  candidates: [],
};

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
}

function shortId(value: string) {
  return value.slice(0, 8);
}

function Card({ label, eyebrow, children, tone = "neutral", visible = true }: {
  label: string; eyebrow: string; children: ReactNode; tone?: "neutral" | "warning"; visible?: boolean;
}) {
  return <article className={`evidence-card ${tone} ${visible ? "is-visible" : ""}`}>
    <div className="card-heading"><span className="card-eyebrow">{eyebrow}</span><span className="card-label">{label}</span></div>
    {children}
  </article>;
}

const stageMessages = {
  lemma: ["Pulling the live Lemma trace…", "Reading what the agent actually did…", "Summarizing observed behavior…"],
  github: ["Finding the source used by this trace…", "Reading the relevant GitHub code…", "Explaining what should happen…"],
  verdict: ["Comparing what happened with what should happen…", "Checking whether the behaviors match…"],
  slack: ["Sending the finding to Slack for approval…", "Waiting for a human decision…"],
  issue: ["Approval received…", "Creating the GitHub issue…"],
};

export function App() {
  const [manifest, setManifest] = useState<Manifest>(emptyManifest);
  const [selectedId, setSelectedId] = useState("");
  const [stage, setStage] = useState<"idle" | "lemma" | "github" | "verdict" | "slack" | "issue" | "done">("idle");
  const [message, setMessage] = useState(stageMessages.lemma[0]);
  const [trace, setTrace] = useState<Trace | null>(null);
  const [observed, setObserved] = useState("");
  const [github, setGithub] = useState<GitHubSource | null>(null);
  const [verdict, setVerdict] = useState<Verdict | null>(null);
  const [slackApproval, setSlackApproval] = useState<{ requestId: string; status: string } | null>(null);
  const [issueUrl, setIssueUrl] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/runs")
      .then((response) => {
        if (!response.ok) throw new Error(`Live Lemma request failed: ${response.status}`);
        return response.json() as Promise<Candidate[]>;
      })
      .then((candidates) => {
        setManifest((current) => ({ ...current, candidates }));
        setSelectedId(candidates[0]?.traceId ?? "");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : "Unable to load live runs"));
  }, []);

  useEffect(() => {
    if (stage === "idle" || stage === "done") return;
    const messages = stageMessages[stage];
    let index = 0;
    setMessage(messages[0]);
    const timer = window.setInterval(() => {
      index = (index + 1) % messages.length;
      setMessage(messages[index]);
    }, 1200);
    return () => window.clearInterval(timer);
  }, [stage]);

  const selected = useMemo(() => manifest.candidates.find((candidate) => candidate.traceId === selectedId), [manifest.candidates, selectedId]);

  function reset() {
    setStage("idle");
    setTrace(null);
    setObserved("");
    setGithub(null);
    setVerdict(null);
    setSlackApproval(null);
    setIssueUrl("");
    setError("");
  }

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const result = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(result.error ?? `${path} failed: ${response.status}`);
    return result;
  }

  async function investigate() {
    if (!selected) return;
    reset();
    setStage("lemma");
    try {
      const lemma = await post<{ trace: Trace; observed: string }>("/api/lemma", { traceId: selected.traceId });
      setTrace(lemma.trace);
      setObserved(lemma.observed);
      setStage("github");
      const source = await post<GitHubSource>("/api/github/source", { trace: lemma.trace, observed: lemma.observed });
      setGithub(source);
      setStage("verdict");
      const result = await post<Verdict>("/api/verdict", { observed: lemma.observed, expected: source.intentExplanation });
      setVerdict(result);
      if (result.verdict !== "MATCH") {
        setStage("slack");
        const approval = await post<{ requestId: string; status: string }>("/api/slack/request", {
          traceId: selected.traceId,
          verdict: result.verdict,
          observed: result.observed,
          expected: result.expected,
          comparison: result.comparison,
        });
        setSlackApproval(approval);
        await waitForApproval(approval.requestId, selected.traceId, result, lemma.observed, source.intentExplanation);
      }
      setStage("done");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Investigation failed");
      setStage("done");
    }

    async function waitForApproval(requestId: string, traceId: string, result: Verdict, observedText: string, expectedText: string) {
      for (;;) {
        await new Promise((resolve) => window.setTimeout(resolve, 1500));
        const status = await fetch(`/api/slack/status?requestId=${encodeURIComponent(requestId)}`).then(async (response) => {
          const value = await response.json();
          if (!response.ok) throw new Error(value.error ?? "Slack status failed");
          return value as { requestId: string; status: string };
        });
        setSlackApproval(status);
        if (status.status === "rejected") return;
        if (status.status !== "approved") continue;
        setStage("issue");
        const issue = await post<{ url: string }>("/api/github/issue", {
          approvalRequestId: requestId,
          title: `AgentVerify: ${result.verdict} for ${traceId.slice(0, 8)}`,
          body: [
            "## AgentVerify finding",
            "",
            `- Trace: \`${traceId}\``,
            `- Verdict: **${result.verdict}**`,
            "",
            "### What happened",
            observedText,
            "",
            "### What should happen",
            expectedText,
            "",
            "### Comparison",
            result.comparison,
            "",
            "AgentVerify did not modify code or deploy changes.",
          ].join("\n"),
        });
        setIssueUrl(issue.url);
        return;
      }
    }
  }

  return <main className="app-shell">
    <header className="topbar">
      <div className="brand-lockup"><span className="brand-mark">AV</span><div><span className="brand-name">AgentVerify</span><span className="brand-subtitle">production behavior, verified</span></div></div>
      <div className="live-indicator"><span className="live-dot" />LIVE LEMMA DATA</div>
    </header>
    <div className="workspace">
      <aside className="run-rail">
        <div className="rail-heading"><div><span className="section-kicker">Observed runs</span><h1>Choose an execution</h1></div><span className="run-count">{manifest.candidates.length}</span></div>
        <p className="rail-note">Executions pulled directly from Lemma. Choose one to compare what happened with what the source says should happen.</p>
        <div className="run-list">{manifest.candidates.map((candidate) => <button className={`run-item ${candidate.traceId === selectedId ? "selected" : ""}`} key={candidate.traceId} onClick={() => { setSelectedId(candidate.traceId); reset(); }}>
          <span className={`status-dot ${candidate.role === "observed-issue" ? "amber" : "gray"}`} />
          <span className="run-copy"><strong>{candidate.agent}</strong><span>{formatDate(candidate.observedAt)}</span><code>{shortId(candidate.traceId)}…</code></span><span className="run-chevron">↗</span>
        </button>)}</div>
        <div className="rail-footer"><span>Source</span><code>{manifest.sources.lemma.apiBase.replace("https://", "")}</code><span className="fixture-badge">LIVE DATA</span></div>
      </aside>
      <section className="investigation-panel">
        {selected ? <><div className="investigation-header"><div><span className="section-kicker">Investigation console</span><h2>{selected.agent} <span>/</span> {shortId(selected.traceId)}</h2><p className="header-meta">Observed {formatDate(selected.observedAt)} · <strong>{selected.evidenceStatus}</strong></p></div><button className="investigate-button" onClick={investigate} disabled={stage !== "idle" && stage !== "done"}>{stage !== "idle" && stage !== "done" ? "Investigating…" : "Investigate run"}</button></div>
          {stage === "idle" ? <div className="empty-state"><span className="empty-glyph">◎</span><h3>Ready when you are</h3><p>Gather the live trace, source intent, and a simple comparison.</p></div> : <div className="evidence-stack">
            <Card label="Lemma trace" eyebrow="01 · what happened" visible><div className="trace-summary"><code>{selected.traceId}</code><span className="trace-agent">{selected.agent}</span></div>
              {trace && observed ? <><p className="live-explanation">{observed}</p><ul className="observation-list"><li>{trace.stats?.span_count ?? 0} spans observed</li><li>{trace.stats?.error_count ?? 0} trace errors recorded</li></ul></> : <div className="loading-state"><span className="loading-spinner" />{stage === "lemma" ? message : "Lemma evidence collected."}</div>}
            </Card>
            {(stage === "github" || stage === "verdict" || stage === "slack" || stage === "issue" || stage === "done") && <Card label="GitHub source" eyebrow="02 · what should happen" visible><div className="source-location"><code>{github?.repository}/{github?.path}</code></div>
              {github ? <><div className="intent-explanation"><span className="intent-label">Expected behavior, in plain English</span><p>{github.intentExplanation}</p></div><pre>{github.content}</pre><a className="source-link" href={github.url} target="_blank" rel="noreferrer">Open source on GitHub ↗</a></> : <div className="loading-state"><span className="loading-spinner" />{message}</div>}
            </Card>}
            {(stage === "verdict" || stage === "slack" || stage === "issue" || stage === "done") && <Card label="Verdict" eyebrow="03 · do they match?" tone="warning" visible><div className="verdict-row"><span className="verdict-pill">{verdict?.verdict ?? "WAITING"}</span></div><p>{verdict?.comparison ?? message}</p></Card>}
            {(stage === "slack" || stage === "issue" || stage === "done") && verdict?.verdict !== "MATCH" && <Card label="Slack approval" eyebrow="04 · human decision" tone="warning" visible><p>{slackApproval?.status === "approved" ? "Approved. Creating the GitHub issue…" : slackApproval?.status === "rejected" ? "Rejected. No GitHub issue will be created." : "Approval request sent to Slack. Waiting for your decision…"}</p></Card>}
            {(stage === "issue" || stage === "done") && issueUrl && <Card label="GitHub issue" eyebrow="05 · created after approval" visible><p><a className="source-link" href={issueUrl} target="_blank" rel="noreferrer">Open created issue ↗</a></p></Card>}
          </div>}
          {error && <p className="api-error">{error}</p>}
        </> : <div className="empty-state"><span className="empty-glyph">—</span><h3>No live runs loaded</h3><p>{error || "Waiting for Lemma."}</p></div>}
      </section>
    </div>
  </main>;
}
