/**
 * The approval queue has to work across two processes.
 *
 * The stdio proxy runs where Claude Desktop launched it; the dashboard that
 * answers runs under `agentsgate start`. They share only the SQLite file. So an
 * approval queued by one has to be visible to the other, and the verdict has to
 * travel back the same way.
 *
 * The queue kept everything in memory and deleted the row on resolve, which
 * gave neither.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { ApprovalQueue } from '../src/modules/m10-dashboard/approval-queue.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

let dir: string;
let dbPath: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-queue-'));
  dbPath = path.join(dir, 'shared.db');
  store = new StateStore(dbPath);
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function op(id: string): MCPOperation {
  return {
    id, agentId: 'claude', tool: 'filesystem', method: 'write_file',
    params: {}, timestamp: new Date(), sessionId: 's',
  } as MCPOperation;
}

describe('an approval queued by another process', () => {
  it('appears in getPending', async () => {
    // Stand-in for the stdio proxy: writes straight to the shared database.
    await store.savePendingApproval({
      id: 'op-1', operation: op('op-1'), riskScore: 0.5, queuedAt: new Date(),
    });

    const queue = new ApprovalQueue({ store });
    await queue.initialize();

    expect(queue.getPending().map(p => p.id)).toContain('op-1');
  });

  it('appears even when it arrives after the queue started', async () => {
    const queue = new ApprovalQueue({ store });
    await queue.initialize();
    expect(queue.getPending()).toHaveLength(0);

    await store.savePendingApproval({
      id: 'op-2', operation: op('op-2'), riskScore: 0.5, queuedAt: new Date(),
    });

    expect((await queue.refresh()).map(p => p.id)).toContain('op-2');
  });
});

describe('resolving', () => {
  it('records the verdict where the waiting process can read it', async () => {
    const queue = new ApprovalQueue({ store });
    await queue.initialize();
    queue.enqueue(op('op-3'), 0.5);

    queue.resolve('op-3', 'approved');
    await queue.whenIdle();

    const settled = await store.getPendingApproval('op-3');
    expect(settled?.verdict).toBe('approved');
  });

  it('records a denial the same way', async () => {
    const queue = new ApprovalQueue({ store });
    await queue.initialize();
    queue.enqueue(op('op-4'), 0.5);

    queue.resolve('op-4', 'denied');
    await queue.whenIdle();

    expect((await store.getPendingApproval('op-4'))?.verdict).toBe('denied');
  });

  it('can settle an approval this process never enqueued', async () => {
    await store.savePendingApproval({
      id: 'op-5', operation: op('op-5'), riskScore: 0.5, queuedAt: new Date(),
    });

    const queue = new ApprovalQueue({ store });
    await queue.initialize();

    expect(queue.resolve('op-5', 'approved')).toBeDefined();
    await queue.whenIdle();
    expect((await store.getPendingApproval('op-5'))?.verdict).toBe('approved');
  });

  it('takes it out of the pending list', async () => {
    const queue = new ApprovalQueue({ store });
    await queue.initialize();
    queue.enqueue(op('op-6'), 0.5);
    queue.resolve('op-6', 'approved');
    expect(queue.getPending().map(p => p.id)).not.toContain('op-6');
  });

  it('defaults to approved, so existing callers keep their meaning', async () => {
    const queue = new ApprovalQueue({ store });
    await queue.initialize();
    queue.enqueue(op('op-7'), 0.5);
    queue.resolve('op-7');
    await queue.whenIdle();
    expect((await store.getPendingApproval('op-7'))?.verdict).toBe('approved');
  });
});

describe('without a store', () => {
  it('still works entirely in memory', async () => {
    const queue = new ApprovalQueue({});
    await queue.initialize();
    queue.enqueue(op('op-8'), 0.5);
    expect(queue.getPending()).toHaveLength(1);
    expect(queue.resolve('op-8', 'denied')).toBeDefined();
    expect(queue.getPending()).toHaveLength(0);
    expect(await queue.refresh()).toHaveLength(0);
  });
});
