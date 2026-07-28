/**
 * T128 — Prometheus /metrics endpoint.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

async function get(port: number, path: string): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${path}`, res => {
      let body = '';
      res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        body,
        contentType: res.headers['content-type'] ?? '',
      }));
    }).on('error', reject);
  });
}

function makeOp(tool: string): MCPOperation {
  return {
    id: `op-${Math.random()}`, agentId: 'agent-1', tool, method: 'call',
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

function dec(score: number, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore: score, reasons: [] };
}

function getPort(api: DashboardAPI): number {
  const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
  return addr.port;
}

describe('GET /metrics — Prometheus exposition format', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('returns 200 with rollback counters even when telemetry not configured', async () => {
    const api = new DashboardAPI(store);
    await api.start(0);
    const port = getPort(api);
    try {
      const { status, body } = await get(port, '/metrics');
      expect(status).toBe(200);
      expect(body).toContain('agentsgate_rollbacks_total');
      expect(body).toContain('agentsgate_rollbacks_success_total');
      expect(body).toContain('agentsgate_rollbacks_failed_total');
    } finally {
      await api.stop();
    }
  });

  it('returns 200 with Prometheus text content-type', async () => {
    const telemetry = new TelemetryService();
    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { status, contentType } = await get(port, '/metrics');
      expect(status).toBe(200);
      expect(contentType).toContain('text/plain');
      expect(contentType).toContain('0.0.4');
    } finally {
      await api.stop();
    }
  });

  it('exposes correct metric lines for recorded events', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('filesystem'), dec(0.1, 'allow'));
    await telemetry.record(makeOp('filesystem'), dec(0.9, 'block'));
    await telemetry.record(makeOp('shell'), dec(0.5, 'require_approval'));

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { body } = await get(port, '/metrics');
      expect(body).toContain('agentsgate_operations_total 3');
      expect(body).toContain('agentsgate_operations_allowed_total 1');
      expect(body).toContain('agentsgate_operations_blocked_total 1');
      expect(body).toContain('agentsgate_operations_require_approval_total 1');
      expect(body).toContain('agentsgate_operations_by_tool_total{tool="filesystem"} 2');
      expect(body).toContain('agentsgate_operations_by_tool_total{tool="shell"} 1');
      expect(body).toContain('agentsgate_risk_score_avg');
      expect(body).toContain('agentsgate_risk_histogram');
    } finally {
      await api.stop();
    }
  });

  it('includes HELP and TYPE lines for all metrics', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('git'), dec(0.3));

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { body } = await get(port, '/metrics');
      const lines = body.split('\n');
      const helpLines = lines.filter(l => l.startsWith('# HELP'));
      const typeLines = lines.filter(l => l.startsWith('# TYPE'));
      expect(helpLines.length).toBeGreaterThan(0);
      expect(typeLines.length).toBe(helpLines.length);
    } finally {
      await api.stop();
    }
  });

  it('returns empty-state metrics when no events recorded', async () => {
    const telemetry = new TelemetryService();

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { status, body } = await get(port, '/metrics');
      expect(status).toBe(200);
      expect(body).toContain('agentsgate_operations_total 0');
      expect(body).toContain('agentsgate_risk_score_avg 0');
    } finally {
      await api.stop();
    }
  });
});
