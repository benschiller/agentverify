import { createServer } from 'node:http';

const approvals = new Map();

function slackSummary(value, limit = 220) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length <= limit) return text;
  const boundary = text.slice(0, limit).lastIndexOf('.');
  return `${text.slice(0, boundary > 80 ? boundary + 1 : limit - 1).trim()}…`;
}

function json(response, status, value) {
  response.statusCode = status;
  response.setHeader('content-type', 'application/json');
  response.end(JSON.stringify(value));
}

function authorized(request) {
  const expected = process.env.SLACK_BRIDGE_TOKEN;
  return !expected || request.headers.authorization === `Bearer ${expected}`;
}

export function registerBridge(app, port = Number(process.env.SLACK_BRIDGE_PORT ?? 3001)) {
  const server = createServer(async (request, response) => {
    if (!authorized(request)) return json(response, 401, { error: 'Unauthorized' });
    const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
    if (request.method === 'GET' && url.pathname === '/health') return json(response, 200, { ok: true });

    const match = url.pathname.match(/^\/agentverify\/approval\/([^/]+)$/);
    if (request.method === 'GET' && match) {
      const approval = approvals.get(match[1]);
      return approval ? json(response, 200, approval) : json(response, 404, { error: 'Approval request not found' });
    }

    if (request.method !== 'POST' || url.pathname !== '/agentverify/approval') {
      return json(response, 404, { error: 'Not found' });
    }
    try {
      const chunks = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (!payload.requestId || !payload.channelId || !payload.traceId || !payload.comparison) {
        return json(response, 400, { error: 'requestId, channelId, traceId, and comparison are required' });
      }
      const message = await app.client.chat.postMessage({
        channel: payload.channelId,
        text: `AgentVerify found a ${payload.verdict} result for ${payload.traceId}.`,
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: 'AgentVerify approval needed' } },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `*Verdict:* ${payload.verdict}  ·  *Trace:* \`${payload.traceId.slice(0, 8)}\`\n*Observed:* ${slackSummary(payload.observed)}\n*Expected:* ${slackSummary(payload.expected)}\n*Why it matters:* ${slackSummary(payload.comparison, 260)}`,
            },
          },
          {
            type: 'actions',
            block_id: `agentverify_${payload.requestId}`,
            elements: [
              {
                type: 'button',
                action_id: 'agentverify_approve',
                text: { type: 'plain_text', text: 'Approve GitHub issue' },
                style: 'primary',
                value: payload.requestId,
              },
              {
                type: 'button',
                action_id: 'agentverify_reject',
                text: { type: 'plain_text', text: 'Do not create issue' },
                style: 'danger',
                value: payload.requestId,
              },
            ],
          },
        ],
      });
      const approval = {
        requestId: payload.requestId,
        status: 'pending',
        channelId: payload.channelId,
        messageTs: message.ts,
      };
      approvals.set(payload.requestId, approval);
      return json(response, 200, approval);
    } catch (error) {
      return json(response, 502, { error: error instanceof Error ? error.message : 'Unable to post approval request' });
    }
  });
  server.listen(port, process.env.SLACK_BRIDGE_HOST ?? '0.0.0.0');
  return server;
}

export async function setApproval(requestId, status, messageTs, client) {
  const approval = approvals.get(requestId);
  if (!approval) throw new Error('Approval request not found');
  approvals.set(requestId, { ...approval, status });
  await client.chat.update({
    channel: approval.channelId,
    ts: messageTs,
    text: `AgentVerify approval: ${status}`,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: `AgentVerify approval: *${status}* for request \`${requestId}\`.` },
      },
    ],
  });
}
