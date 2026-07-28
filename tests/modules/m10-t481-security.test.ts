/**
 * T481 — Security Hardening tests.
 *
 * Covers:
 *   T481.1 — New security headers (Referrer-Policy, Permissions-Policy, X-XSS-Protection)
 *   T481.2 — POST /policy/rules/test and POST /policy/evaluate require viewer auth
 *   T481.3 — ApprovalQueue webhook HMAC signing (X-AgentsGate-Signature header)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { DashboardAPI, ApprovalQueue } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Make a raw HTTP request and return status, headers, and body text. */
async function rawReq(
  port: number,
  path: string,
  opts: {
    method?: string;
    key?: string;
    body?: string;
  } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (opts.key) headers['x-api-key'] = opts.key;
    if (opts.body) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = String(Buffer.byteLength(opts.body));
    }
    const r = http.request(
      { hostname: '127.0.0.1', port, path, method: opts.method ?? 'GET', headers },
      res => {
        let body = '';
        res.on('data', (c: Buffer) => { body += c.toString(); });
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body }),
        );
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

// ── T481.1 — Security headers ─────────────────────────────────────────────────

describe('T481.1 — Security headers on JSON responses', () => {
  let store: StateStore;
  let api: DashboardAPI;
  let port: number;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store);
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('includes Referrer-Policy: strict-origin-when-cross-origin on GET /health', async () => {
    const { headers } = await rawReq(port, '/health');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('includes Permissions-Policy: camera=(), microphone=(), geolocation=() on GET /health', async () => {
    const { headers } = await rawReq(port, '/health');
    expect(headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
  });

  it('includes X-XSS-Protection: 0 on GET /health', async () => {
    const { headers } = await rawReq(port, '/health');
    expect(headers['x-xss-protection']).toBe('0');
  });

  it('includes Referrer-Policy on GET /operations JSON response', async () => {
    const { headers } = await rawReq(port, '/operations');
    expect(headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
  });

  it('includes existing X-Content-Type-Options: nosniff still present', async () => {
    const { headers } = await rawReq(port, '/health');
    expect(headers['x-content-type-options']).toBe('nosniff');
  });

  it('includes existing X-Frame-Options: DENY still present', async () => {
    const { headers } = await rawReq(port, '/health');
    expect(headers['x-frame-options']).toBe('DENY');
  });
});

// ── T481.2 — Policy endpoints require viewer auth ─────────────────────────────

describe('T481.2 — POST /policy/rules/test and POST /policy/evaluate require auth', () => {
  let store: StateStore;
  let api: DashboardAPI;
  let port: number;

  const VIEWER_KEY = 'viewer-secret-key';
  const samplePolicyRuleBody = JSON.stringify({
    rule: {
      id: 'test-rule',
      match: { tool: 'filesystem' },
      action: 'block',
    },
    operation: {
      id: 'op-test-1',
      tool: 'filesystem',
      method: 'read_file',
      agentId: 'agent-test',
      params: { path: '/tmp/x.txt' },
      sessionId: 'session-test',
      timestamp: new Date().toISOString(),
    },
  });

  const sampleEvaluateBody = JSON.stringify({
    id: 'op-test-2',
    tool: 'filesystem',
    method: 'read_file',
    agentId: 'agent-test',
    params: { path: '/tmp/x.txt' },
    sessionId: 'session-test',
    timestamp: new Date().toISOString(),
  });

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    // Configure with RBAC roles map so viewer key grants viewer role
    api = new DashboardAPI(store, {
      roles: {
        [VIEWER_KEY]: 'viewer',
      },
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('POST /policy/rules/test returns 401 when no API key provided', async () => {
    const { status } = await rawReq(port, '/policy/rules/test', {
      method: 'POST',
      body: samplePolicyRuleBody,
    });
    expect(status).toBe(401);
  });

  it('POST /policy/evaluate returns 401 when no API key provided', async () => {
    const { status } = await rawReq(port, '/policy/evaluate', {
      method: 'POST',
      body: sampleEvaluateBody,
    });
    expect(status).toBe(401);
  });

  it('POST /policy/rules/test returns 401 when wrong API key provided', async () => {
    const { status } = await rawReq(port, '/policy/rules/test', {
      method: 'POST',
      key: 'wrong-key',
      body: samplePolicyRuleBody,
    });
    expect(status).toBe(401);
  });

  it('POST /policy/evaluate returns 401 when wrong API key provided', async () => {
    const { status } = await rawReq(port, '/policy/evaluate', {
      method: 'POST',
      key: 'wrong-key',
      body: sampleEvaluateBody,
    });
    expect(status).toBe(401);
  });

  it('POST /policy/rules/test passes auth check with valid viewer key (non-401)', async () => {
    const { status } = await rawReq(port, '/policy/rules/test', {
      method: 'POST',
      key: VIEWER_KEY,
      body: samplePolicyRuleBody,
    });
    // Auth passes; no policy loaded → 503, but NOT 401 or 403
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });

  it('POST /policy/evaluate passes auth check with valid viewer key (non-401)', async () => {
    const { status } = await rawReq(port, '/policy/evaluate', {
      method: 'POST',
      key: VIEWER_KEY,
      body: sampleEvaluateBody,
    });
    // Auth passes; no policy loaded → 503, but NOT 401 or 403
    expect(status).not.toBe(401);
    expect(status).not.toBe(403);
  });
});

// ── T481.3 — ApprovalQueue webhook HMAC signing ───────────────────────────────

describe('T481.3 — ApprovalQueue outbound webhook includes X-AgentsGate-Signature when secret set', () => {
  it('signs webhook payload with correct HMAC-SHA256 when webhookSecret is configured', async () => {
    const SECRET = 'test-signing-secret-xyz';
    const capturedHeaders: Record<string, string> = {};
    let capturedBody = '';

    // Spin up a local HTTP server to receive the webhook
    const server = http.createServer((req, incomingRes) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        capturedBody = Buffer.concat(chunks).toString();
        // Capture headers
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') capturedHeaders[k.toLowerCase()] = v;
        }
        incomingRes.writeHead(200);
        incomingRes.end('ok');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const webhookPort = addr.port;

    try {
      const queue = new ApprovalQueue({
        webhookUrl: `http://127.0.0.1:${webhookPort}/webhook`,
        webhookSecret: SECRET,
        allowPrivateWebhookUrls: true, // required for loopback in tests
      });

      // Enqueue an operation to trigger the webhook POST
      const op = {
        id: 'op-hmac-test',
        agentId: 'agent-1',
        tool: 'filesystem',
        method: 'write_file',
        params: { path: '/tmp/sensitive.txt', content: 'data' },
        timestamp: new Date(),
        sessionId: 'session-hmac',
      };
      queue.enqueue(op, 0.85);

      // Wait for the async webhook POST to complete
      await new Promise<void>(resolve => setTimeout(resolve, 200));

      // Verify the signature header is present
      expect(capturedHeaders['x-agentsgate-signature']).toBeDefined();

      // Verify the HMAC is correct
      const expectedSig =
        'sha256=' +
        createHmac('sha256', SECRET).update(capturedBody).digest('hex');
      expect(capturedHeaders['x-agentsgate-signature']).toBe(expectedSig);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('does NOT include X-AgentsGate-Signature when webhookSecret is not set', async () => {
    const capturedHeaders: Record<string, string> = {};

    const server = http.createServer((req, incomingRes) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        for (const [k, v] of Object.entries(req.headers)) {
          if (typeof v === 'string') capturedHeaders[k.toLowerCase()] = v;
        }
        incomingRes.writeHead(200);
        incomingRes.end('ok');
      });
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const addr = server.address() as { port: number };
    const webhookPort = addr.port;

    try {
      const queue = new ApprovalQueue({
        webhookUrl: `http://127.0.0.1:${webhookPort}/webhook`,
        // no webhookSecret
        allowPrivateWebhookUrls: true,
      });

      const op = {
        id: 'op-no-hmac-test',
        agentId: 'agent-1',
        tool: 'filesystem',
        method: 'write_file',
        params: { path: '/tmp/test.txt', content: 'data' },
        timestamp: new Date(),
        sessionId: 'session-no-hmac',
      };
      queue.enqueue(op, 0.85);

      await new Promise<void>(resolve => setTimeout(resolve, 200));

      expect(capturedHeaders['x-agentsgate-signature']).toBeUndefined();
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
