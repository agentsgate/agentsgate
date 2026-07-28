/**
 * T165 — Per-tool operation cost tracking tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool: string): MCPOperation {
  return { id: 'op-1', agentId: 'agent-1', tool, method: 'call', params: {}, timestamp: new Date(), sessionId: 's1' };
}

function makeDecision(): ProxyDecision {
  return { action: 'allow', riskScore: 0.1, reasons: [] };
}

describe('TelemetryService — cost tracking', () => {
  it('getTotalCost defaults to 1.0 per event when no weights configured', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), makeDecision());
    await svc.record(makeOp('shell'), makeDecision());
    expect(svc.getTotalCost()).toBe(2.0);
  });

  it('getTotalCost uses exact-match cost weight', async () => {
    const svc = new TelemetryService({ shell: 5 });
    await svc.record(makeOp('shell'), makeDecision());
    await svc.record(makeOp('filesystem'), makeDecision());
    expect(svc.getTotalCost()).toBe(6.0); // 5 + 1
  });

  it('getTotalCost uses regex cost weight', async () => {
    const svc = new TelemetryService({ '/database.*/': 3 });
    await svc.record(makeOp('database_read'), makeDecision());
    await svc.record(makeOp('database_write'), makeDecision());
    expect(svc.getTotalCost()).toBe(6.0);
  });

  it('exact match takes precedence over regex', async () => {
    const svc = new TelemetryService({ shell: 10, '/shell.*/': 2 });
    await svc.record(makeOp('shell'), makeDecision());
    expect(svc.getTotalCost()).toBe(10.0);
  });

  it('getCostByTool returns per-tool breakdown', async () => {
    const svc = new TelemetryService({ shell: 5, filesystem: 2 });
    await svc.record(makeOp('shell'), makeDecision());
    await svc.record(makeOp('shell'), makeDecision());
    await svc.record(makeOp('filesystem'), makeDecision());
    const breakdown = svc.getCostByTool();
    expect(breakdown['shell']).toBe(10.0);
    expect(breakdown['filesystem']).toBe(2.0);
  });

  it('getStats includes totalCost and costByTool', async () => {
    const svc = new TelemetryService({ shell: 4 });
    await svc.record(makeOp('shell'), makeDecision());
    await svc.record(makeOp('other'), makeDecision());
    const stats = await svc.getStats();
    expect(stats.totalCost).toBe(5.0); // 4 + 1
    expect(stats.costByTool['shell']).toBe(4.0);
    expect(stats.costByTool['other']).toBe(1.0);
  });

  it('getTotalCost returns 0 for empty buffer', () => {
    const svc = new TelemetryService({ shell: 5 });
    expect(svc.getTotalCost()).toBe(0);
  });

  it('cost resets to 0 after flush', async () => {
    const svc = new TelemetryService({ shell: 5 });
    await svc.record(makeOp('shell'), makeDecision());
    expect(svc.getTotalCost()).toBe(5.0);
    await svc.flush();
    expect(svc.getTotalCost()).toBe(0);
  });

  it('invalid regex pattern falls back to default cost', async () => {
    const svc = new TelemetryService({ '/[invalid/': 99 });
    await svc.record(makeOp('filesystem'), makeDecision());
    expect(svc.getTotalCost()).toBe(1.0); // default
  });
});
