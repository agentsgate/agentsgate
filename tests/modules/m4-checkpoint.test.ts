import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { CheckpointEngine } from '../../src/modules/m4-checkpoint/index.js';
import { StateStore } from '../../src/modules/m2-store/index.js';
import { FileShadowSystem } from '../../src/modules/m5-shadow/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

async function mkTmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'as-cp-test-'));
}

function makeOp(id: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id,
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params,
    timestamp: new Date(),
    sessionId: 'session-1',
  };
}

describe('CheckpointEngine', () => {
  let store: StateStore;
  let shadow: FileShadowSystem;
  let engine: CheckpointEngine;
  let shadowDir: string;
  let workDir: string;

  beforeEach(async () => {
    store = new StateStore(':memory:');
    await store.initialize();

    shadowDir = await mkTmpDir();
    workDir = await mkTmpDir();
    shadow = new FileShadowSystem();
    await shadow.initialize(shadowDir);

    engine = new CheckpointEngine(store, shadow);
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(shadowDir, { recursive: true, force: true });
    await fs.rm(workDir, { recursive: true, force: true });
  });

  it('should create a checkpoint before an operation', async () => {
    const filePath = path.join(workDir, 'test.txt');
    await fs.writeFile(filePath, 'before operation');

    const op = makeOp('op-1', { path: filePath });
    const checkpoint = await engine.create(op);

    expect(checkpoint.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(checkpoint.operationId).toBe('op-1');
    expect(checkpoint.type).toBe('pre_operation');
    expect(checkpoint.fileSnapshots).toHaveLength(1);
    expect(checkpoint.fileSnapshots[0].path).toBe(filePath);
    expect(checkpoint.fileSnapshots[0].gitCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(checkpoint.createdAt).toBeInstanceOf(Date);
  });

  it('should retrieve a checkpoint by ID', async () => {
    const filePath = path.join(workDir, 'retrieve.txt');
    await fs.writeFile(filePath, 'content');

    const cp = await engine.create(makeOp('op-2', { path: filePath }));
    const retrieved = await engine.get(cp.id);

    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(cp.id);
    expect(retrieved!.fileSnapshots).toHaveLength(1);

    expect(await engine.get('non-existent')).toBeNull();
  });

  it('should list checkpoints for an operation', async () => {
    const file1 = path.join(workDir, 'a.txt');
    const file2 = path.join(workDir, 'b.txt');
    await fs.writeFile(file1, 'a');
    await fs.writeFile(file2, 'b');

    const cp1 = await engine.create(makeOp('op-3', { path: file1 }));
    const cp2 = await engine.create(makeOp('op-3', { path: file2 }));

    const forOp3 = await engine.list('op-3');
    expect(forOp3).toHaveLength(2);
    expect(forOp3.map(c => c.id)).toContain(cp1.id);
    expect(forOp3.map(c => c.id)).toContain(cp2.id);

    const forOther = await engine.list('op-other');
    expect(forOther).toHaveLength(0);
  });

  it('should delete a checkpoint', async () => {
    const filePath = path.join(workDir, 'del.txt');
    await fs.writeFile(filePath, 'delete me');

    const cp = await engine.create(makeOp('op-4', { path: filePath }));
    expect(await engine.get(cp.id)).not.toBeNull();

    await engine.delete(cp.id);
    expect(await engine.get(cp.id)).toBeNull();
  });
});
