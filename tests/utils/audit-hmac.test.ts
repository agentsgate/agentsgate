/**
 * T140 — Audit trail HMAC signing.
 */
import { describe, it, expect } from 'vitest';
import { signLog, verifyLog, stampLog, auditLogs } from '../../src/utils/audit-hmac.js';
import type { OperationLog } from '../../src/types/interfaces.js';

function makeLog(id = 'op-1'): OperationLog {
  return {
    operationId: id,
    operation: {
      id,
      agentId: 'agent-1',
      tool: 'filesystem',
      method: 'write_file',
      params: { path: '/tmp/test.txt' },
      timestamp: new Date('2026-01-01T00:00:00Z'),
      sessionId: 'sess-1',
    },
    decision: { action: 'allow', riskScore: 0.1, reasons: [] },
    createdAt: new Date('2026-01-01T00:00:01Z'),
  };
}

const SECRET = 'super-secret-key';

describe('signLog', () => {
  it('returns a 64-char hex string', () => {
    const sig = signLog(makeLog(), SECRET);
    expect(sig).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for the same input', () => {
    const log = makeLog();
    expect(signLog(log, SECRET)).toBe(signLog(log, SECRET));
  });

  it('differs for different secrets', () => {
    const log = makeLog();
    expect(signLog(log, 'secret-a')).not.toBe(signLog(log, 'secret-b'));
  });

  it('differs when operationId changes', () => {
    expect(signLog(makeLog('op-1'), SECRET)).not.toBe(signLog(makeLog('op-2'), SECRET));
  });
});

describe('verifyLog', () => {
  it('returns true for a correctly signed log', () => {
    const log = stampLog(makeLog(), SECRET);
    expect(verifyLog(log, SECRET)).toBe(true);
  });

  it('returns false when hmac is missing', () => {
    expect(verifyLog(makeLog(), SECRET)).toBe(false);
  });

  it('returns false for wrong secret', () => {
    const log = stampLog(makeLog(), SECRET);
    expect(verifyLog(log, 'wrong-secret')).toBe(false);
  });

  it('returns false when log content is tampered', () => {
    const log = stampLog(makeLog(), SECRET);
    // Tamper: change the agentId
    const tampered: OperationLog = {
      ...log,
      operation: { ...log.operation, agentId: 'evil-agent' },
    };
    expect(verifyLog(tampered, SECRET)).toBe(false);
  });

  it('returns false when hmac string is corrupted', () => {
    const log = stampLog(makeLog(), SECRET);
    const corrupted: OperationLog = { ...log, hmac: log.hmac!.replace(/.$/, 'x') };
    expect(verifyLog(corrupted, SECRET)).toBe(false);
  });
});

describe('stampLog', () => {
  it('returns a new object with hmac field set', () => {
    const original = makeLog();
    const stamped  = stampLog(original, SECRET);
    expect(original.hmac).toBeUndefined();
    expect(typeof stamped.hmac).toBe('string');
    expect(stamped.operationId).toBe(original.operationId);
  });

  it('executionResult does not affect the signature', () => {
    const base    = makeLog();
    const stamped = stampLog(base, SECRET);
    const withResult: OperationLog = {
      ...stamped,
      executionResult: { success: true, output: 'done' },
    };
    // Signature was computed before executionResult was added, but verify should still pass
    expect(verifyLog(withResult, SECRET)).toBe(true);
  });
});

describe('auditLogs', () => {
  it('splits logs into valid and invalid buckets', () => {
    const good = stampLog(makeLog('op-good'), SECRET);
    const bad  = makeLog('op-bad'); // no hmac
    const tampered: OperationLog = {
      ...stampLog(makeLog('op-tampered'), SECRET),
      operation: { ...makeLog('op-tampered').operation, agentId: 'hacker' },
    };

    const { valid, invalid } = auditLogs([good, bad, tampered], SECRET);
    expect(valid.map(l => l.operationId)).toEqual(['op-good']);
    expect(invalid.map(l => l.operationId).sort()).toEqual(['op-bad', 'op-tampered']);
  });

  it('returns all valid when all logs are correctly signed', () => {
    const logs = ['a', 'b', 'c'].map(id => stampLog(makeLog(id), SECRET));
    const { valid, invalid } = auditLogs(logs, SECRET);
    expect(valid).toHaveLength(3);
    expect(invalid).toHaveLength(0);
  });
});

describe('OperationLogger integration', () => {
  it('stamps logs when signingSecret provided', async () => {
    const { StateStore } = await import('../../src/modules/m2-store/index.js');
    const { OperationLogger } = await import('../../src/modules/m3-logger/index.js');

    const store = new StateStore(':memory:');
    await store.initialize();
    const logger = new OperationLogger(store, SECRET);

    const op = makeLog().operation;
    const dec = makeLog().decision;
    const saved = await logger.log(op, dec);

    expect(typeof saved.hmac).toBe('string');
    expect(verifyLog(saved, SECRET)).toBe(true);

    // Round-trip: load from DB and verify
    const loaded = await store.getOperationLog(op.id);
    expect(loaded).not.toBeNull();
    expect(verifyLog(loaded!, SECRET)).toBe(true);

    await store.close();
  });

  it('does NOT stamp logs when no secret provided', async () => {
    const { StateStore } = await import('../../src/modules/m2-store/index.js');
    const { OperationLogger } = await import('../../src/modules/m3-logger/index.js');

    const store = new StateStore(':memory:');
    await store.initialize();
    const logger = new OperationLogger(store); // no secret

    const saved = await logger.log(makeLog().operation, makeLog().decision);
    expect(saved.hmac).toBeUndefined();

    await store.close();
  });
});
