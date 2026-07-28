import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { RollbackEngine } from '../../src/modules/m8-rollback/index.js';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import type { MCPOperation, RollbackAdapter, RollbackCapability, StateSnapshot, RollbackResult, RollbackPreview } from '../../src/types/interfaces.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-rb-test-'));
}

function makeOp(params: Record<string, unknown>): MCPOperation {
  return {
    id: 'op-rb',
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params,
    timestamp: new Date(),
    sessionId: 'session-1',
  };
}

describe('RollbackEngine', () => {
  let store: StateStore;
  let shadow: FileShadowSystem;
  let checkpoints: CheckpointEngine;
  let engine: RollbackEngine;
  let shadowDir: string;
  let workDir: string;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();

    shadowDir = await mkTmpDir();
    workDir = await mkTmpDir();
    shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);

    checkpoints = new CheckpointEngine(store, shadow);
    engine = new RollbackEngine(checkpoints, shadow);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('should restore files from a checkpoint successfully', async () => {
    const filePath = path.join(workDir, 'target.txt');
    await fs.writeFile(filePath, 'original content');

    const cp = await checkpoints.create(makeOp({ path: filePath }));

    // Simulate damage
    await fs.writeFile(filePath, 'damaged content');
    expect(await fs.readFile(filePath, 'utf-8')).toBe('damaged content');

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'test' });

    expect(result.success).toBe(true);
    expect(await fs.readFile(filePath, 'utf-8')).toBe('original content');
  });

  it('should return RollbackResult with restoredFiles list', async () => {
    const file1 = path.join(workDir, 'f1.txt');
    const file2 = path.join(workDir, 'f2.txt');
    await fs.writeFile(file1, 'a');
    await fs.writeFile(file2, 'b');

    const cp = await checkpoints.create(makeOp({ paths: [file1, file2] }));

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'test' });

    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain(file1);
    expect(result.restoredFiles).toContain(file2);
    expect(result.failedFiles).toHaveLength(0);
  });

  it('should report failedFiles when a file cannot be restored', async () => {
    const filePath = path.join(workDir, 'will-fail.txt');
    await fs.writeFile(filePath, 'content');

    const cp = await checkpoints.create(makeOp({ path: filePath }));

    // Corrupt the snapshot git SHA so restore will throw
    cp.fileSnapshots[0].gitCommitSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
    await store.saveCheckpoint(cp);

    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'test' });

    expect(result.success).toBe(false);
    expect(result.failedFiles).toContain(filePath);
    expect(result.error).toBeDefined();
  });

  it('should preview rollback without making changes', async () => {
    const filePath = path.join(workDir, 'preview.txt');
    await fs.writeFile(filePath, 'original');

    const cp = await checkpoints.create(makeOp({ path: filePath }));
    await fs.writeFile(filePath, 'modified');

    const preview = await engine.preview({ checkpointId: cp.id, requestedBy: 'user', reason: 'preview' });

    expect(preview.restoredFiles).toContain(filePath);
    // File should NOT have been restored
    expect(await fs.readFile(filePath, 'utf-8')).toBe('modified');
  });

  it('should use plugin adapters for external service rollback', async () => {
    // Create a checkpoint with no file snapshots (pure adapter rollback)
    const op = makeOp({});
    const cp = await checkpoints.create(op);

    const mockAdapter: RollbackAdapter = {
      adapterId: 'mock-adapter',
      version: '1.0.0',
      supportedTools: ['mock'],
      canRollback: vi.fn<[MCPOperation], Promise<RollbackCapability>>().mockResolvedValue({ canRollback: true, confidence: 1 }),
      captureState: vi.fn<[MCPOperation], Promise<StateSnapshot>>().mockResolvedValue({
        adapterId: 'mock-adapter', operationId: op.id, data: {}, capturedAt: new Date(),
      }),
      rollback: vi.fn<[StateSnapshot], Promise<RollbackResult>>().mockResolvedValue({
        success: true, restoredFiles: [], failedFiles: [],
      }),
      previewRollback: vi.fn<[StateSnapshot], Promise<RollbackPreview>>().mockResolvedValue({
        willRestore: ['mock-resource'], cannotRestore: [], warnings: [],
      }),
    };

    engine.registerAdapter(mockAdapter);
    const result = await engine.rollback({ checkpointId: cp.id, requestedBy: 'user', reason: 'test' });

    // Core rollback still succeeds (no files in this checkpoint)
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toHaveLength(0);
  });
});
