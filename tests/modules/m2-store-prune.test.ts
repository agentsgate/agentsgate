import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StateStore } from '../../src/modules/m2-store/index.js';
import type { OperationLog } from '../../src/types/interfaces.js';
import { randomUUID } from 'node:crypto';

function makeLog(daysAgo: number): OperationLog {
  const ts = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  return {
    operationId: randomUUID(),
    operation: {
      id: randomUUID(),
      agentId: 'test-agent',
      tool: 'filesystem',
      method: 'read_file',
      params: {},
      timestamp: ts,
      sessionId: 'session-1',
    },
    decision: { action: 'allow', riskScore: 0.05, reasons: [] },
    createdAt: ts,
  };
}

describe('StateStore.pruneOperationLogs', () => {
  let store: StateStore;
  beforeEach(async () => { store = new StateStore(':memory:'); await store.initialize(); });
  afterEach(async () => { await store.close(); });

  it('deletes logs older than cutoff and returns count', async () => {
    const oldLog = makeLog(40);  // 40 days ago
    const newLog = makeLog(5);   // 5 days ago
    await store.saveOperationLog(oldLog);
    await store.saveOperationLog(newLog);

    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago
    const deleted = await store.pruneOperationLogs(cutoff);

    expect(deleted).toBe(1);
    const remaining = await store.listOperationLogs(100, 0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].operationId).toBe(newLog.operationId);
  });

  it('returns 0 when nothing to prune', async () => {
    await store.saveOperationLog(makeLog(1));
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    expect(await store.pruneOperationLogs(cutoff)).toBe(0);
  });

  it('prunes all logs when cutoff is in the future', async () => {
    await store.saveOperationLog(makeLog(1));
    await store.saveOperationLog(makeLog(2));
    const futureDate = new Date(Date.now() + 1000);
    const deleted = await store.pruneOperationLogs(futureDate);
    expect(deleted).toBe(2);
    expect(await store.listOperationLogs(100, 0)).toHaveLength(0);
  });
});

// ── T222: StateStore.pruneOldLogs(maxAgeMs) ─────────────────────────────────

describe('StateStore.pruneOldLogs', () => {
  let store: StateStore;
  beforeEach(async () => { store = new StateStore(':memory:'); await store.initialize(); });
  afterEach(async () => { await store.close(); });

  it('returns 0 on an empty DB', () => {
    const deleted = store.pruneOldLogs(60_000);
    expect(deleted).toBe(0);
  });

  it('deletes old logs and keeps recent ones', async () => {
    // Insert 2 old logs by backdating via the raw DB handle
    const oldId1 = randomUUID();
    const oldId2 = randomUUID();
    const newId  = randomUUID();

    const oldTs = new Date(Date.now() - 10_000).toISOString(); // 10 s ago
    const newTs = new Date(Date.now() + 5_000).toISOString();  // future

    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = rawDb.prepare(
      'INSERT INTO operation_logs (operation_id, data, created_at) VALUES (?, ?, ?)'
    );

    const makeRaw = (id: string, ts: string) => JSON.stringify({
      operationId: id,
      operation: { id, agentId: 'a', tool: 't', method: 'm', params: {}, timestamp: ts, sessionId: 's' },
      decision: { action: 'allow', riskScore: 0.1, reasons: [] },
      createdAt: ts,
    });

    insert.run(oldId1, makeRaw(oldId1, oldTs), oldTs);
    insert.run(oldId2, makeRaw(oldId2, oldTs), oldTs);
    insert.run(newId,  makeRaw(newId,  newTs), newTs);

    // maxAgeMs = 1000 ms → cutoff = now - 1 s → old logs (10 s ago) are pruned
    const deleted = store.pruneOldLogs(1_000);

    expect(deleted).toBe(2);
    const remaining = await store.listOperationLogs(100, 0);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].operationId).toBe(newId);
  });

  it('returns 0 when all logs are within TTL', async () => {
    const id = randomUUID();
    const nowIso = new Date().toISOString();
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    rawDb.prepare(
      'INSERT INTO operation_logs (operation_id, data, created_at) VALUES (?, ?, ?)'
    ).run(id, JSON.stringify({ operationId: id, operation: { id, agentId: 'a', tool: 't', method: 'm', params: {}, timestamp: nowIso, sessionId: 's' }, decision: { action: 'allow', riskScore: 0, reasons: [] }, createdAt: nowIso }), nowIso);

    // Large maxAge means nothing is old enough to delete
    const deleted = store.pruneOldLogs(999_999_999);
    expect(deleted).toBe(0);
  });

  it('pruneOldLogs(0) deletes everything', async () => {
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = rawDb.prepare(
      'INSERT INTO operation_logs (operation_id, data, created_at) VALUES (?, ?, ?)'
    );
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const ts = new Date(Date.now() - (i + 1) * 1000).toISOString();
      insert.run(id, JSON.stringify({ operationId: id, operation: { id, agentId: 'a', tool: 't', method: 'm', params: {}, timestamp: ts, sessionId: 's' }, decision: { action: 'allow', riskScore: 0, reasons: [] }, createdAt: ts }), ts);
    }
    const deleted = store.pruneOldLogs(0);
    expect(deleted).toBe(3);
    expect(await store.listOperationLogs(100, 0)).toHaveLength(0);
  });

  it('return value matches actual number of deleted rows', async () => {
    const rawDb = (store as unknown as { db: import('better-sqlite3').Database }).db;
    const insert = rawDb.prepare(
      'INSERT INTO operation_logs (operation_id, data, created_at) VALUES (?, ?, ?)'
    );
    const oldTs = new Date(Date.now() - 5_000).toISOString();
    for (let i = 0; i < 4; i++) {
      const id = randomUUID();
      insert.run(id, JSON.stringify({ operationId: id, operation: { id, agentId: 'a', tool: 't', method: 'm', params: {}, timestamp: oldTs, sessionId: 's' }, decision: { action: 'allow', riskScore: 0, reasons: [] }, createdAt: oldTs }), oldTs);
    }
    const deleted = store.pruneOldLogs(1_000); // 1 s TTL, all 4 logs are 5 s old
    const remaining = await store.listOperationLogs(100, 0);
    expect(deleted).toBe(4);
    expect(remaining).toHaveLength(0);
  });
});

describe('StateStore.getStats', () => {
  let store: StateStore;
  beforeEach(async () => { store = new StateStore(':memory:'); await store.initialize(); });
  afterEach(async () => { await store.close(); });

  it('returns zero counts on empty store', async () => {
    const stats = await store.getStats();
    expect(stats.operationLogs).toBe(0);
    expect(stats.checkpoints).toBe(0);
    expect(stats.pendingApprovals).toBe(0);
    expect(stats.outcomeRecords).toBe(0);
  });

  it('counts reflect saved records', async () => {
    await store.saveOperationLog(makeLog(1));
    await store.saveOperationLog(makeLog(2));
    await store.saveOutcomeRecord(randomUUID(), 'agent-x', 'filesystem', true);

    const stats = await store.getStats();
    expect(stats.operationLogs).toBe(2);
    expect(stats.outcomeRecords).toBe(1);
  });
});
