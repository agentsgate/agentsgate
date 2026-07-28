/**
 * T462 — Dashboard DB Rollback via M8, Audit Log, and Dry-run Preview
 *
 * Tests:
 *   W4  — postDbRollback routes through RollbackEngine (M8) when configured
 *   W4b — adapterId is derived from log.operation.tool (not hardcoded)
 *   RB3 — A ROLLBACK_EXECUTED audit log entry is written after successful rollback
 *   RB4 — POST /operations/:id/db-rollback/preview returns preview without modifying state
 *   Guard conditions: 503 (no adapter/engine), 404 (no operation), 400 (no snapshot)
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import http from 'node:http';
import { DashboardAPI } from '../../src/modules/m10-dashboard/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type {
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
  RollbackAdapter,
  MCPOperation,
  RollbackCapability,
} from '../../src/types/interfaces.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

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
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
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

async function getReq(
  port: number,
  path: string,
  key?: string,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (key) headers['x-api-key'] = key;
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
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

/** Build a minimal operation log entry with a snapshot_id in executionResult. */
function makeDbOp(
  operationId: string,
  tool: string,
  snapshotId: string,
  snapshotTable: string,
) {
  return {
    operationId,
    operation: {
      id: operationId,
      agentId: 'agent-1',
      tool,
      method: 'execute',
      params: { sql: 'DELETE FROM users WHERE id=1', snapshot_table: snapshotTable },
      timestamp: new Date(),
      sessionId: 'sess-1',
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

/** Fake DatabaseRollbackAdapter whose adapterId is configurable. */
class FakeAdapter implements RollbackAdapter {
  readonly adapterId: string;
  readonly version = '0.0.1';
  readonly supportedTools: string[];
  rollbackCalls: StateSnapshot[] = [];
  previewCalls: StateSnapshot[] = [];
  rollbackShouldSucceed = true;

  constructor(adapterId: string) {
    this.adapterId = adapterId;
    this.supportedTools = [adapterId];
  }

  async canRollback(_op: MCPOperation): Promise<RollbackCapability> {
    return { canRollback: true, confidence: 1 };
  }
  async captureState(op: MCPOperation): Promise<StateSnapshot> {
    return { adapterId: this.adapterId, operationId: op.id, data: {}, capturedAt: new Date() };
  }
  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    this.rollbackCalls.push(snapshot);
    if (!this.rollbackShouldSucceed) {
      return { success: false, restoredFiles: [], failedFiles: ['users'], error: 'Simulated failure' };
    }
    return { success: true, restoredFiles: ['users'], failedFiles: [] };
  }
  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    this.previewCalls.push(snapshot);
    return {
      willRestore: [`table: ${String((snapshot.data as Record<string, unknown>)['snapshotTable'] ?? 'unknown')}`],
      cannotRestore: [],
      warnings: [],
    };
  }
}

/** Minimal stub that satisfies the RollbackEngine interface used by DashboardAPI. */
class FakeRollbackEngine {
  rollbackCalls: StateSnapshot[] = [];
  rollbackShouldSucceed = true;
  registeredAdapters: FakeAdapter[] = [];

  registerAdapter(adapter: FakeAdapter) {
    this.registeredAdapters.push(adapter);
  }

  async rollbackFromState(snapshot: StateSnapshot): Promise<RollbackResult> {
    this.rollbackCalls.push(snapshot);
    const adapter = this.registeredAdapters.find(a => a.adapterId === snapshot.adapterId);
    if (!adapter) {
      return { success: false, restoredFiles: [], failedFiles: [], error: `No adapter for ${snapshot.adapterId}` };
    }
    if (!this.rollbackShouldSucceed) {
      return { success: false, restoredFiles: [], failedFiles: ['users'], error: 'Engine failure' };
    }
    return adapter.rollback(snapshot);
  }
}

// ── Shared fixtures ──────────────────────────────────────────────────────────

let store: StateStore;
let api: DashboardAPI;
let port: number;

const ADMIN_KEY = 'admin-key';

// ── Test suite: 503 guard when no adapter / engine configured ────────────────

describe('T462 — 503 guard (no adapter or engine)', () => {
  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('POST /operations/:id/db-rollback returns 503 when no adapter or engine is set', async () => {
    const { status, body } = await postReq(port, '/operations/some-op-id/db-rollback', ADMIN_KEY);
    expect(status).toBe(503);
    expect((body as { error: string }).error).toMatch(/no rollback engine or adapter/i);
  });

  it('POST /operations/:id/db-rollback/preview returns 503 when no adapter or engine is set', async () => {
    const { status, body } = await postReq(port, '/operations/some-op-id/db-rollback/preview', ADMIN_KEY);
    expect(status).toBe(503);
    expect((body as { error: string }).error).toMatch(/no rollback engine or adapter/i);
  });
});

// ── Test suite: 404 / 400 validation ─────────────────────────────────────────

describe('T462 — 404/400 validation guards', () => {
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database');
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('POST /operations/:id/db-rollback returns 404 when operation does not exist', async () => {
    const { status, body } = await postReq(port, '/operations/ghost-op/db-rollback', ADMIN_KEY);
    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/ghost-op/);
  });

  it('POST /operations/:id/db-rollback/preview returns 404 when operation does not exist', async () => {
    const { status, body } = await postReq(port, '/operations/ghost-op/db-rollback/preview', ADMIN_KEY);
    expect(status).toBe(404);
    expect((body as { error: string }).error).toMatch(/ghost-op/);
  });

  it('POST /operations/:id/db-rollback returns 400 when operation has no snapshot_id', async () => {
    // Save an op without executionResult.output.snapshot_id
    await store.saveOperationLog({
      operationId: 'op-no-snap',
      operation: {
        id: 'op-no-snap', agentId: 'a', tool: 'agentsgate-database',
        method: 'execute', params: { snapshot_table: 'users' },
        timestamp: new Date(), sessionId: 's',
      },
      decision: { action: 'allow', riskScore: 0, reasons: [] },
      executionResult: { success: true, output: {}, durationMs: 0 },
      createdAt: new Date(),
    });
    const { status, body } = await postReq(port, '/operations/op-no-snap/db-rollback', ADMIN_KEY);
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/no associated database snapshot/i);
  });

  it('POST /operations/:id/db-rollback returns 400 when operation has no snapshot_table', async () => {
    await store.saveOperationLog({
      operationId: 'op-no-table',
      operation: {
        id: 'op-no-table', agentId: 'a', tool: 'agentsgate-database',
        method: 'execute', params: {},
        timestamp: new Date(), sessionId: 's',
      },
      decision: { action: 'allow', riskScore: 0, reasons: [] },
      executionResult: { success: true, output: { snapshot_id: 'snap-1' }, durationMs: 0 },
      createdAt: new Date(),
    });
    const { status, body } = await postReq(port, '/operations/op-no-table/db-rollback', ADMIN_KEY);
    expect(status).toBe(400);
    expect((body as { error: string }).error).toMatch(/missing snapshot_table/i);
  });
});

// ── Test suite: W4b — adapterId derives from operation.tool ──────────────────

describe('T462 W4b — adapterId is derived from log.operation.tool', () => {
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-pg-database');
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('snapshot.adapterId equals log.operation.tool (not hardcoded agentsgate-database)', async () => {
    const log = makeDbOp('op-pg', 'agentsgate-pg-database', 'snap-pg-1', 'orders');
    await store.saveOperationLog(log);

    // Rollback will succeed because the adapter's adapterId matches
    const { status, body } = await postReq(port, '/operations/op-pg/db-rollback', ADMIN_KEY);
    expect(status).toBe(200);
    expect((body as RollbackResult).success).toBe(true);

    // The snapshot passed to the adapter must carry adapterId from the tool field
    expect(adapter.rollbackCalls).toHaveLength(1);
    expect(adapter.rollbackCalls[0]!.adapterId).toBe('agentsgate-pg-database');
  });
});

// ── Test suite: W4 — route through RollbackEngine (M8) ───────────────────────

describe('T462 W4 — postDbRollback prefers RollbackEngine when configured', () => {
  let engine: FakeRollbackEngine;
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database');
    engine = new FakeRollbackEngine();
    engine.registerAdapter(adapter);

    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      rollbackEngine: engine as unknown as import('../../src/modules/m8-rollback/index.js').RollbackEngine,
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('calls rollbackEngine.rollbackFromState (not adapter.rollback directly) when engine is present', async () => {
    const log = makeDbOp('op-via-engine', 'agentsgate-database', 'snap-1', 'users');
    await store.saveOperationLog(log);

    const { status, body } = await postReq(port, '/operations/op-via-engine/db-rollback', ADMIN_KEY);
    expect(status).toBe(200);
    expect((body as RollbackResult).success).toBe(true);

    // Engine must have been called
    expect(engine.rollbackCalls).toHaveLength(1);
    // Direct adapter.rollback should NOT have been called (engine dispatches internally)
    expect(adapter.rollbackCalls).toHaveLength(1); // adapter is called via engine
  });

  it('returns 503 when rollbackEngine cannot find adapter (wrong adapterId)', async () => {
    const log = makeDbOp('op-wrong-adapter', 'agentsgate-mysql-database', 'snap-2', 'products');
    await store.saveOperationLog(log);

    const { status, body } = await postReq(port, '/operations/op-wrong-adapter/db-rollback', ADMIN_KEY);
    // Engine returns success:false → 500
    expect(status).toBe(500);
    expect((body as RollbackResult).success).toBe(false);
  });

  it('falls back to direct dbRollbackAdapter when rollbackEngine is absent', async () => {
    // Create a fresh api without rollbackEngine
    await api.stop();
    const directAdapter = new FakeAdapter('agentsgate-database');
    const apiDirect = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: directAdapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await apiDirect.start(0);
    const addr2 = (apiDirect as unknown as { server: http.Server }).server.address() as { port: number };
    const port2 = addr2.port;

    const log = makeDbOp('op-direct', 'agentsgate-database', 'snap-direct', 'items');
    await store.saveOperationLog(log);

    const { status, body } = await postReq(port2, '/operations/op-direct/db-rollback', ADMIN_KEY);
    await apiDirect.stop();

    expect(status).toBe(200);
    expect((body as RollbackResult).success).toBe(true);
    expect(directAdapter.rollbackCalls).toHaveLength(1);
    expect(engine.rollbackCalls).toHaveLength(0); // engine not used
  });
});

// ── Test suite: RB3 — audit log written after successful rollback ─────────────

describe('T462 RB3 — ROLLBACK_EXECUTED audit entry written to store', () => {
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database');
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('writes a synthetic audit log with tool=agentsgate-rollback after successful rollback', async () => {
    const log = makeDbOp('op-audit', 'agentsgate-database', 'snap-audit-1', 'accounts');
    await store.saveOperationLog(log);

    const countBefore = store.countOperationLogs();
    const { status } = await postReq(port, '/operations/op-audit/db-rollback', ADMIN_KEY);
    expect(status).toBe(200);

    const countAfter = store.countOperationLogs();
    expect(countAfter).toBe(countBefore + 1);

    // Find the synthetic audit entry
    const all = await store.listOperationLogs(50, 0);
    const auditEntry = all.find(l => l.operation.tool === 'agentsgate-rollback');
    expect(auditEntry).toBeDefined();
    expect(auditEntry!.operation.method).toBe('db-rollback');
    expect(auditEntry!.operation.agentId).toBe('agentsgate-system');
    expect(auditEntry!.operation.params['operationId']).toBe('op-audit');
    expect(auditEntry!.decision.action).toBe('allow');
  });

  it('does NOT write an audit entry when rollback fails', async () => {
    adapter.rollbackShouldSucceed = false;
    const log = makeDbOp('op-fail', 'agentsgate-database', 'snap-fail-1', 'payments');
    await store.saveOperationLog(log);

    const countBefore = store.countOperationLogs();
    const { status } = await postReq(port, '/operations/op-fail/db-rollback', ADMIN_KEY);
    expect(status).toBe(500);

    const countAfter = store.countOperationLogs();
    expect(countAfter).toBe(countBefore); // no new audit entry
  });
});

// ── Test suite: RB4 — POST /operations/:id/db-rollback/preview ───────────────

describe('T462 RB4 — preview endpoint returns dry-run without modifying state', () => {
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database');
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('returns 200 with RollbackPreview shape when adapter has direct access', async () => {
    const log = makeDbOp('op-preview', 'agentsgate-database', 'snap-preview-1', 'invoices');
    await store.saveOperationLog(log);

    const { status, body } = await postReq(port, '/operations/op-preview/db-rollback/preview', ADMIN_KEY);
    expect(status).toBe(200);
    const preview = body as RollbackPreview;
    expect(Array.isArray(preview.willRestore)).toBe(true);
    expect(Array.isArray(preview.cannotRestore)).toBe(true);
    expect(preview.willRestore.length).toBeGreaterThan(0);
  });

  it('does NOT call adapter.rollback during preview (no state change)', async () => {
    const log = makeDbOp('op-preview2', 'agentsgate-database', 'snap-preview-2', 'sessions');
    await store.saveOperationLog(log);

    await postReq(port, '/operations/op-preview2/db-rollback/preview', ADMIN_KEY);
    expect(adapter.rollbackCalls).toHaveLength(0);
    expect(adapter.previewCalls).toHaveLength(1);
  });

  it('preview with rollbackEngine but no direct adapter match returns best-effort 200', async () => {
    await api.stop();
    const engine = new FakeRollbackEngine();
    // Do NOT add matching adapter → engine alone, no direct dbRollbackAdapter
    const apiEngineOnly = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      rollbackEngine: engine as unknown as import('../../src/modules/m8-rollback/index.js').RollbackEngine,
      // no dbRollbackAdapter
    });
    await apiEngineOnly.start(0);
    const addr2 = (apiEngineOnly as unknown as { server: http.Server }).server.address() as { port: number };
    const port2 = addr2.port;

    const log = makeDbOp('op-preview3', 'agentsgate-database', 'snap-preview-3', 'cache');
    await store.saveOperationLog(log);

    const { status, body } = await postReq(port2, '/operations/op-preview3/db-rollback/preview', ADMIN_KEY);
    await apiEngineOnly.stop();

    expect(status).toBe(200);
    const preview = body as RollbackPreview & { warnings?: string[] };
    expect(Array.isArray(preview.willRestore)).toBe(true);
    expect(preview.warnings!.some((w: string) => /approximate/i.test(w))).toBe(true);
  });

  it('preview requires admin role — returns 403 for viewer', async () => {
    await api.stop();
    const apiWithRoles = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin', 'viewer-key': 'viewer' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await apiWithRoles.start(0);
    const addr2 = (apiWithRoles as unknown as { server: http.Server }).server.address() as { port: number };
    const port2 = addr2.port;

    const { status } = await postReq(port2, '/operations/any-op/db-rollback/preview', 'viewer-key');
    await apiWithRoles.stop();

    expect(status).toBe(403);
  });
});

// ── Test suite: routing — preview before non-preview ─────────────────────────

describe('T462 routing — preview route is distinct from rollback route', () => {
  let adapter: FakeAdapter;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    adapter = new FakeAdapter('agentsgate-database');
    api = new DashboardAPI(store, {
      roles: { [ADMIN_KEY]: 'admin' },
      dbRollbackAdapter: adapter as unknown as import('../../src/modules/m9-adapters/database-rollback-adapter.js').DatabaseRollbackAdapter,
    });
    await api.start(0);
    const addr = (api as unknown as { server: http.Server }).server.address() as { port: number };
    port = addr.port;
  });

  afterEach(async () => {
    await api.stop();
    await store.close();
  });

  it('POST .../db-rollback routes to rollback; POST .../db-rollback/preview routes to preview', async () => {
    const log = makeDbOp('op-routing', 'agentsgate-database', 'snap-route-1', 'tenants');
    await store.saveOperationLog(log);

    const rollbackRes = await postReq(port, '/operations/op-routing/db-rollback', ADMIN_KEY);
    const previewRes = await postReq(port, '/operations/op-routing/db-rollback/preview', ADMIN_KEY);

    expect(rollbackRes.status).toBe(200);
    expect(previewRes.status).toBe(200);

    // Rollback called adapter.rollback, preview called adapter.previewRollback
    expect(adapter.rollbackCalls).toHaveLength(1);
    expect(adapter.previewCalls).toHaveLength(1);
  });

  it('GET /operations lists operations including post-rollback audit entry', async () => {
    const log = makeDbOp('op-list-test', 'agentsgate-database', 'snap-list-1', 'logs');
    await store.saveOperationLog(log);
    await postReq(port, '/operations/op-list-test/db-rollback', ADMIN_KEY);

    const { status, body } = await getReq(port, '/operations', ADMIN_KEY);
    expect(status).toBe(200);
    const resp = body as { data: Array<{ operation: { tool: string } }>; count: number };
    const rollbackEntry = resp.data.find(e => e.operation.tool === 'agentsgate-rollback');
    expect(rollbackEntry).toBeDefined();
  });
});
