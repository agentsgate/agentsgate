/**
 * T103 — TelemetryService OTLP export tests.
 *
 * Spins up a minimal HTTP server to capture the OTLP/HTTP JSON payload
 * and verifies the shape conforms to the OTLP Metrics JSON encoding spec.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import http from 'node:http';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';
import { randomUUID } from 'node:crypto';

// Each test gets its own OS-assigned port. A fixed port shared across tests
// is not just a collision risk: `server.close()` stops new connections but
// leaves established keep-alive sockets open, so the pooled connection from
// the previous test would still be attached to the previous server instance.
// The next test's request then lands on the old collector and its own
// `captured` stays null. Node 20 and 22 bundle different undici versions with
// different keep-alive behaviour, which is why this only failed on one of them.

function makeOp(tool: string, method: string): MCPOperation {
  return { id: randomUUID(), agentId: 'agent', tool, method, params: {}, timestamp: new Date(), sessionId: 'sess' };
}
function makeDecision(action: ProxyDecision['action'], riskScore: number): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

/** Start a minimal OTLP collector stub and return captured request body. */
function startOTLPCollector(): {
  server: http.Server;
  getBody: () => unknown;
  port: number;
  close: () => Promise<void>;
} {
  let captured: unknown = null;
  const sockets = new Set<import('node:net').Socket>();

  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      try { captured = JSON.parse(body); } catch { captured = body; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  // Track connections so close() cannot hang on an idle keep-alive socket.
  server.on('connection', s => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });

  return {
    server,
    getBody: () => captured,
    get port(): number { return (server.address() as { port: number }).port; },
    close: async () => {
      const closed = new Promise<void>(r => server.close(() => r()));
      for (const s of sockets) s.destroy();
      await closed;
    },
  };
}

describe('TelemetryService.exportOTLP', () => {
  let svc: TelemetryService;
  let collector: ReturnType<typeof startOTLPCollector>;
  let getBody: () => unknown;
  let endpoint: string;

  beforeEach(async () => {
    svc = new TelemetryService();
    collector = startOTLPCollector();
    getBody = collector.getBody;
    await new Promise<void>(r => collector.server.listen(0, '127.0.0.1', () => r()));
    endpoint = `http://127.0.0.1:${collector.port}`;
  });

  afterEach(async () => {
    await collector.close();
  });

  it('sends POST to /v1/metrics and returns ok: true', async () => {
    await svc.record(makeOp('filesystem', 'read_file'), makeDecision('allow', 0.05));
    const result = await svc.exportOTLP(endpoint);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
  });

  it('OTLP payload contains resourceMetrics with service.name attribute', async () => {
    await svc.record(makeOp('filesystem', 'delete_file'), makeDecision('block', 0.9));
    await svc.exportOTLP(endpoint);

    const body = getBody() as { resourceMetrics: { resource: { attributes: { key: string; value: { stringValue: string } }[] } }[] };
    expect(body.resourceMetrics).toHaveLength(1);
    const attrs = body.resourceMetrics[0].resource.attributes;
    const svcName = attrs.find(a => a.key === 'service.name');
    expect(svcName?.value.stringValue).toBe('agentsgate');
  });

  it('OTLP payload includes total operations metric', async () => {
    await svc.record(makeOp('database', 'query'), makeDecision('allow', 0.1));
    await svc.record(makeOp('database', 'drop_table'), makeDecision('block', 0.95));
    await svc.exportOTLP(endpoint);

    const body = getBody() as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum?: { dataPoints: { asInt: string }[] } }[] }[] }[] };
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;

    const totalMetric = metrics.find(m => m.name === 'agentsgate.operations.total');
    expect(totalMetric).toBeDefined();
    expect(totalMetric!.sum!.dataPoints[0].asInt).toBe('2');
  });

  it('OTLP payload includes per-action metrics', async () => {
    await svc.record(makeOp('fs', 'read'), makeDecision('allow', 0.05));
    await svc.record(makeOp('fs', 'delete'), makeDecision('block', 0.9));
    await svc.exportOTLP(endpoint);

    const body = getBody() as { resourceMetrics: { scopeMetrics: { metrics: { name: string; sum?: { dataPoints: { asInt: string }[] } }[] }[] }[] };
    const metrics = body.resourceMetrics[0].scopeMetrics[0].metrics;

    const blockMetric = metrics.find(m => m.name === 'agentsgate.operations.block');
    expect(blockMetric!.sum!.dataPoints[0].asInt).toBe('1');

    const allowMetric = metrics.find(m => m.name === 'agentsgate.operations.allow');
    expect(allowMetric!.sum!.dataPoints[0].asInt).toBe('1');
  });

  it('flushes buffer after successful export', async () => {
    await svc.record(makeOp('filesystem', 'read_file'), makeDecision('allow', 0.05));
    expect((await svc.getStats()).totalEvents).toBe(1);

    await svc.exportOTLP(endpoint);
    expect((await svc.getStats()).totalEvents).toBe(0);
  });

  it('returns ok: false when collector is unreachable', async () => {
    const result = await svc.exportOTLP('http://localhost:19999'); // nothing listening
    expect(result.ok).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
