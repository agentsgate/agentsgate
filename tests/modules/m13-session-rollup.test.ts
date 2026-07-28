/**
 * T183 — Telemetry session rollup: getSessionStats / listSessions.
 */
import { describe, it, expect } from 'vitest';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool: string, sessionId = 'sess-1'): MCPOperation {
  return { id: 'op-1', agentId: 'a', tool, method: 'call', params: {}, timestamp: new Date(), sessionId };
}
function dec(action: ProxyDecision['action'] = 'allow', riskScore = 0.2): ProxyDecision {
  return { action, riskScore, reasons: [] };
}

describe('TelemetryService — session rollup', () => {
  it('getSessionStats returns null for unknown session', async () => {
    const svc = new TelemetryService();
    expect(svc.getSessionStats('no-such-session')).toBeNull();
  });

  it('getSessionStats aggregates events for a session', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('fs', 'sess-1'), dec('allow', 0.1));
    await svc.record(makeOp('shell', 'sess-1'), dec('block', 0.9));
    await svc.record(makeOp('db', 'sess-1'), dec('allow', 0.3));
    const stats = svc.getSessionStats('sess-1');
    expect(stats).not.toBeNull();
    expect(stats!.totalEvents).toBe(3);
    expect(stats!.byAction.allow).toBe(2);
    expect(stats!.byAction.block).toBe(1);
    expect(stats!.avgRiskScore).toBeCloseTo((0.1 + 0.9 + 0.3) / 3, 5);
    expect(stats!.maxRiskScore).toBe(0.9);
    expect(stats!.byTool['fs']).toBe(1);
    expect(stats!.byTool['shell']).toBe(1);
  });

  it('getSessionStats isolates sessions — different sessions do not mix', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('fs', 'sess-1'), dec('allow', 0.1));
    await svc.record(makeOp('shell', 'sess-2'), dec('block', 0.9));
    const s1 = svc.getSessionStats('sess-1')!;
    const s2 = svc.getSessionStats('sess-2')!;
    expect(s1.totalEvents).toBe(1);
    expect(s2.totalEvents).toBe(1);
    expect(s1.byTool['shell']).toBeUndefined();
    expect(s2.byTool['fs']).toBeUndefined();
  });

  it('listSessions returns all unique session IDs', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('fs', 'sess-a'), dec());
    await svc.record(makeOp('fs', 'sess-b'), dec());
    await svc.record(makeOp('shell', 'sess-a'), dec());
    const sessions = svc.listSessions();
    expect(sessions).toContain('sess-a');
    expect(sessions).toContain('sess-b');
    expect(sessions).toHaveLength(2);
  });

  it('listSessions returns empty array for empty buffer', () => {
    const svc = new TelemetryService();
    expect(svc.listSessions()).toHaveLength(0);
  });

  it('firstEvent and lastEvent bracket the session window', async () => {
    const svc = new TelemetryService();
    const t1 = Date.now();
    await svc.record(makeOp('a', 'sess-1'), dec());
    await new Promise(r => setTimeout(r, 10));
    await svc.record(makeOp('b', 'sess-1'), dec());
    const t2 = Date.now();
    const stats = svc.getSessionStats('sess-1')!;
    expect(stats.firstEvent).toBeGreaterThanOrEqual(t1);
    expect(stats.lastEvent).toBeLessThanOrEqual(t2);
    expect(stats.lastEvent).toBeGreaterThanOrEqual(stats.firstEvent);
  });
});
