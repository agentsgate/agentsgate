/**
 * An approval's outcome has to outlive the approval.
 *
 * Resolving one used to remove it from the in-memory queue and, at most, delete
 * the row. That is enough for a review log, where nobody is waiting — but the
 * stdio proxy now holds a call until someone answers, and it runs in a
 * different process from the dashboard. It needs to read back *which* answer
 * came, and "the row is gone" cannot distinguish approved from denied from
 * expired.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { PendingApprovalRecord } from '../src/modules/m2-store/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-approval-'));
  store = new StateStore(path.join(dir, 'test.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function record(id: string): PendingApprovalRecord {
  return {
    id,
    operation: {
      id: `op-${id}`, agentId: 'a', tool: 'filesystem', method: 'write_file',
      params: {}, timestamp: new Date(), sessionId: 's',
    } as MCPOperation,
    riskScore: 0.5,
    queuedAt: new Date(),
  };
}

describe('resolving an approval', () => {
  it('records which way it went', async () => {
    await store.savePendingApproval(record('a1'));
    await store.resolvePendingApproval('a1', 'approved');

    const found = await store.getPendingApproval('a1');
    expect(found?.verdict).toBe('approved');
    expect(found?.resolvedAt).toBeInstanceOf(Date);
  });

  it('records a denial just as distinctly', async () => {
    await store.savePendingApproval(record('a2'));
    await store.resolvePendingApproval('a2', 'denied');
    expect((await store.getPendingApproval('a2'))?.verdict).toBe('denied');
  });

  it('reports whether there was anything to resolve', async () => {
    await store.savePendingApproval(record('a3'));
    expect(await store.resolvePendingApproval('a3', 'approved')).toBe(true);
    expect(await store.resolvePendingApproval('a3', 'denied')).toBe(false);   // already settled
    expect(await store.resolvePendingApproval('never-existed', 'approved')).toBe(false);
  });

  it('does not change a verdict once it is set', async () => {
    await store.savePendingApproval(record('a4'));
    await store.resolvePendingApproval('a4', 'denied');
    await store.resolvePendingApproval('a4', 'approved');
    expect((await store.getPendingApproval('a4'))?.verdict).toBe('denied');
  });
});

describe('an unresolved approval', () => {
  it('reads back with no verdict', async () => {
    await store.savePendingApproval(record('b1'));
    const found = await store.getPendingApproval('b1');
    expect(found).toBeDefined();
    expect(found?.verdict).toBeUndefined();
    expect(found?.riskScore).toBe(0.5);
  });

  it('is undefined when it was never saved', async () => {
    expect(await store.getPendingApproval('nothing')).toBeUndefined();
  });
});

describe('listPendingApprovals', () => {
  it('returns only what is still waiting', async () => {
    await store.savePendingApproval(record('c1'));
    await store.savePendingApproval(record('c2'));
    await store.resolvePendingApproval('c1', 'approved');

    const pending = await store.listPendingApprovals();
    expect(pending.map(p => p.id)).toEqual(['c2']);
  });
});

describe('pruneResolvedApprovals', () => {
  it('clears settled rows older than the cutoff, and leaves the rest', async () => {
    await store.savePendingApproval(record('d1'));
    await store.savePendingApproval(record('d2'));
    await store.resolvePendingApproval('d1', 'approved');

    const future = new Date(Date.now() + 60_000);
    expect(await store.pruneResolvedApprovals(future)).toBe(1);

    expect(await store.getPendingApproval('d1')).toBeUndefined();
    expect(await store.getPendingApproval('d2')).toBeDefined();   // still waiting
  });

  it('leaves a recently settled row alone', async () => {
    await store.savePendingApproval(record('e1'));
    await store.resolvePendingApproval('e1', 'approved');
    expect(await store.pruneResolvedApprovals(new Date(Date.now() - 60_000))).toBe(0);
    expect(await store.getPendingApproval('e1')).toBeDefined();
  });
});

describe('a database written before verdicts existed', () => {
  it('opens and keeps working', async () => {
    // The columns arrive by migration, so a file from an older build must not
    // fail to open — and its rows read back as still waiting.
    const dbPath = path.join(dir, 'legacy.db');
    const legacy = new StateStore(dbPath);
    await legacy.initialize();
    await legacy.savePendingApproval(record('f1'));
    await legacy.close();

    const reopened = new StateStore(dbPath);
    await reopened.initialize();
    expect((await reopened.getPendingApproval('f1'))?.verdict).toBeUndefined();
    expect(await reopened.resolvePendingApproval('f1', 'approved')).toBe(true);
    await reopened.close();
  });
});
