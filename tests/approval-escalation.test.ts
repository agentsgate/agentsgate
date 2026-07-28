/**
 * T218 — Approval timeout escalation
 *
 * Tests for ApprovalQueue escalateAfterMs option.
 * Uses real Node http servers on ports 51500–51599 — no fetch mocks.
 * Runs on real timers with a short escalateAfterMs and zero retry backoff,
 * and drains fire-and-forget webhook chains via queue.whenIdle().
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import crypto from 'node:crypto';
import { ApprovalQueue } from '../src/modules/m10-dashboard/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(): MCPOperation {
  return {
    id: crypto.randomUUID(),
    agentId: 'agent-a',
    tool: 'fs',
    method: 'write',
    params: {},
    timestamp: new Date(),
    sessionId: 'session-escalation',
  };
}

interface RequestRecord {
  event: string;
  id?: string;
  agentId?: string;
  tool?: string;
  [key: string]: unknown;
}

interface TestServer {
  url: string;
  requests: RequestRecord[];
  server: http.Server;
  close: () => Promise<void>;
}

function makeServer(port: number, statusCode = 200): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    const requests: RequestRecord[] = [];
    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        try {
          requests.push(JSON.parse(body) as RequestRecord);
        } catch {
          requests.push({ event: 'parse-error', rawBody: body } as RequestRecord);
        }
        res.writeHead(statusCode);
        res.end();
      });
    });
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        server,
        close: () => new Promise((res, rej) => server.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

/** Wait until the requests array has at least `target` entries. */
function waitForRequests(
  requests: RequestRecord[],
  target: number,
  timeoutMs = 8_000,
  pollMs = 30,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = setInterval(() => {
      if (requests.length >= target) {
        clearInterval(tick);
        resolve();
      } else if (Date.now() > deadline) {
        clearInterval(tick);
        reject(new Error(`Timed out waiting for ${target} requests; got ${requests.length}`));
      }
    }, pollMs);
  });
}

const ESCALATE_AFTER_MS = 50;

function makeQueue(webhookUrl: string, escalateAfterMs?: number, dashboardBaseUrl?: string): ApprovalQueue {
  return new ApprovalQueue({
    webhookUrl,
    escalateAfterMs,
    dashboardBaseUrl,
    allowPrivateWebhookUrls: true,
    webhookRetryBackoffMs: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalQueue escalation (T218)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: No escalateAfterMs — only one webhook POST fires ────────────────
  it('no escalateAfterMs set → only one webhook POST (approval_required), no escalation', async () => {
    const srv = await makeServer(51500);

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(srv.url);
      queue.enqueue(makeOp(), 0.7);
      await queue.whenIdle();
      // Extra pause to confirm no second request arrives
      await new Promise((r) => setTimeout(r, 200));

      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0]!.event).toBe('approval_required');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  }, 10_000);

  // ── Test 2: escalateAfterMs set, approval stays pending → escalation fires ──
  it('escalateAfterMs set, approval stays pending → escalation fires with event: approval_escalation', async () => {
    const srv = await makeServer(51501);

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(srv.url, ESCALATE_AFTER_MS);
      queue.enqueue(makeOp(), 0.8);

      // Wait for both POSTs: approval_required + approval_escalation
      await waitForRequests(srv.requests, 2, 8_000);
      await queue.whenIdle();

      const events = srv.requests.map((r) => r.event);
      expect(events).toContain('approval_required');
      expect(events).toContain('approval_escalation');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  }, 15_000);

  // ── Test 3: Approval resolved before escalation timer → escalation does NOT fire
  it('approval resolved before escalation timer → escalation does NOT fire', async () => {
    const srv = await makeServer(51502);

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(srv.url, ESCALATE_AFTER_MS);
      const approval = queue.enqueue(makeOp(), 0.75);

      // Resolve immediately — the escalation timer is still pending and gets cancelled
      queue.resolve(approval.id);

      await queue.whenIdle();
      // Wait past the escalation window to confirm no escalation POST arrives
      await new Promise((r) => setTimeout(r, ESCALATE_AFTER_MS * 4));

      const events = srv.requests.map((r) => r.event);
      expect(events).not.toContain('approval_escalation');
      expect(events).toContain('approval_required');
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await srv.close();
    }
  }, 10_000);

  // ── Test 4: Escalation payload contains correct fields ──────────────────────
  it('escalation payload contains correct id, agentId, tool, event: approval_escalation', async () => {
    const srv = await makeServer(51503);

    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const op = makeOp();
      const queue = makeQueue(srv.url, ESCALATE_AFTER_MS, 'http://localhost:4001');
      queue.enqueue(op, 0.9);

      await waitForRequests(srv.requests, 2, 8_000);
      await queue.whenIdle();

      const escalation = srv.requests.find((r) => r.event === 'approval_escalation');
      expect(escalation).toBeDefined();
      expect(escalation!.event).toBe('approval_escalation');
      expect(escalation!.id).toBe(op.id);
      expect(escalation!.agentId).toBe(op.agentId);
      expect(escalation!.tool).toBe(op.tool);
    } finally {
      await srv.close();
    }
  }, 15_000);

  // ── Test 5: Webhook always fails → console.warn emitted for escalation failure
  it('escalateAfterMs set but webhook always fails → console.warn emitted for escalation failure', async () => {
    // Server returns 500 on every request
    const srv = await makeServer(51504, 500);

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(srv.url, ESCALATE_AFTER_MS);
      queue.enqueue(makeOp(), 0.85);

      // Initial chain retries 3x, then the escalation chain retries 3x = 6 POSTs
      await waitForRequests(srv.requests, 6, 8_000);
      await queue.whenIdle();

      const warnMessages = warnSpy.mock.calls.map((c) => String(c[0]));
      const escalationWarn = warnMessages.find((m) => m.includes('Escalation webhook failed'));
      expect(escalationWarn).toBeDefined();
    } finally {
      await srv.close();
    }
  }, 15_000);
});
