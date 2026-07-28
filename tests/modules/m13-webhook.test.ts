/**
 * T132 — Anomaly alert webhooks (checkAndNotify).
 */
import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool: string): MCPOperation {
  return {
    id: `op-${Math.random()}`, agentId: 'agent-1', tool, method: 'call',
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

function dec(score: number): ProxyDecision {
  return { action: 'allow', riskScore: score, reasons: [] };
}

async function recordAt(svc: TelemetryService, tool: string, score: number, offsetMs: number) {
  await svc.record(makeOp(tool), dec(score));
  const buf = (svc as unknown as { buffer: Array<{ timestamp: number }> }).buffer;
  buf[buf.length - 1].timestamp = Date.now() - offsetMs;
}

/** Start a minimal HTTP server that captures the first POST body. */
function makeWebhookServer(): Promise<{ url: string; getBody: () => Promise<string>; close: () => Promise<void> }> {
  return new Promise(resolve => {
    let capturedBody = '';
    let resolveBody: (v: string) => void;
    const bodyPromise = new Promise<string>(r => { resolveBody = r; });

    const server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => {
        capturedBody = body;
        resolveBody(capturedBody);
        res.writeHead(200);
        res.end();
      });
    });

    server.listen(0, () => {
      const addr = server.address() as { port: number };
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        getBody: () => bodyPromise,
        close: () => new Promise((res, rej) => server.close(e => e ? rej(e) : res())),
      });
    });
  });
}

describe('TelemetryService.checkAndNotify', () => {
  it('returns empty array and does not POST when no anomalies', async () => {
    const svc = new TelemetryService();
    // Only 2 events — below the 5-event minimum
    await svc.record(makeOp('filesystem'), dec(0.8));
    await svc.record(makeOp('filesystem'), dec(0.9));

    const wh = await makeWebhookServer();
    try {
      const alerts = await svc.checkAndNotify(wh.url, 60_000, 2.0);
      expect(alerts).toHaveLength(0);
    } finally {
      await wh.close();
    }
  });

  it('fires POST with correct payload when anomaly detected', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    // Historical: mean=0.10, stddev=0.02 (alternating 0.08/0.12)
    const hist = [0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12];
    for (const s of hist) await recordAt(svc, 'filesystem', s, windowMs * 0.7);
    // Recent spike
    for (let i = 0; i < 5; i++) await recordAt(svc, 'filesystem', 0.9, windowMs * 0.05);

    const wh = await makeWebhookServer();
    try {
      const alerts = await svc.checkAndNotify(wh.url, windowMs, 2.0);
      expect(alerts.length).toBeGreaterThan(0);

      const rawBody = await wh.getBody();
      const payload = JSON.parse(rawBody) as {
        alerts: Array<{ tool: string; zScore: number; metric: string; detectedAt: string }>;
        detectedAt: string;
      };

      expect(payload.alerts.length).toBeGreaterThan(0);
      expect(payload.alerts[0].tool).toBe('filesystem');
      expect(payload.alerts[0].zScore).toBeGreaterThan(2.0);
      expect(payload.alerts[0].metric).toBe('avg_risk_score');
      expect(typeof payload.alerts[0].detectedAt).toBe('string'); // ISO string
      expect(typeof payload.detectedAt).toBe('string');
    } finally {
      await wh.close();
    }
  });

  it('silently swallows webhook network errors and still returns alerts', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    const hist = [0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12];
    for (const s of hist) await recordAt(svc, 'filesystem', s, windowMs * 0.7);
    for (let i = 0; i < 5; i++) await recordAt(svc, 'filesystem', 0.9, windowMs * 0.05);

    // Use a port with nothing listening — should not throw
    await expect(
      svc.checkAndNotify('http://127.0.0.1:19999', windowMs, 2.0)
    ).resolves.toBeTruthy();
  });
});
