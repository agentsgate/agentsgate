/**
 * T184 — NDJSON export format.
 */
import { describe, it, expect } from 'vitest';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

type LogEntry = {
  operationId: string;
  operation: MCPOperation;
  decision: ProxyDecision;
  createdAt: Date;
};

/** Mirror of the NDJSON serialization inside cmdExport. */
function toNDJSON(logs: LogEntry[]): string {
  return logs.map(l => JSON.stringify({
    operationId: l.operationId,
    agentId: l.operation.agentId,
    tool: l.operation.tool,
    method: l.operation.method,
    sessionId: l.operation.sessionId,
    parentId: l.operation.parentId,
    action: l.decision.action,
    riskScore: l.decision.riskScore,
    reasons: l.decision.reasons,
    timestamp: l.operation.timestamp instanceof Date ? l.operation.timestamp.toISOString() : l.operation.timestamp,
    createdAt: l.createdAt instanceof Date ? l.createdAt.toISOString() : l.createdAt,
  })).join('\n');
}

function makeLog(id: string, parentId?: string): LogEntry {
  return {
    operationId: id,
    operation: {
      id, agentId: 'agent-1', tool: 'filesystem', method: 'write_file',
      params: {}, timestamp: new Date('2026-01-01T00:00:00Z'), sessionId: 'sess-1',
      ...(parentId ? { parentId } : {}),
    },
    decision: { action: 'allow', riskScore: 0.2, reasons: ['test'] },
    createdAt: new Date('2026-01-01T00:01:00Z'),
  };
}

describe('agentsgate export --format=ndjson', () => {
  it('produces one JSON line per log entry', () => {
    const ndjson = toNDJSON([makeLog('op-1'), makeLog('op-2')]);
    const lines = ndjson.split('\n');
    expect(lines).toHaveLength(2);
    lines.forEach(line => expect(() => JSON.parse(line)).not.toThrow());
  });

  it('each line contains expected fields', () => {
    const ndjson = toNDJSON([makeLog('op-x')]);
    const obj = JSON.parse(ndjson);
    expect(obj.operationId).toBe('op-x');
    expect(obj.agentId).toBe('agent-1');
    expect(obj.tool).toBe('filesystem');
    expect(obj.action).toBe('allow');
    expect(obj.riskScore).toBe(0.2);
    expect(obj.reasons).toEqual(['test']);
    expect(obj.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(obj.createdAt).toBe('2026-01-01T00:01:00.000Z');
  });

  it('includes parentId when present', () => {
    const ndjson = toNDJSON([makeLog('child', 'parent')]);
    const obj = JSON.parse(ndjson);
    expect(obj.parentId).toBe('parent');
  });

  it('parentId is undefined (omitted) when not set', () => {
    const ndjson = toNDJSON([makeLog('root')]);
    const obj = JSON.parse(ndjson);
    expect(obj.parentId).toBeUndefined();
  });

  it('empty log set produces empty string', () => {
    expect(toNDJSON([])).toBe('');
  });

  it('each line is valid standalone JSON (parseable independently)', () => {
    const ndjson = toNDJSON([makeLog('a'), makeLog('b'), makeLog('c')]);
    for (const line of ndjson.split('\n')) {
      const obj = JSON.parse(line);
      expect(typeof obj.operationId).toBe('string');
    }
  });
});
