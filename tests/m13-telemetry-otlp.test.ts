/**
 * T438 — Unit tests for TelemetryService.exportOTLP()
 *
 * Uses a local HTTP server to capture the OTLP payload and simulate
 * various collector responses.
 */

import http from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TelemetryService } from '../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

// ── helpers ────────────────────────────────────────────────────────────────────

interface FakeCollector {
  server: http.Server;
  port: number;
  /** Recorded raw body strings sent to POST /v1/metrics */
  bodies: string[];
  /** HTTP status code to respond with (default 200) */
  responseStatus: number;
}

async function startCollector(responseStatus = 200): Promise<FakeCollector> {
  const collector: FakeCollector = {
    server: null as unknown as http.Server,
    port: 0,
    bodies: [],
    responseStatus,
  };
  await new Promise<void>((resolve) => {
    collector.server = http.createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      req.on('end', () => {
        collector.bodies.push(body);
        res.writeHead(collector.responseStatus, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    collector.server.listen(0, '127.0.0.1', () => {
      const addr = collector.server.address() as { port: number };
      collector.port = addr.port;
      resolve();
    });
  });
  return collector;
}

function stopCollector(collector: FakeCollector): Promise<void> {
  return new Promise((resolve) => collector.server.close(() => resolve()));
}

function makeOp(tool = 'fs', sessionId = 'sess-1'): MCPOperation {
  return {
    id: `op-${Math.random()}`,
    agentId: 'agent-test',
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId,
  };
}

function dec(action: ProxyDecision['action'] = 'allow', riskScore = 0.3): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

// ── tests ──────────────────────────────────────────────────────────────────────

describe('T438 — TelemetryService.exportOTLP()', () => {
  let collector: FakeCollector;
  let telemetry: TelemetryService;

  beforeEach(async () => {
    telemetry = new TelemetryService();
    collector = await startCollector(200);
  });

  afterEach(async () => {
    await stopCollector(collector);
  });

  it('1. returns { ok: true, statusCode: 200 } when collector responds 200', async () => {
    const result = await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);
    expect(result.error).toBeUndefined();
  });

  it('2. returns { ok: false, statusCode: 500 } when collector responds 500', async () => {
    collector.responseStatus = 500;
    const result = await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    expect(result.ok).toBe(false);
    expect(result.statusCode).toBe(500);
  });

  it('3. returns { ok: false, error: ... } when host is unreachable', async () => {
    // Use a port that has no listener — will get a connection-refused ECONNREFUSED
    const result = await telemetry.exportOTLP('http://127.0.0.1:1');
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(result.error!.length).toBeGreaterThan(0);
  });

  it('4. OTLP payload POSTed to /v1/metrics', async () => {
    await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    expect(collector.bodies.length).toBeGreaterThan(0);
  });

  it('5. payload contains resourceMetrics', async () => {
    await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    const payload = JSON.parse(collector.bodies[0]!) as { resourceMetrics: unknown[] };
    expect(Array.isArray(payload.resourceMetrics)).toBe(true);
    expect(payload.resourceMetrics.length).toBeGreaterThan(0);
  });

  it('6. service.name attribute equals "agentsgate"', async () => {
    await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    const payload = JSON.parse(collector.bodies[0]!) as {
      resourceMetrics: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue: string } }> };
      }>;
    };
    const attrs = payload.resourceMetrics[0]!.resource.attributes;
    const serviceNameAttr = attrs.find(a => a.key === 'service.name');
    expect(serviceNameAttr).toBeDefined();
    expect(serviceNameAttr!.value.stringValue).toBe('agentsgate');
  });

  it('7. payload contains expected top-level metric names', async () => {
    await telemetry.record(makeOp(), dec('allow', 0.2));
    const newCollector = await startCollector(200);
    try {
      await telemetry.exportOTLP(`http://127.0.0.1:${newCollector.port}`);
      const payload = JSON.parse(newCollector.bodies[0]!) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<{ name: string }> }>;
        }>;
      };
      const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
      const metricNames = metrics.map(m => m.name);
      expect(metricNames).toContain('agentsgate.operations.total');
      expect(metricNames).toContain('agentsgate.operations.allow');
      expect(metricNames).toContain('agentsgate.operations.block');
      expect(metricNames).toContain('agentsgate.operations.require_approval');
      expect(metricNames).toContain('agentsgate.risk.avg');
    } finally {
      await stopCollector(newCollector);
    }
  });

  it('8. per-tool metrics appear when operations have been recorded', async () => {
    await telemetry.record(makeOp('shell'), dec('allow', 0.4));
    await telemetry.record(makeOp('database'), dec('block', 0.9));
    const newCollector = await startCollector(200);
    try {
      await telemetry.exportOTLP(`http://127.0.0.1:${newCollector.port}`);
      const payload = JSON.parse(newCollector.bodies[0]!) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }> }>;
        }>;
      };
      const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
      const toolMetrics = metrics.filter(m => m.name === 'agentsgate.operations.by_tool');
      expect(toolMetrics.length).toBeGreaterThan(0);
      const toolNames = toolMetrics.flatMap(m =>
        (m.sum?.dataPoints ?? []).flatMap(dp =>
          dp.attributes.filter(a => a.key === 'tool').map(a => a.value.stringValue)
        )
      );
      expect(toolNames).toContain('shell');
      expect(toolNames).toContain('database');
    } finally {
      await stopCollector(newCollector);
    }
  });

  it('9. empty stats produce empty per-tool metrics', async () => {
    // Fresh telemetry — no records, byTool will be {}
    const freshTelemetry = new TelemetryService();
    const newCollector = await startCollector(200);
    try {
      await freshTelemetry.exportOTLP(`http://127.0.0.1:${newCollector.port}`);
      const payload = JSON.parse(newCollector.bodies[0]!) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<{ name: string }> }>;
        }>;
      };
      const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
      const toolMetrics = metrics.filter(m => m.name === 'agentsgate.operations.by_tool');
      expect(toolMetrics.length).toBe(0);
    } finally {
      await stopCollector(newCollector);
    }
  });

  it('10. on success, buffer is flushed (subsequent export has 0 events)', async () => {
    await telemetry.record(makeOp(), dec('allow', 0.1));
    // First export — success → buffer flushed
    await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    // Second export — buffer is empty
    const newCollector = await startCollector(200);
    try {
      await telemetry.exportOTLP(`http://127.0.0.1:${newCollector.port}`);
      const payload = JSON.parse(newCollector.bodies[0]!) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: Array<{ asInt: string }> }; gauge?: { dataPoints: Array<{ asDouble: number }> } }> }>;
        }>;
      };
      const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
      const totalMetric = metrics.find(m => m.name === 'agentsgate.operations.total');
      expect(totalMetric).toBeDefined();
      expect(totalMetric!.sum!.dataPoints[0]!.asInt).toBe('0');
    } finally {
      await stopCollector(newCollector);
    }
  });

  it('11. on failure (5xx), buffer is NOT flushed', async () => {
    await telemetry.record(makeOp(), dec('allow', 0.5));
    collector.responseStatus = 503;
    await telemetry.exportOTLP(`http://127.0.0.1:${collector.port}`);
    // Buffer still has 1 event — re-export to a fresh 200 collector
    const newCollector = await startCollector(200);
    try {
      await telemetry.exportOTLP(`http://127.0.0.1:${newCollector.port}`);
      const payload = JSON.parse(newCollector.bodies[0]!) as {
        resourceMetrics: Array<{
          scopeMetrics: Array<{ metrics: Array<{ name: string; sum?: { dataPoints: Array<{ asInt: string }> } }> }>;
        }>;
      };
      const metrics = payload.resourceMetrics[0]!.scopeMetrics[0]!.metrics;
      const totalMetric = metrics.find(m => m.name === 'agentsgate.operations.total');
      expect(totalMetric!.sum!.dataPoints[0]!.asInt).toBe('1');
    } finally {
      await stopCollector(newCollector);
    }
  });
});

describe('TelemetryService — SSRF guard (metadata-only)', () => {
  // Telemetry sinks legitimately live on private networks, so loopback stays
  // allowed; only the link-local/metadata range is refused.
  it('refuses an OTLP endpoint on the cloud metadata address', async () => {
    const telemetry = new TelemetryService();
    const res = await telemetry.exportOTLP('http://169.254.169.254');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/link-local|metadata/i);
  });

  it('refuses a stats export endpoint on the cloud metadata address', async () => {
    const telemetry = new TelemetryService();
    const res = await telemetry.exportTo('http://169.254.169.254/collect');
    expect(res.ok).toBe(false);
    expect(String(res.error)).toMatch(/link-local|metadata/i);
  });

  it('refuses a non-http(s) OTLP endpoint', async () => {
    const telemetry = new TelemetryService();
    const res = await telemetry.exportOTLP('file:///etc/passwd');
    expect(res.ok).toBe(false);
  });
});
