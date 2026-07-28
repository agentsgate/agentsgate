/**
 * T201 — verify-logs HMAC integrity check.
 * Tests auditLogs() on signed and tampered logs.
 */
import { describe, it, expect } from 'vitest';
import { stampLog, verifyLog, auditLogs } from '../src/utils/audit-hmac.js';
import type { OperationLog } from '../src/types/interfaces.js';

function makeLog(overrides: Partial<OperationLog> = {}): OperationLog {
  return {
    operationId: crypto.randomUUID(),
    operation: {
      id: crypto.randomUUID(),
      agentId: 'agent-1',
      tool: 'filesystem',
      method: 'write_file',
      params: { path: '/tmp/test.txt' },
      timestamp: new Date(),
      sessionId: 'sess-1',
    },
    decision: { action: 'allow', riskScore: 0.1, reasons: [] },
    createdAt: new Date(),
    ...overrides,
  };
}

describe('HMAC log signing and verification', () => {
  const secret = 'test-secret-xyz';

  it('stampLog adds hmac field', () => {
    const log = makeLog();
    const signed = stampLog(log, secret);
    expect(signed.hmac).toBeDefined();
    expect(typeof signed.hmac).toBe('string');
    expect(signed.hmac!.length).toBe(64); // SHA-256 hex
  });

  it('verifyLog returns true for valid signature', () => {
    const signed = stampLog(makeLog(), secret);
    expect(verifyLog(signed, secret)).toBe(true);
  });

  it('verifyLog returns false when hmac is missing', () => {
    const log = makeLog();
    expect(verifyLog(log, secret)).toBe(false);
  });

  it('verifyLog returns false when log is tampered', () => {
    const signed = stampLog(makeLog(), secret);
    const tampered = { ...signed, decision: { ...signed.decision, riskScore: 0.9 } };
    expect(verifyLog(tampered, secret)).toBe(false);
  });

  it('auditLogs separates valid from invalid', () => {
    const valid1 = stampLog(makeLog(), secret);
    const valid2 = stampLog(makeLog(), secret);
    const tampered = { ...stampLog(makeLog(), secret), decision: { action: 'block' as const, riskScore: 0.99, reasons: [] } };
    const unsigned = makeLog();

    const { valid, invalid } = auditLogs([valid1, valid2, tampered, unsigned], secret);
    expect(valid.length).toBe(2);
    expect(invalid.length).toBe(2);
  });

  it('auditLogs with all valid logs returns empty invalid array', () => {
    const logs = [makeLog(), makeLog(), makeLog()].map(l => stampLog(l, secret));
    const { valid, invalid } = auditLogs(logs, secret);
    expect(valid.length).toBe(3);
    expect(invalid.length).toBe(0);
  });
});
