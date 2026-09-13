import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { fetchGithubSource, listGithubSourcePaths } from "./server/githubSource";
import { createGithubIssue } from "./server/githubIssue";

type Trace = { agent_name?: string; service_name?: string; agent_input?: unknown; agent_output?: unknown; has_error?: boolean; stats?: unknown; spans?: Array<{ name?: string; status_code?: string; status_description?: string; attributes?: unknown }>; tool_calls?: unknown };
function modelEndpoint(url: string) { const normalized = url.replace(/\/+$/, ""); return normalized.endsWith("/chat/completions") ? normalized : `${normalized}/chat/completions`; }
function traceSummary(trace: Trace) { return { agent: trace.agent_name ?? trace.service_name, input: trace.agent_input, output: trace.agent_output, hasError: trace.has_error, stats: trace.stats, tools: trace.tool_calls, spans: trace.spans?.map((span) => ({ name: span.name, status: span.status_code, description: span.status_description, attributes: span.attributes })) }; }
async function askModel(system: string, user: unknown, env: Record<string, string>) {
  const apiKey = env.OPENAI_COMPATIBLE_API_KEY, baseUrl = env.OPENAI_COMPATIBLE_URL, model = env.OPENAI_COMPATIBLE_MODEL;
  if (!apiKey || !baseUrl || !model) throw new Error("OPENAI_COMPATIBLE_API_KEY, OPENAI_COMPATIBLE_URL, and OPENAI_COMPATIBLE_MODEL are required");
  const response = await fetch(modelEndpoint(baseUrl), { method: "POST", headers: { Authorization: "Bearer " + apiKey, "Content-Type": "application/json" }, body: JSON.stringify({ model, temperature: 0, response_format: { type: "json_object" }, messages: [{ role: "system", content: system }, { role: "user", content: JSON.stringify(user) }] }) });
  if (!response.ok) throw new Error(`OpenAI-compatible reasoner failed: ${response.status} ${await response.text()}`);
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error("Reasoner returned no message content");
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object") throw new Error("Reasoner returned invalid JSON");
  return parsed as Record<string, unknown>;
}
function stringField(value: Record<string, unknown>, field: string) { if (typeof value[field] !== "string" || !value[field]) throw new Error(`Reasoner response is missing ${field}`); return value[field] as string; }
function jsonResponse(response: import("node:http").ServerResponse, value: unknown, status = 200) { response.statusCode = status; response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify(value)); }
async function body(request: import("node:http").IncomingMessage) { const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
function bridgeHeaders(env: Record<string, string>) { return env.SLACK_BRIDGE_TOKEN ? { Authorization: "Bearer " + env.SLACK_BRIDGE_TOKEN } : {}; }
function bridgeUrl(env: Record<string, string>) {
  const value = env.SLACK_BRIDGE_URL ?? "http://127.0.0.1:3001";
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}
function isSourceFile(path: string) {
  return /\.(c|cc|cpp|cs|go|java|js|jsx|mjs|py|rb|rs|ts|tsx|vue|svelte)$/i.test(path);
}

function apiPlugin(env: Record<string, string>): Plugin {
  return { name: "agentverify-api", configureServer(server) {
    server.middlewares.use("/api/runs", async (req, res) => {
      if (req.method !== "GET") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const project = env.LEMMA_PROJECT_ID, key = env.LEMMA_API_KEY; if (!project || !key) throw new Error("LEMMA_PROJECT_ID and LEMMA_API_KEY are required");
        const result = await fetch(`https://api.uselemma.ai/traces/search?project_id=${encodeURIComponent(project)}&limit=12`, { headers: { Authorization: "Bearer " + key } });
        if (!result.ok) throw new Error(`Lemma search failed: ${result.status}`);
        const traces = await result.json() as Array<{ id: string; service_name?: string; timestamp: string; issue_extraction?: { issue_count?: number } }>;
        const candidates = await Promise.all(traces.map(async (trace) => {
          const detail = await fetch(
            `https://api.uselemma.ai/traces/${encodeURIComponent(trace.id)}?project_id=${encodeURIComponent(project)}`,
            { headers: { Authorization: "Bearer " + key } },
          );
          const detailTrace = detail.ok ? await detail.json() as { agent_name?: string } : {};
          return {
            role: (trace.issue_extraction?.issue_count ?? 0) > 0 ? "observed-issue" : "observed-run",
            traceId: trace.id,
            agent: detailTrace.agent_name ?? trace.service_name ?? "unknown service",
            observedAt: trace.timestamp,
            sourceEvidence: { repository: env.GITHUB_REPOSITORY ?? "configured repository", path: "trace-derived" },
            renderEvidence: { queryWindow: { start: trace.timestamp, end: trace.timestamp }, status: "deferred" },
            evidenceStatus: "live Lemma trace",
            evaluationStatus: "not-yet-compared",
          };
        }));
        return jsonResponse(res, candidates);
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "Unable to load live runs" }, 502); }
    });
    server.middlewares.use("/api/lemma", async (req, res) => {
      if (req.method !== "POST") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const payload = await body(req) as { traceId?: string }, project = env.LEMMA_PROJECT_ID, key = env.LEMMA_API_KEY;
        if (!payload.traceId || !project || !key) throw new Error("traceId, LEMMA_PROJECT_ID, and LEMMA_API_KEY are required");
        const result = await fetch(`https://api.uselemma.ai/traces/${encodeURIComponent(payload.traceId)}?project_id=${encodeURIComponent(project)}`, { headers: { Authorization: "Bearer " + key } });
        if (!result.ok) throw new Error(`Lemma request failed: ${result.status}`);
        const trace = await result.json() as Trace;
        const explanation = await askModel("Describe only what happened in this live agent trace. Return JSON with one field: observed. Write one concrete, human-readable paragraph. Mention actual errors or malformed tool inputs when present.", { trace: traceSummary(trace) }, env);
        return jsonResponse(res, { trace, observed: stringField(explanation, "observed") });
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "Lemma stage failed" }, 502); }
    });
    server.middlewares.use("/api/github/source", async (req, res) => {
      if (req.method !== "POST") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const payload = await body(req) as { trace?: Trace; observed?: string }, repository = env.GITHUB_REPOSITORY;
        if (!payload.trace || !payload.observed || !repository) throw new Error("trace, observed, and GITHUB_REPOSITORY are required");
        const paths = (await listGithubSourcePaths(repository)).filter(isSourceFile);
        if (paths.length === 0) throw new Error("No source files were found in the configured GitHub repository");
        const location = await askModel("Choose the single source-code file that implements the live agent identified by the trace. Use the agent name, trace spans, tool calls, and observed behavior to choose the implementation file, not documentation, tests, examples, configuration, or reference material. Return JSON with exactly one field: path. Copy it exactly from the supplied source-code file list.", { observed: payload.observed, trace: traceSummary(payload.trace), repositorySourceFiles: paths }, env);
        const path = stringField(location, "path"); if (!paths.includes(path)) throw new Error("Reasoner returned a source path that does not exist");
        const source = await fetchGithubSource({ repository, path });
        const intent = await askModel("Explain the behavior required by this live agent implementation and compare it with the supplied live trace. Return JSON with exactly two fields: expected (one concise human-readable paragraph) and excerpt (short pertinent line-numbered snippet). Do not describe repository documentation, hypothetical systems, or unrelated files. Use only the supplied source and trace.", { source: source.content, path, observed: payload.observed, trace: traceSummary(payload.trace) }, env);
        return jsonResponse(res, { ...source, content: stringField(intent, "excerpt"), intentExplanation: stringField(intent, "expected") });
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "GitHub stage failed" }, 502); }
    });
    server.middlewares.use("/api/verdict", async (req, res) => {
      if (req.method !== "POST") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const payload = await body(req) as { observed?: string; expected?: string }; if (!payload.observed || !payload.expected) throw new Error("observed and expected are required");
        const verdict = await askModel("Compare what happened with what should happen. Return JSON with exactly four fields: verdict (MATCH, PROBLEM, or UNCERTAIN), observed, expected, comparison. Keep every field concise and concrete.", payload, env);
        const value = stringField(verdict, "verdict"); if (!["MATCH", "PROBLEM", "UNCERTAIN"].includes(value)) throw new Error("Invalid verdict");
        return jsonResponse(res, { verdict: value, observed: stringField(verdict, "observed"), expected: stringField(verdict, "expected"), comparison: stringField(verdict, "comparison") });
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "Verdict stage failed" }, 502); }
    });
    server.middlewares.use("/api/slack/request", async (req, res) => {
      if (req.method !== "POST") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const payload = await body(req) as { channelId?: string; traceId?: string; verdict?: string; observed?: string; expected?: string; comparison?: string };
        const channelId = payload.channelId ?? env.SLACK_CHANNEL_ID, bridge = bridgeUrl(env);
        if (!channelId || !payload.traceId || !payload.comparison) throw new Error("SLACK_CHANNEL_ID, traceId, and comparison are required");
        const requestId = randomUUID(), result = await fetch(`${bridge}/agentverify/approval`, { method: "POST", headers: { "Content-Type": "application/json", ...bridgeHeaders(env) }, body: JSON.stringify({ ...payload, channelId, requestId }) });
        const value = await result.json() as { error?: string }; if (!result.ok) throw new Error(value.error ?? "Slack bridge failed"); return jsonResponse(res, value);
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "Slack request failed" }, 502); }
    });
    server.middlewares.use("/api/slack/status", async (req, res) => {
      if (req.method !== "GET") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try { const id = new URL(req.url ?? "/", "http://127.0.0.1").searchParams.get("requestId"); if (!id) throw new Error("requestId is required"); const result = await fetch(`${bridgeUrl(env)}/agentverify/approval/${encodeURIComponent(id)}`, { headers: bridgeHeaders(env) }); const value = await result.json() as { error?: string }; if (!result.ok) throw new Error(value.error ?? "Slack status failed"); return jsonResponse(res, value); }
      catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "Slack status failed" }, 502); }
    });
    server.middlewares.use("/api/github/issue", async (req, res) => {
      if (req.method !== "POST") return jsonResponse(res, { error: "Method Not Allowed" }, 405);
      try {
        const payload = await body(req) as { approvalRequestId?: string; title?: string; body?: string }; if (!payload.approvalRequestId || !payload.title || !payload.body) throw new Error("approvalRequestId, title, and body are required");
        const status = await fetch(`${bridgeUrl(env)}/agentverify/approval/${encodeURIComponent(payload.approvalRequestId)}`, { headers: bridgeHeaders(env) }), approval = await status.json();
        const approved = approval as { error?: string; status?: string };
        if (!status.ok) throw new Error(approved.error ?? "Unable to verify Slack approval"); if (approved.status !== "approved") throw new Error(`GitHub issue blocked: Slack approval is ${approved.status}`);
        const repository = env.GITHUB_REPOSITORY; if (!repository) throw new Error("GITHUB_REPOSITORY is required"); return jsonResponse(res, { url: await createGithubIssue(repository, payload.title, payload.body), repository });
      } catch (error) { return jsonResponse(res, { error: error instanceof Error ? error.message : "GitHub issue creation failed" }, 502); }
    });
  } };
}

export default defineConfig(({ mode }) => {
  const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
  const env = loadEnv(mode, repositoryRoot, "");
  return { envDir: repositoryRoot, plugins: [react(), apiPlugin(env)], publicDir: "phase0", server: { fs: { strict: true } } };
});
