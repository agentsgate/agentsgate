/**
 * T125 — Database table rollback adapter.
 *
 * Tests the adapter with an in-memory SQL executor (no real DB) that
 * records executed SQL statements for assertion.
 */
import { describe, it, expect } from 'vitest';
import { DatabaseTableRollbackAdapter } from '../../src/modules/m9-plugin-sdk/index.js';
import type { MCPOperation, StateSnapshot } from '../../src/types/interfaces.js';

/** Create an executor that records SQL and optionally returns preset rows. */
function makeExec(rows: Array<Record<string, unknown>> = []) {
  const executed: string[] = [];
  const exec = async (sql: string) => {
    executed.push(sql);
    if (sql.trimStart().toUpperCase().startsWith('SELECT')) return rows;
    return [];
  };
  return { exec, executed };
}

function makeOp(method: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id: 'op-1', agentId: 'agent-1', tool: 'database', method,
    params, timestamp: new Date(), sessionId: 'sess-1',
  };
}

function makeSnap(data: Record<string, unknown>): StateSnapshot {
  return { adapterId: 'database-table', operationId: 'op-1', data, capturedAt: new Date() };
}

describe('DatabaseTableRollbackAdapter.canRollback', () => {
  it('returns true for insert_row', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const cap = await a.canRollback(makeOp('insert_row', { table: 'users' }));
    expect(cap.canRollback).toBe(true);
    expect(cap.confidence).toBeGreaterThan(0);
  });

  it('returns false when table is missing', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const cap = await a.canRollback(makeOp('insert_row', {}));
    expect(cap.canRollback).toBe(false);
  });

  it('returns false for unsupported method (select)', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const cap = await a.canRollback(makeOp('select', { table: 'users' }));
    expect(cap.canRollback).toBe(false);
    expect(cap.limitations![0]).toMatch(/not rollback-supported/i);
  });
});

describe('DatabaseTableRollbackAdapter.captureState', () => {
  it('runs SELECT for delete operations to capture pre-delete rows', async () => {
    const { exec, executed } = makeExec([{ id: 1, name: 'Alice' }]);
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const op = makeOp('delete_row', {
      table: 'users', where: { id: 1 }, primaryKeys: ['id'],
    });
    const snap = await a.captureState(op);
    expect(executed.some(s => s.includes('SELECT'))).toBe(true);
    expect((snap.data['capturedRows'] as unknown[]).length).toBe(1);
    expect(snap.data['table']).toBe('users');
    expect(snap.data['operation']).toBe('delete');
  });

  it('does NOT run SELECT for insert operations', async () => {
    const { exec, executed } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const op = makeOp('insert_row', { table: 'users', primaryKeyValues: { id: 42 } });
    await a.captureState(op);
    expect(executed.filter(s => s.includes('SELECT'))).toHaveLength(0);
  });
});

describe('DatabaseTableRollbackAdapter.rollback', () => {
  it('DELETE rollback of an insert', async () => {
    const { exec, executed } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'orders', operation: 'insert',
      primaryKeys: ['id'], primaryKeyValues: { id: 99 }, capturedRows: [],
    });
    const result = await a.rollback(snap);
    expect(result.success).toBe(true);
    expect(result.restoredFiles).toContain('orders');
    expect(executed[0]).toMatch(/DELETE FROM "orders" WHERE "id" = 99/i);
  });

  it('INSERT rollback of a delete (re-inserts captured rows)', async () => {
    const { exec, executed } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'users', operation: 'delete',
      primaryKeys: ['id'], primaryKeyValues: {},
      capturedRows: [{ id: 5, name: 'Bob', email: 'bob@example.com' }],
    });
    const result = await a.rollback(snap);
    expect(result.success).toBe(true);
    expect(executed[0]).toMatch(/INSERT INTO "users"/i);
    expect(executed[0]).toMatch(/Bob/i);
  });

  it('UPDATE rollback restores original values', async () => {
    const { exec, executed } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'products', operation: 'update',
      primaryKeys: ['id'], primaryKeyValues: { id: 10 },
      capturedRows: [{ id: 10, price: 19.99, name: 'Widget' }],
    });
    const result = await a.rollback(snap);
    expect(result.success).toBe(true);
    expect(executed[0]).toMatch(/UPDATE "products" SET/i);
    expect(executed[0]).toMatch(/WHERE "id" = 10/i);
  });

  it('fails gracefully when primary key values missing for insert rollback', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'users', operation: 'insert',
      primaryKeys: ['id'], primaryKeyValues: {}, capturedRows: [],
    });
    const result = await a.rollback(snap);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/primary key/i);
  });

  it('fails when no captured rows for delete rollback', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'users', operation: 'delete',
      primaryKeys: ['id'], primaryKeyValues: { id: 1 }, capturedRows: [],
    });
    const result = await a.rollback(snap);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no captured rows/i);
  });
});

describe('DatabaseTableRollbackAdapter.previewRollback', () => {
  it('describes DELETE for an insert rollback', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'orders', operation: 'insert',
      primaryKeys: ['id'], primaryKeyValues: { id: 7 }, capturedRows: [],
    });
    const preview = await a.previewRollback(snap);
    expect(preview.willRestore[0]).toMatch(/DELETE FROM "orders"/i);
  });

  it('describes INSERT for a delete rollback', async () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    const snap = makeSnap({
      table: 'logs', operation: 'delete',
      primaryKeys: ['id'], primaryKeyValues: {}, capturedRows: [{ id: 1 }],
    });
    const preview = await a.previewRollback(snap);
    expect(preview.willRestore[0]).toMatch(/INSERT 1 row/i);
  });
});

describe('DatabaseTableRollbackAdapter metadata', () => {
  it('has correct adapterId, version, supportedTools', () => {
    const { exec } = makeExec();
    const a = new DatabaseTableRollbackAdapter({ execSQL: exec });
    expect(a.adapterId).toBe('database-table');
    expect(a.version).toBe('1.0.0');
    expect(a.supportedTools).toContain('database');
    expect(a.supportedTools).toContain('sql');
  });
});
