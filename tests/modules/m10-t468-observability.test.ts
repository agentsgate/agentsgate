/**
 * T468 — O2 + O3 Observability tests
 *
 * O3 — Rollback counters in dashboard /metrics
 *   - GET /metrics returns 200 (not 503) when no telemetry configured
 *   - rollback counter lines appear with 0 initial values
 *   - agentsgate_rollbacks_success_total increments after a successful rollback
 *   - agentsgate_rollbacks_failed_total increments after a failed rollback
 *   - agentsgate_rollbacks_total = success + failed
 *
 * O2 — avgDurationByTool in TelemetryService + /metrics exposure
 *   - record() with result.durationMs stores duration
 *   - getStats().avgDurationByTool returns correct averages
 *   - operations without result or without durationMs don't appear in avgDurationByTool
 *   - multiple tools tracked independently
 *   - GET /metrics with telemetry configured shows agentsgate_operation_duration_avg_ms lines
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type {
  MCPOperation,
  ProxyDecision,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
  RollbackAdapter,
  RollbackCapability,
} from '../../src/types/interfaces.js';

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function getText(
  port: number,
  path: string,
  apiKey?: string,
): Promise<{ status: number; body: string; contentType: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (apiKey) headers['x-api-key'] = apiKey;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      res => {
        let body = '';
        res.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        res.on('end', () =>
          resolve({
            status: res.statusCode ?? 0,
            body,
            contentType: res.headers['content-type'] ?? '',
          }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function postReq(
  port: number,
  path: string,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'content-length': '0' };
    if (key) headers['x-api-key'] = key;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'POST', headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({
              status: res.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          }
        });
        res.on('error', reject);
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function getPort(api: DashboardAPI): number {
  const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
  return addr.port;
}

// ── Shared type helpers ───────────────────────────────────────────────────────

function makeOp(tool: string, sessionId = 'sess-1'): MCPOperation {
  return {
    id: `op-${Math.random().toString(36).slice(2)}`,
    agentId: 'agent-1',
    tool,
    method: 'call',
    params: {},
    timestamp: new Date(),
    sessionId,
  };
}

function dec(score: number, action: ProxyDecision['action'] = 'allow'): ProxyDecision {
  return { action, riskScore: score, reasons: [] };
}

/** Build a minimal operation log with a snapshot_id so postDbRollback can proceed. */
function makeDbOp(operationId: string, tool: string, snapshotId: string, snapshotTable: string) {
  return {
    operationId,
    operation: {
      id: operationId,
      agentId: 'agent-1',
      tool,
      method: 'execute',
      params: { sql: 'DELETE FROM t WHERE id=1', snapshot_table: snapshotTable },
      timestamp: new Date(),
      sessionId: 'sess-db',
    },
    decision: { action: 'allow' as const, riskScore: 0.1, reasons: [] },
    executionResult: {
      success: true,
      output: { snapshot_id: snapshotId, rowsAffected: 1 },
      durationMs: 5,
    },
    createdAt: new Date(),
  };
}

// ── Fake RollbackAdapter ─────────────────────────────────────────────────────

class FakeAdapter implements RollbackAdapter {
  readonly adapterId: string;
  readonly version = '0.0.1';
  readonly supportedTools: string[];
  shouldSucceed: boolean;

  constructor(adapterId: string, shouldSucceed = true) {
    this.adapterId = adapterId;
    this.supportedTools = [adapterId];
    this.shouldSucceed = shouldSucceed;
  }

  async canRollback(_op: MCPOperation): Promise<RollbackCapability> {
    return { canRollback: true, confidence: 1 };
  }
  async captureState(op: MCPOperation): Promise<StateSnapshot> {
    return { adapterId: this.adapterId, operationId: op.id, data: {}, capturedAt: new Date() };
  }
  async rollback(_snapshot: StateSnapshot): Promise<RollbackResult> {
    if (this.shouldSucceed) {
      return { success: true, restoredFiles: ['table'], failedFiles: [] };
    }
    return { success: false, restoredFiles: [], failedFiles: ['table'], error: 'Simulated failure' };
  }
  async previewRollback(_snapshot: StateSnapshot): Promise<RollbackPreview> {
    return { willRestore: ['table'], cannotRestore: [], warnings: [] };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// O3 — Rollback counters
// ═══════════════════════════════════════════════════════════════════════════════

describe('T468 O3 — rollback counters in /metrics (no telemetry configured)', () => {
  let store: StateStore;
  let api: DashboardAPI;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store); // no telemetry
    await api.start(0);
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('GET /metrics returns 200 (not 503) when telemetry is absent', async () => {
    const port = getPort(api);
    const { status } = await getText(port, '/metrics');
    expect(status).toBe(200);
  });

  it('GET /metrics includes rollback counter HELP, TYPE, and value lines at startup', async () => {
    const port = getPort(api);
    const { body } = await getText(port, '/metrics');

    expect(body).toContain('# HELP agentsgate_rollbacks_total');
    expect(body).toContain('# TYPE agentsgate_rollbacks_total counter');
    expect(body).toContain('agentsgate_rollbacks_total 0');

    expect(body).toContain('# HELP agentsgate_rollbacks_success_total');
    expect(body).toContain('agentsgate_rollbacks_success_total 0');

    expect(body).toContain('# HELP agentsgate_rollbacks_failed_total');
    expect(body).toContain('agentsgate_rollbacks_failed_total 0');
  });

  it('GET /metrics uses Prometheus text content-type even without telemetry', async () => {
    const port = getPort(api);
    const { contentType } = await getText(port, '/metrics');
    expect(contentType).toContain('text/plain');
    expect(contentType).toContain('0.0.4');
  });
});

describe('T468 O3 — rollback counters increment after rollbacks', () => {
  const ADMIN_KEY = 'admin-t468';
  let store: StateStore;
  let api: DashboardAPI;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database', /* shouldSucceed */ true);
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('agentsgate_rollbacks_success_total increments after a successful rollback', async () => {
    const port = getPort(api);
    const log = makeDbOp('op-success', 'agentsgate-database', 'snap-s1', 'users');
    await store.saveOperationLog(log);

    const { status: rollbackStatus } = await postReq(port, '/operations/op-success/db-rollback', ADMIN_KEY);
    expect(rollbackStatus).toBe(200);

    const { body } = await getText(port, '/metrics', ADMIN_KEY);
    expect(body).toContain('agentsgate_rollbacks_success_total 1');
    expect(body).toContain('agentsgate_rollbacks_failed_total 0');
    expect(body).toContain('agentsgate_rollbacks_total 1');
  });

  it('agentsgate_rollbacks_failed_total increments after a failed rollback', async () => {
    const port = getPort(api);
    adapter.shouldSucceed = false;
    const log = makeDbOp('op-fail', 'agentsgate-database', 'snap-f1', 'orders');
    await store.saveOperationLog(log);

    const { status: rollbackStatus } = await postReq(port, '/operations/op-fail/db-rollback', ADMIN_KEY);
    expect(rollbackStatus).toBe(500);

    const { body } = await getText(port, '/metrics', ADMIN_KEY);
    expect(body).toContain('agentsgate_rollbacks_failed_total 1');
    expect(body).toContain('agentsgate_rollbacks_success_total 0');
    expect(body).toContain('agentsgate_rollbacks_total 1');
  });

  it('agentsgate_rollbacks_total = success + failed across mixed rollbacks', async () => {
    const port = getPort(api);

    // First rollback: success
    const log1 = makeDbOp('op-m1', 'agentsgate-database', 'snap-m1', 'items');
    await store.saveOperationLog(log1);
    adapter.shouldSucceed = true;
    await postReq(port, '/operations/op-m1/db-rollback', ADMIN_KEY);

    // Second rollback: fail
    const log2 = makeDbOp('op-m2', 'agentsgate-database', 'snap-m2', 'products');
    await store.saveOperationLog(log2);
    adapter.shouldSucceed = false;
    await postReq(port, '/operations/op-m2/db-rollback', ADMIN_KEY);

    // Third rollback: success
    const log3 = makeDbOp('op-m3', 'agentsgate-database', 'snap-m3', 'inventory');
    await store.saveOperationLog(log3);
    adapter.shouldSucceed = true;
    await postReq(port, '/operations/op-m3/db-rollback', ADMIN_KEY);

    const { body } = await getText(port, '/metrics', ADMIN_KEY);
    expect(body).toContain('agentsgate_rollbacks_success_total 2');
    expect(body).toContain('agentsgate_rollbacks_failed_total 1');
    expect(body).toContain('agentsgate_rollbacks_total 3');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// O2 — avgDurationByTool in TelemetryService
// ═══════════════════════════════════════════════════════════════════════════════

describe('T468 O2 — TelemetryService.getStats().avgDurationByTool', () => {
  it('returns empty avgDurationByTool when no events recorded', async () => {
    const telemetry = new TelemetryService();
    const stats = await telemetry.getStats();
    expect(stats.avgDurationByTool).toEqual({});
  });

  it('returns correct average for a single tool with one duration', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('filesystem'), dec(0.1), { durationMs: 100 });
    const stats = await telemetry.getStats();
    expect(stats.avgDurationByTool['filesystem']).toBe(100);
  });

  it('computes correct average when the same tool has multiple durations', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('filesystem'), dec(0.1), { durationMs: 100 });
    await telemetry.record(makeOp('filesystem'), dec(0.2), { durationMs: 200 });
    await telemetry.record(makeOp('filesystem'), dec(0.3), { durationMs: 300 });
    const stats = await telemetry.getStats();
    // (100 + 200 + 300) / 3 = 200
    expect(stats.avgDurationByTool['filesystem']).toBe(200);
  });

  it('tracks multiple tools independently', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('filesystem'), dec(0.1), { durationMs: 50 });
    await telemetry.record(makeOp('filesystem'), dec(0.2), { durationMs: 150 });
    await telemetry.record(makeOp('shell'), dec(0.5), { durationMs: 400 });
    await telemetry.record(makeOp('git'), dec(0.3), { durationMs: 80 });
    const stats = await telemetry.getStats();
    // filesystem: (50 + 150) / 2 = 100
    expect(stats.avgDurationByTool['filesystem']).toBe(100);
    // shell: 400 / 1 = 400
    expect(stats.avgDurationByTool['shell']).toBe(400);
    // git: 80 / 1 = 80
    expect(stats.avgDurationByTool['git']).toBe(80);
  });

  it('operations without result do not appear in avgDurationByTool', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('no-duration-tool'), dec(0.1)); // no result at all
    const stats = await telemetry.getStats();
    expect(stats.avgDurationByTool['no-duration-tool']).toBeUndefined();
  });

  it('operations with result but without durationMs do not appear in avgDurationByTool', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('partial-tool'), dec(0.2), {}); // empty result, no durationMs
    const stats = await telemetry.getStats();
    expect(stats.avgDurationByTool['partial-tool']).toBeUndefined();
  });

  it('operations with durationMs=0 are included (zero is valid)', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('fast-tool'), dec(0.1), { durationMs: 0 });
    await telemetry.record(makeOp('fast-tool'), dec(0.1), { durationMs: 20 });
    const stats = await telemetry.getStats();
    // (0 + 20) / 2 = 10
    expect(stats.avgDurationByTool['fast-tool']).toBe(10);
  });

  it('operations with negative durationMs are excluded', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('edge-tool'), dec(0.1), { durationMs: -5 });
    await telemetry.record(makeOp('edge-tool'), dec(0.2), { durationMs: 100 });
    const stats = await telemetry.getStats();
    // Only the 100ms event should count
    expect(stats.avgDurationByTool['edge-tool']).toBe(100);
  });

  it('mix of with and without durationMs only counts events with durations', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('mixed-tool'), dec(0.1), { durationMs: 60 });
    await telemetry.record(makeOp('mixed-tool'), dec(0.2)); // no duration
    await telemetry.record(makeOp('mixed-tool'), dec(0.3), { durationMs: 120 });
    const stats = await telemetry.getStats();
    // (60 + 120) / 2 = 90
    expect(stats.avgDurationByTool['mixed-tool']).toBe(90);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// O2 — /metrics Prometheus exposure of avgDurationByTool
// ═══════════════════════════════════════════════════════════════════════════════

describe('T468 O2 — /metrics exposes agentsgate_operation_duration_avg_ms', () => {
  let store: StateStore;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
  });

  it('does NOT emit duration lines when no tools have duration data', async () => {
    const telemetry = new TelemetryService();
    // Record operations without durationMs
    await telemetry.record(makeOp('filesystem'), dec(0.1));
    await telemetry.record(makeOp('shell'), dec(0.5));

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { body } = await getText(port, '/metrics');
      expect(body).not.toContain('agentsgate_operation_duration_avg_ms');
    } finally {
      await api.stop();
    }
  });

  it('emits HELP, TYPE, and per-tool gauge lines when tools have duration data', async () => {
    const telemetry = new TelemetryService();
    await telemetry.record(makeOp('filesystem'), dec(0.1), { durationMs: 50 });
    await telemetry.record(makeOp('filesystem'), dec(0.2), { durationMs: 150 });
    await telemetry.record(makeOp('shell'), dec(0.5), { durationMs: 300 });

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { body } = await getText(port, '/metrics');
      expect(body).toContain('# HELP agentsgate_operation_duration_avg_ms');
      expect(body).toContain('# TYPE agentsgate_operation_duration_avg_ms gauge');
      // filesystem avg: (50 + 150) / 2 = 100.00
      expect(body).toContain('agentsgate_operation_duration_avg_ms{tool="filesystem"} 100.00');
      // shell avg: 300.00
      expect(body).toContain('agentsgate_operation_duration_avg_ms{tool="shell"} 300.00');
    } finally {
      await api.stop();
    }
  });

  it('duration metric is absent when telemetry is not configured at all', async () => {
    const api = new DashboardAPI(store); // no telemetry
    await api.start(0);
    const port = getPort(api);
    try {
      const { status, body } = await getText(port, '/metrics');
      expect(status).toBe(200);
      // telemetry-derived metrics should not appear
      expect(body).not.toContain('agentsgate_operation_duration_avg_ms');
      expect(body).not.toContain('agentsgate_operations_total');
    } finally {
      await api.stop();
    }
  });

  it('toFixed(2) formatting: values are rendered with two decimal places', async () => {
    const telemetry = new TelemetryService();
    // 3 events summing to 100ms → avg = 33.333...
    await telemetry.record(makeOp('precision-tool'), dec(0.1), { durationMs: 10 });
    await telemetry.record(makeOp('precision-tool'), dec(0.2), { durationMs: 60 });
    await telemetry.record(makeOp('precision-tool'), dec(0.3), { durationMs: 30 });

    const api = new DashboardAPI(store, { telemetry });
    await api.start(0);
    const port = getPort(api);
    try {
      const { body } = await getText(port, '/metrics');
      expect(body).toContain('agentsgate_operation_duration_avg_ms{tool="precision-tool"} 33.33');
    } finally {
      await api.stop();
    }
  });
});
