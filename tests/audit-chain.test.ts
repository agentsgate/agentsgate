/**
 * Audit log chaining.
 *
 * Per-record HMACs detect a record being edited. They do not detect one being
 * deleted: an attacker with database write access could drop the rows
 * describing what they did and every remaining signature would still verify.
 * Chaining each record onto its predecessor is what closes that.
 */
import { describe, it, expect } from 'vitest';
import { signLog, stampLog, verifyLog, verifyChain, GENESIS_HMAC } from '../src/utils/audit-hmac.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { OperationLogger } from '../src/modules/m3-logger/index.js';
import type { MCPOperation, ProxyDecision, OperationLog } from '../src/types/interfaces.js';

const SECRET = 'test-signing-secret';

function op(id: string): MCPOperation {
  return {
    id, agentId: 'agent-a', tool: 'filesystem', method: 'write_file',
    params: { path: `/tmp/${id}` }, timestamp: new Date('2026-01-01T00:00:00Z'), sessionId: 's',
  };
}
const dec = (score = 0.5): ProxyDecision => ({ action: 'allow', riskScore: score, reasons: [] });

function logRecord(id: string): OperationLog {
  return { operationId: id, operation: op(id), decision: dec(), createdAt: new Date('2026-01-01T00:00:00Z') };
}

async function seedChain(count: number): Promise<{ store: StateStore; logs: OperationLog[] }> {
  const store = new StateStore(':memory:');
  await store.initialize();
  const logger = new OperationLogger(store, SECRET);
  for (let i = 0; i < count; i++) await logger.log(op(`op-${i}`), dec(i / 10));
  return { store, logs: await store.listOperationLogsForChain() };
}

describe('signing binds a record to its predecessor', () => {
  it('produces a different signature for a different predecessor', () => {
    const rec = logRecord('op-1');
    expect(signLog(rec, SECRET, 'aaa')).not.toBe(signLog(rec, SECRET, 'bbb'));
  });

  it('is deterministic for the same predecessor', () => {
    const rec = logRecord('op-1');
    expect(signLog(rec, SECRET, 'aaa')).toBe(signLog(rec, SECRET, 'aaa'));
  });

  it('verifies only against the predecessor it was signed with', () => {
    const rec = stampLog(logRecord('op-1'), SECRET, 'aaa');
    expect(verifyLog(rec, SECRET, 'aaa')).toBe(true);
    expect(verifyLog(rec, SECRET, 'bbb')).toBe(false);
  });

  it('rejects a record with no signature', () => {
    expect(verifyLog(logRecord('op-1'), SECRET)).toBe(false);
  });

  it('rejects the wrong secret', () => {
    const rec = stampLog(logRecord('op-1'), SECRET, GENESIS_HMAC);
    expect(verifyLog(rec, 'other-secret', GENESIS_HMAC)).toBe(false);
  });
});

describe('verifyChain', () => {
  it('accepts an untouched chain written by the logger', async () => {
    const { store, logs } = await seedChain(5);
    const r = verifyChain(logs, SECRET);
    expect(r.intact).toBe(true);
    expect(r.valid).toHaveLength(5);
    expect(r.invalid).toHaveLength(0);
    expect(r.brokenAt).toBe(-1);
    await store.close();
  });

  it('accepts an empty log', () => {
    expect(verifyChain([], SECRET).intact).toBe(true);
  });

  // The property per-record signing could not provide.
  it('detects a record deleted from the middle', async () => {
    const { store, logs } = await seedChain(5);
    const withHole = [...logs.slice(0, 2), ...logs.slice(3)];

    const r = verifyChain(withHole, SECRET);
    expect(r.intact).toBe(false);
    expect(r.brokenAt).toBe(2);          // the record that followed the hole
    expect(r.valid).toHaveLength(2);     // everything before it still attests
    await store.close();
  });

  it('detects the last record being dropped only via the tip, not the chain', async () => {
    // Truncating the tail leaves a shorter but internally consistent chain.
    // This is a real limitation and worth stating: guarding against it needs
    // the expected tip recorded somewhere outside the database.
    const { store, logs } = await seedChain(5);
    expect(verifyChain(logs.slice(0, 4), SECRET).intact).toBe(true);
    await store.close();
  });

  it('detects an edited record', async () => {
    const { store, logs } = await seedChain(4);
    const tampered = logs.map((l, i) =>
      i === 1 ? { ...l, decision: { ...l.decision, action: 'allow' as const, riskScore: 0.01 } } : l);

    const r = verifyChain(tampered, SECRET);
    expect(r.intact).toBe(false);
    expect(r.brokenAt).toBe(1);
    await store.close();
  });

  it('detects records being reordered', async () => {
    const { store, logs } = await seedChain(4);
    const swapped = [logs[0]!, logs[2]!, logs[1]!, logs[3]!];
    expect(verifyChain(swapped, SECRET).intact).toBe(false);
    await store.close();
  });

  it('detects a record appended by someone without the secret', async () => {
    const { store, logs } = await seedChain(3);
    const forged = stampLog(logRecord('op-forged'), 'attacker-secret', logs[2]!.hmac!);
    const r = verifyChain([...logs, forged], SECRET);
    expect(r.intact).toBe(false);
    expect(r.brokenAt).toBe(3);
    await store.close();
  });

  it('reports everything after a break as unverified, not as valid', async () => {
    const { store, logs } = await seedChain(6);
    const withHole = [...logs.slice(0, 1), ...logs.slice(2)];

    const r = verifyChain(withHole, SECRET);
    expect(r.valid).toHaveLength(1);
    expect(r.invalid).toHaveLength(4);
    expect(r.valid.length + r.invalid.length).toBe(withHole.length);
    await store.close();
  });
});

describe('logger and store integration', () => {
  it('links each record to the tip the store reports', async () => {
    const { store, logs } = await seedChain(3);
    expect(await store.getLastLogHmac()).toBe(logs[2]!.hmac);
    await store.close();
  });

  it('starts the chain from the genesis value', async () => {
    const { store, logs } = await seedChain(1);
    expect(verifyLog(logs[0]!, SECRET, GENESIS_HMAC)).toBe(true);
    await store.close();
  });

  it('reports no tip for an empty store', async () => {
    const store = new StateStore(':memory:');
    await store.initialize();
    expect(await store.getLastLogHmac()).toBeNull();
    await store.close();
  });

  it('returns records oldest first, the order verification needs', async () => {
    const { store, logs } = await seedChain(4);
    expect(logs.map(l => l.operationId)).toEqual(['op-0', 'op-1', 'op-2', 'op-3']);

    const newestFirst = await store.listOperationLogs(10, 0);
    expect(newestFirst[0]!.operationId).toBe('op-3');
    // Passing the display order to verifyChain must not silently "pass".
    expect(verifyChain(newestFirst, SECRET).intact).toBe(false);
    await store.close();
  });

  it('keeps the chain intact when writes are issued concurrently', async () => {
    // Two callers logging at once must not both chain onto the same tip.
    const store = new StateStore(':memory:');
    await store.initialize();
    const logger = new OperationLogger(store, SECRET);

    await Promise.all(Array.from({ length: 12 }, (_, i) => logger.log(op(`c-${i}`), dec(0.2))));

    const logs = await store.listOperationLogsForChain();
    expect(logs).toHaveLength(12);
    expect(verifyChain(logs, SECRET).intact).toBe(true);
    await store.close();
  });

  it('leaves records unsigned when no secret is configured', async () => {
    const store = new StateStore(':memory:');
    await store.initialize();
    const logger = new OperationLogger(store);
    await logger.log(op('op-plain'), dec());

    const logs = await store.listOperationLogsForChain();
    expect(logs[0]!.hmac).toBeUndefined();
    await store.close();
  });
});

describe('records carry their own predecessor', () => {
  it('lets a single record be verified without its neighbours', async () => {
    const { store, logs } = await seedChain(4);
    const lone = logs[2]!;
    expect(lone.prevHmac).toBe(logs[1]!.hmac);
    expect(verifyLog(lone, SECRET)).toBe(true);      // no prevHmac argument
    await store.close();
  });

  it('records the genesis value on the first entry', async () => {
    const { store, logs } = await seedChain(2);
    expect(logs[0]!.prevHmac).toBe(GENESIS_HMAC);
    await store.close();
  });

  it('rejects a record whose recorded predecessor was altered', async () => {
    const { store, logs } = await seedChain(3);
    const forged = { ...logs[2]!, prevHmac: 'f'.repeat(64) };
    expect(verifyLog(forged, SECRET)).toBe(false);
    await store.close();
  });
});
