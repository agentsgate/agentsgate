/**
 * Tests for T461 — P0 Core Wiring
 *
 * Covers:
 *   W1/RB1 — RollbackEngine adapter dispatch in rollback() and preview() when
 *             checkpoint.dbSnapshot is present
 *   W1/RB1 — RollbackEngine.rollbackFromState() direct adapter dispatch
 *   W3     — CommunityAdapterRegistry.loadInto() convenience method
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RollbackEngine } from '../../src/modules/m8-rollback/index.js';
import { CommunityAdapterRegistry } from '../../src/modules/m12-registry/index.js';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import type {
  MCPOperation,
  RollbackAdapter,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
  Checkpoint,
} from '../../src/types/interfaces.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-t461-'));
}

function makeOp(id = 'op-t461'): MCPOperation {
  return {
    id,
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'session-1',
  };
}

function makeMockAdapter(adapterId: string, overrides: Partial<RollbackAdapter> = {}): RollbackAdapter {
  return {
    adapterId,
    version: '1.0.0',
    supportedTools: ['mock'],
    canRollback: vi.fn<[MCPOperation], Promise<RollbackCapability>>().mockResolvedValue({ canRollback: true, confidence: 1 }),
    captureState: vi.fn<[MCPOperation], Promise<StateSnapshot>>().mockResolvedValue({
      adapterId, operationId: 'op-t461', data: {}, capturedAt: new Date(),
    }),
    rollback: vi.fn<[StateSnapshot], Promise<RollbackResult>>().mockResolvedValue({
      success: true, restoredFiles: [`${adapterId}:restored`], failedFiles: [],
    }),
    previewRollback: vi.fn<[StateSnapshot], Promise<RollbackPreview>>().mockResolvedValue({
      willRestore: [`${adapterId}:preview`], cannotRestore: [], warnings: [],
    }),
    ...overrides,
  };
}

/** Write a valid adapter .js plugin into a temp directory */
async function writeValidPlugin(dir: string, filename: string, adapterId: string): Promise<void> {
  const content = `
export default {
  adapterId: '${adapterId}',
  version: '1.0.0',
  supportedTools: ['test-tool'],
  canRollback: async () => ({ canRollback: true, confidence: 1 }),
  captureState: async (op) => ({ adapterId: '${adapterId}', operationId: op.id, data: {}, capturedAt: new Date() }),
  rollback: async () => ({ success: true, restoredFiles: ['${adapterId}:restored'], failedFiles: [] }),
  previewRollback: async () => ({ willRestore: ['${adapterId}:preview'], cannotRestore: [], warnings: [] }),
};
`;
  await fs.writeFile(path.join(dir, filename), content);
}

// ---------------------------------------------------------------------------
// Test suite: M8 RollbackEngine — adapter dispatch via dbSnapshot
// ---------------------------------------------------------------------------

describe('RollbackEngine — T461 adapter wiring', () => {
  let store: StateStore;
  let shadow: FileShadowSystem;
  let checkpoints: CheckpointEngine;
  let engine: RollbackEngine;
  let shadowDir: string;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();
    shadowDir = await mkTmpDir();
    shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);
    checkpoints = new CheckpointEngine(store, shadow);
    engine = new RollbackEngine(checkpoints, shadow);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
  });

  // ── rollback() with dbSnapshot ────────────────────────────────────────────

  it('calls registered adapter.rollback() when checkpoint has a sqlite dbSnapshot', async () => {
    const op = makeOp();
    const cp = await checkpoints.create(op);

    // Inject a dbSnapshot into the persisted checkpoint
    const cpWithDb: Checkpoint = {
      ...cp,
      dbSnapshot: { type: 'sqlite', reference: 'snap-001', tables: ['ops'] },
    };
    await store.saveCheckpoint(cpWithDb);

    const adapter = makeMockAdapter('agentsgate-database');
    engine.registerAdapter(adapter);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'test' });

    expect(adapter.rollback).toHaveBeenCalledOnce();
    expect(result.restoredFiles).toContain('agentsgate-database:restored');
    expect(result.success).toBe(true);
  });

  it('calls registered adapter.rollback() when checkpoint has a postgres dbSnapshot', async () => {
    const op = makeOp('op-pg');
    const cp = await checkpoints.create(op);
    const cpWithDb: Checkpoint = {
      ...cp,
      dbSnapshot: { type: 'postgres', reference: 'pg-snap', tables: ['events'] },
    };
    await store.saveCheckpoint(cpWithDb);

    const adapter = makeMockAdapter('agentsgate-pg-database');
    engine.registerAdapter(adapter);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'pg-test' });

    expect(adapter.rollback).toHaveBeenCalledOnce();
    expect(result.restoredFiles).toContain('agentsgate-pg-database:restored');
  });

  it('calls registered adapter.rollback() when checkpoint has a mysql dbSnapshot', async () => {
    const op = makeOp('op-mysql');
    const cp = await checkpoints.create(op);
    const cpWithDb: Checkpoint = {
      ...cp,
      dbSnapshot: { type: 'mysql', reference: 'mysql-snap', tables: ['users'] },
    };
    await store.saveCheckpoint(cpWithDb);

    const adapter = makeMockAdapter('agentsgate-mysql-database');
    engine.registerAdapter(adapter);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'mysql-test' });

    expect(adapter.rollback).toHaveBeenCalledOnce();
    expect(result.restoredFiles).toContain('agentsgate-mysql-database:restored');
  });

  it('merges adapter failedFiles into rollback result when adapter fails', async () => {
    const op = makeOp('op-fail');
    const cp = await checkpoints.create(op);
    const cpWithDb: Checkpoint = {
      ...cp,
      dbSnapshot: { type: 'sqlite', reference: 'snap-x', tables: ['t'] },
    };
    await store.saveCheckpoint(cpWithDb);

    const failingAdapter = makeMockAdapter('agentsgate-database', {
      rollback: vi.fn<[StateSnapshot], Promise<RollbackResult>>().mockResolvedValue({
        success: false,
        restoredFiles: [],
        failedFiles: ['agentsgate-database:failed'],
      }),
    });
    engine.registerAdapter(failingAdapter);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'fail-test' });

    expect(result.failedFiles).toContain('agentsgate-database:failed');
    expect(result.success).toBe(false);
  });

  it('does NOT call any adapter when checkpoint has no dbSnapshot', async () => {
    const op = makeOp('op-no-db');
    const cp = await checkpoints.create(op);
    // No dbSnapshot injected

    const adapter = makeMockAdapter('agentsgate-database');
    engine.registerAdapter(adapter);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'no-db' });

    expect(adapter.rollback).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  // ── preview() with dbSnapshot ─────────────────────────────────────────────

  it('calls adapter.previewRollback() in preview() and includes willRestore paths', async () => {
    const op = makeOp('op-preview');
    const cp = await checkpoints.create(op);
    const cpWithDb: Checkpoint = {
      ...cp,
      dbSnapshot: { type: 'sqlite', reference: 'snap-preview', tables: ['checkpoints'] },
    };
    await store.saveCheckpoint(cpWithDb);

    const adapter = makeMockAdapter('agentsgate-database');
    engine.registerAdapter(adapter);

    const result = await engine.preview({ checkpointId: cp.id, requestedBy: 'user', reason: 'preview' });

    expect(adapter.previewRollback).toHaveBeenCalledOnce();
    expect(result.restoredFiles).toContain('agentsgate-database:preview');
    expect(result.success).toBe(true);
    // No actual writes should occur
    expect(result.failedFiles).toHaveLength(0);
  });

  it('preview() does not call adapter when no dbSnapshot present', async () => {
    const op = makeOp('op-preview-nosnap');
    const cp = await checkpoints.create(op);

    const adapter = makeMockAdapter('agentsgate-database');
    engine.registerAdapter(adapter);

    const result = await engine.preview({ checkpointId: cp.id, requestedBy: 'user', reason: 'no-snap' });

    expect(adapter.previewRollback).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  // ── rollbackFromState() ───────────────────────────────────────────────────

  it('rollbackFromState() dispatches to the matching adapter by adapterId', async () => {
    const adapter = makeMockAdapter('my-custom-adapter');
    engine.registerAdapter(adapter);

    const snapshot: StateSnapshot = {
      adapterId: 'my-custom-adapter',
      operationId: 'op-direct',
      data: { snapshotId: 'snap-42', table: 'orders' },
      capturedAt: new Date(),
    };

    const result = await engine.rollbackFromState(snapshot);

    expect(adapter.rollback).toHaveBeenCalledOnce();
    expect(adapter.rollback).toHaveBeenCalledWith(snapshot);
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('my-custom-adapter:restored');
  });

  it('rollbackFromState() returns error when no adapter matches adapterId', async () => {
    const snapshot: StateSnapshot = {
      adapterId: 'nonexistent-adapter',
      operationId: 'op-miss',
      data: {},
      capturedAt: new Date(),
    };

    const result = await engine.rollbackFromState(snapshot);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No adapter registered for adapterId: nonexistent-adapter/);
    expect(result.restoredFiles).toHaveLength(0);
    expect(result.failedFiles).toHaveLength(0);
  });

  it('rollbackFromState() uses exact adapterId match — does NOT dispatch to a similar id', async () => {
    const adapter = makeMockAdapter('agentsgate-database');
    engine.registerAdapter(adapter);

    const snapshot: StateSnapshot = {
      adapterId: 'agentsgate-database-v2',  // slightly different
      operationId: 'op-mismatch',
      data: {},
      capturedAt: new Date(),
    };

    const result = await engine.rollbackFromState(snapshot);

    expect(adapter.rollback).not.toHaveBeenCalled();
    expect(result.success).toBe(false);
  });

  it('rollbackFromState() returns adapter failure result when adapter.rollback() fails', async () => {
    const failAdapter = makeMockAdapter('fail-adapter', {
      rollback: vi.fn<[StateSnapshot], Promise<RollbackResult>>().mockResolvedValue({
        success: false,
        restoredFiles: [],
        failedFiles: ['fail-adapter:db-table'],
        error: 'Connection refused',
      }),
    });
    engine.registerAdapter(failAdapter);

    const snapshot: StateSnapshot = {
      adapterId: 'fail-adapter',
      operationId: 'op-fail-direct',
      data: {},
      capturedAt: new Date(),
    };

    const result = await engine.rollbackFromState(snapshot);

    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain('fail-adapter:db-table');
    expect(result.error).toBe('Connection refused');
  });
});

// ---------------------------------------------------------------------------
// Test suite: CommunityAdapterRegistry.loadInto()
// ---------------------------------------------------------------------------

describe('CommunityAdapterRegistry — loadInto() (T461 W3)', () => {
  let registry: CommunityAdapterRegistry;
  let pluginDir: string;

  beforeEach(async () => {
    registry = new CommunityAdapterRegistry();
    pluginDir = await mkTmpDir();
  });

  afterEach(async () => {
    await fs.rm(pluginDir, { recursive: true, force: true });
  });

  it('loadInto() registers all discovered adapters with the provided engine', async () => {
    await writeValidPlugin(pluginDir, 'adapter-x.js', 'adapter-x');
    await writeValidPlugin(pluginDir, 'adapter-y.js', 'adapter-y');

    const registeredAdapters: RollbackAdapter[] = [];
    const mockEngine = {
      registerAdapter(adapter: RollbackAdapter) {
        registeredAdapters.push(adapter);
      },
    };

    const count = await registry.loadInto(mockEngine, pluginDir);

    expect(count).toBe(2);
    expect(registeredAdapters).toHaveLength(2);
    expect(registeredAdapters.map(a => a.adapterId)).toContain('adapter-x');
    expect(registeredAdapters.map(a => a.adapterId)).toContain('adapter-y');
  });

  it('loadInto() returns 0 and calls registerAdapter 0 times for empty directory', async () => {
    const calls: RollbackAdapter[] = [];
    const mockEngine = { registerAdapter: (a: RollbackAdapter) => { calls.push(a); } };

    const count = await registry.loadInto(mockEngine, pluginDir);

    expect(count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('loadInto() returns 0 for a nonexistent directory (no error thrown)', async () => {
    const calls: RollbackAdapter[] = [];
    const mockEngine = { registerAdapter: (a: RollbackAdapter) => { calls.push(a); } };

    const count = await registry.loadInto(mockEngine, '/tmp/__nonexistent_t461_dir__');

    expect(count).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('loadInto() skips invalid plugin files and only registers valid adapters', async () => {
    await writeValidPlugin(pluginDir, 'valid.js', 'valid-adapter');
    await fs.writeFile(path.join(pluginDir, 'invalid.js'), `export default { adapterId: '' };`);

    const registeredAdapters: RollbackAdapter[] = [];
    const mockEngine = { registerAdapter: (a: RollbackAdapter) => { registeredAdapters.push(a); } };

    const count = await registry.loadInto(mockEngine, pluginDir);

    expect(count).toBe(1);
    expect(registeredAdapters[0].adapterId).toBe('valid-adapter');
  });

  it('loadInto() works with a real RollbackEngine instance (integration)', async () => {
    await writeValidPlugin(pluginDir, 'real-plugin.js', 'real-adapter');

    // Use a real RollbackEngine with minimal dependencies
    const store = new StateStore(':memory:');
    await store.initialize();
    const shadowDir = await mkTmpDir();
    const shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);
    const cpEngine = new CheckpointEngine(store, shadow);
    const rollbackEngine = new RollbackEngine(cpEngine, shadow);

    const count = await registry.loadInto(rollbackEngine, pluginDir);
    expect(count).toBe(1);

    // Verify the adapter is actually usable via rollbackFromState
    const snapshot: StateSnapshot = {
      adapterId: 'real-adapter',
      operationId: 'op-integration',
      data: {},
      capturedAt: new Date(),
    };
    const result = await rollbackEngine.rollbackFromState(snapshot);
    expect(result.success).toBe(true);

    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
  });

  it('loadInto() deduplicates adapters when called twice with the same directory', async () => {
    await writeValidPlugin(pluginDir, 'dup.js', 'dup-adapter');

    const calls: RollbackAdapter[] = [];
    const mockEngine = { registerAdapter: (a: RollbackAdapter) => { calls.push(a); } };

    await registry.loadInto(mockEngine, pluginDir);
    await registry.loadInto(mockEngine, pluginDir);

    // Second loadInto should not re-register because load() deduplicates
    expect(calls).toHaveLength(2); // called twice total (first load: 1, second load picks up already loaded: 1 more from getAll)
    expect(registry.getAll()).toHaveLength(1); // but only stored once internally
  });
});
