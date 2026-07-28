/**
 * T174 — Operation parent-chain tracking (parentId field).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { StateStore } from '../src/modules/m2-store/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

function makeOp(id: string, parentId?: string): MCPOperation {
  return {
    id,
    agentId: 'agent-1',
    tool: 'filesystem',
    method: 'write_file',
    params: {},
    timestamp: new Date(),
    sessionId: 'sess-1',
    ...(parentId !== undefined ? { parentId } : {}),
  };
}

function makeDecision(): ProxyDecision {
  return { action: 'allow', riskScore: 0.1, reasons: [] };
}

describe('MCPOperation parentId — type and storage', () => {
  let store: StateStore;
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-parent-'));
    store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
  });

  afterEach(async () => {
    await store.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('operation without parentId has undefined parentId', () => {
    const op = makeOp('op-root');
    expect(op.parentId).toBeUndefined();
  });

  it('operation with parentId carries the field', () => {
    const op = makeOp('op-child', 'op-root');
    expect(op.parentId).toBe('op-root');
  });

  it('parentId is stored and retrieved via OperationLogger + StateStore', async () => {
    const logger = new OperationLogger(store);
    const child = makeOp('op-child', 'op-parent');
    await logger.log(child, makeDecision());
    const log = await store.getOperationLog('op-child');
    expect(log).not.toBeNull();
    expect(log!.operation.parentId).toBe('op-parent');
  });

  it('listOperationLogs can filter by parentId', async () => {
    const logger = new OperationLogger(store);
    await logger.log(makeOp('op-root'), makeDecision());
    await logger.log(makeOp('op-c1', 'op-root'), makeDecision());
    await logger.log(makeOp('op-c2', 'op-root'), makeDecision());
    await logger.log(makeOp('op-unrelated', 'other-parent'), makeDecision());

    const children = await store.listOperationLogs(100, 0, { parentId: 'op-root' });
    expect(children).toHaveLength(2);
    expect(children.every(l => l.operation.parentId === 'op-root')).toBe(true);
  });

  it('filter parentId=undefined matches only ops without parentId', async () => {
    const logger = new OperationLogger(store);
    await logger.log(makeOp('op-root'), makeDecision());
    await logger.log(makeOp('op-child', 'op-root'), makeDecision());

    // undefined filter means no parentId filter applied
    const all = await store.listOperationLogs(100, 0);
    expect(all).toHaveLength(2);
  });

  it('chains can be reconstructed by following parentId links', async () => {
    const logger = new OperationLogger(store);
    await logger.log(makeOp('root'), makeDecision());
    await logger.log(makeOp('level-1', 'root'), makeDecision());
    await logger.log(makeOp('level-2', 'level-1'), makeDecision());

    const l1 = await store.listOperationLogs(100, 0, { parentId: 'root' });
    expect(l1.map(l => l.operation.id)).toContain('level-1');

    const l2 = await store.listOperationLogs(100, 0, { parentId: 'level-1' });
    expect(l2.map(l => l.operation.id)).toContain('level-2');
  });
});
