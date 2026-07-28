/**
 * T214 — Webhook retry with exponential backoff
 *
 * Tests for ApprovalQueue.postWithRetry() exercised via the public enqueue() interface.
 * Uses real Node http servers on OS-assigned ports — no fetch mocks.
 *
 * Key design note: fireWebhook() is fire-and-forget (void). Tests pass
 * `webhookRetryBackoffMs: 0` so retries run immediately on real timers, and
 * `await queue.whenIdle()` to deterministically wait for each delivery chain
 * to finish — no fake timers, no console.warn safety timeouts, no test bleed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import http from 'node:http';
import { ApprovalQueue } from '../src/modules/m10-dashboard/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeOp(id: string): MCPOperation {
  return {
    id,
    agentId: 'agent-test',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/test.txt' },
    timestamp: new Date(),
    sessionId: 'session-retry',
  };
}

interface TestServer {
  url: string;
  port: number;
  getRequestCount: () => number;
  close: () => Promise<void>;
}

/**
 * Bind a throwaway HTTP server on an OS-assigned port. Never hand-pick one:
 * the 51100-51106 range this file used to use sits inside the ephemeral range
 * (49152-65535 on macOS), so a `listen(0)` in any concurrently running suite
 * can be handed the same number and this file loses the race with EADDRINUSE.
 */
function makeServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse, requestCount: number) => void,
): Promise<TestServer> {
  return new Promise((resolve, reject) => {
    let requestCount = 0;
    const server = http.createServer((req, res) => {
      requestCount += 1;
      handler(req, res, requestCount);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        getRequestCount: () => requestCount,
        close: () => new Promise((res, rej) => server.close(e => (e ? rej(e) : res()))),
      });
    });
  });
}

function makeQueue(webhookUrl: string): ApprovalQueue {
  return new ApprovalQueue({
    webhookUrl,
    allowPrivateWebhookUrls: true,
    webhookRetryBackoffMs: 0,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ApprovalQueue webhook retry (T214)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ── Test 1: success on first attempt ────────────────────────────────────────
  it('succeeds on first attempt — server returns 200, exactly 1 request, no retries', async () => {
    const server = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t1'), 0.8);
      await queue.whenIdle();

      expect(server.getRequestCount()).toBe(1);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 2: fail once, succeed on second attempt ─────────────────────────────
  it('fails once, succeeds on second attempt — exactly 2 total requests, no warn', async () => {
    const server = await makeServer((_req, res, count) => {
      res.writeHead(count === 1 ? 500 : 200);
      res.end(count === 1 ? 'error' : '{}');
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t2'), 0.8);
      await queue.whenIdle();

      expect(server.getRequestCount()).toBe(2);
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 3: all 3 attempts fail (500) ──────────────────────────────────────
  it('all 3 attempts fail (server always 500) — exactly 3 requests, warn emitted', async () => {
    const server = await makeServer((_req, res) => {
      res.writeHead(500);
      res.end('error');
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t3'), 0.9);
      await queue.whenIdle();

      expect(server.getRequestCount()).toBe(3);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 4: network error (connection destroyed) ────────────────────────────
  it('network error (connection destroyed) on all attempts — resolves false, console.warn emitted', async () => {
    const server = await makeServer((_req, res) => {
      // Destroy the socket immediately → fetch() throws a network error
      res.socket?.destroy();
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t4'), 0.95);
      await queue.whenIdle();

      expect(server.getRequestCount()).toBeGreaterThanOrEqual(1);
      expect(warnSpy.mock.calls.find(c => String(c[0]).includes(server.url))).toBeTruthy();
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 5: warn message contains the webhook URL ───────────────────────────
  it('console.warn contains the webhook URL when all attempts fail', async () => {
    const server = await makeServer((_req, res) => {
      res.writeHead(503);
      res.end('service unavailable');
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t5'), 0.9);
      await queue.whenIdle();

      expect(server.getRequestCount()).toBe(3);
      const matchingCall = warnSpy.mock.calls.find(c =>
        String(c[0]).includes(`http://127.0.0.1:${server.port}`)
      );
      expect(matchingCall).toBeTruthy();
      expect(String(matchingCall![0])).toContain('[ApprovalQueue]');
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 6: no warn on success ──────────────────────────────────────────────
  it('no console.warn on successful first-attempt webhook delivery', async () => {
    const server = await makeServer((_req, res) => {
      res.writeHead(200);
      res.end('{}');
    });

    try {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t6'), 0.5);
      await queue.whenIdle();

      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  }, 10_000);

  // ── Test 7: exactly 3 requests when all fail (no 4th) ──────────────────────
  it('exactly 3 requests are sent when all attempts fail — no 4th attempt', async () => {
    const server = await makeServer((_req, res) => {
      res.writeHead(500);
      res.end('fail');
    });

    try {
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const queue = makeQueue(server.url);
      queue.enqueue(makeOp('op-t7'), 0.9);
      await queue.whenIdle();
      // Brief wait to confirm no 4th request arrives
      await new Promise(r => setTimeout(r, 200));

      expect(server.getRequestCount()).toBe(3);
    } finally {
      await server.close();
    }
  }, 10_000);
});
