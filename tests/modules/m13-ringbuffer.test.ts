/**
 * T171 — Telemetry ring-buffer maxEvents cap.
 */
import { describe, it, expect } from 'vitest';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool = 'filesystem'): MCPOperation {
  return { id: 'op-1', agentId: 'agent-1', tool, method: 'call', params: {}, timestamp: new Date(), sessionId: 's1' };
}
function makeDecision(riskScore = 0.1): ProxyDecision {
  return { action: 'allow', riskScore, reasons: [] };
}

describe('TelemetryService — ring-buffer maxEvents', () => {
  it('buffer grows freely when maxEvents is not set', async () => {
    const svc = new TelemetryService({});
    for (let i = 0; i < 50; i++) await svc.record(makeOp(), makeDecision());
    const stats = await svc.getStats();
    expect(stats.totalEvents).toBe(50);
    expect(stats.bufferSize).toBe(50);
  });

  it('buffer does not exceed maxEvents', async () => {
    const svc = new TelemetryService({}, 10);
    for (let i = 0; i < 25; i++) await svc.record(makeOp(), makeDecision());
    const stats = await svc.getStats();
    expect(stats.bufferSize).toBe(10);
  });

  it('totalEvents equals bufferSize when under cap', async () => {
    const svc = new TelemetryService({}, 100);
    for (let i = 0; i < 5; i++) await svc.record(makeOp(), makeDecision());
    const stats = await svc.getStats();
    expect(stats.totalEvents).toBe(5);
    expect(stats.bufferSize).toBe(5);
  });

  it('oldest events are evicted first (ring-buffer semantics)', async () => {
    const svc = new TelemetryService({}, 3);
    await svc.record(makeOp('tool-a'), makeDecision(0.1));
    await svc.record(makeOp('tool-b'), makeDecision(0.5));
    await svc.record(makeOp('tool-c'), makeDecision(0.9));
    // Cap full — next record evicts tool-a
    await svc.record(makeOp('tool-d'), makeDecision(0.2));

    const stats = await svc.getStats();
    expect(stats.bufferSize).toBe(3);
    // tool-a should be gone; tool-b, tool-c, tool-d present
    expect(stats.byTool['tool-a']).toBeUndefined();
    expect(stats.byTool['tool-b']).toBe(1);
    expect(stats.byTool['tool-d']).toBe(1);
  });

  it('maxEvents=1 keeps only the most recent event', async () => {
    const svc = new TelemetryService({}, 1);
    await svc.record(makeOp('old'), makeDecision(0.1));
    await svc.record(makeOp('new'), makeDecision(0.9));
    const stats = await svc.getStats();
    expect(stats.bufferSize).toBe(1);
    expect(stats.byTool['new']).toBe(1);
    expect(stats.byTool['old']).toBeUndefined();
  });

  it('getStats includes bufferSize field', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp(), makeDecision());
    const stats = await svc.getStats();
    expect(stats).toHaveProperty('bufferSize');
    expect(typeof stats.bufferSize).toBe('number');
  });
});
