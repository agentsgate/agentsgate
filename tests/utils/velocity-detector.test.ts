/**
 * T123 — Velocity detection: risk boost for rapid-fire operations.
 */
import { describe, it, expect } from 'vitest';
import { VelocityDetector } from '../../src/utils/velocity-detector.js';

describe('VelocityDetector', () => {
  it('returns 0 boost below threshold', () => {
    const vd = new VelocityDetector({ threshold: 5, windowMs: 60_000, maxBoost: 0.4, decayFactor: 0.1 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      expect(vd.record('agent-a', now + i)).toBe(0);
    }
  });

  it('returns positive boost above threshold', () => {
    const vd = new VelocityDetector({ threshold: 5, windowMs: 60_000, maxBoost: 0.4, decayFactor: 0.1 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) vd.record('agent-a', now + i);
    const boost = vd.record('agent-a', now + 5); // 6th op → excess=1
    expect(boost).toBeCloseTo(0.1);
  });

  it('boost is capped at maxBoost', () => {
    const vd = new VelocityDetector({ threshold: 2, windowMs: 60_000, maxBoost: 0.3, decayFactor: 0.1 });
    const now = Date.now();
    for (let i = 0; i < 20; i++) vd.record('agent-a', now + i);
    const boost = vd.peek('agent-a', now + 20);
    expect(boost).toBeLessThanOrEqual(0.3);
    expect(boost).toBeCloseTo(0.3);
  });

  it('isolates agents independently', () => {
    const vd = new VelocityDetector({ threshold: 3, windowMs: 60_000, maxBoost: 0.4, decayFactor: 0.1 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) vd.record('agent-a', now + i);
    // agent-b has no ops
    expect(vd.peek('agent-b', now + 5)).toBe(0);
    expect(vd.peek('agent-a', now + 5)).toBeGreaterThan(0);
  });

  it('prunes timestamps outside the window', () => {
    const vd = new VelocityDetector({ threshold: 3, windowMs: 1_000, maxBoost: 0.4, decayFactor: 0.1 });
    const now = Date.now();
    // Record ops at t=0 (old)
    for (let i = 0; i < 10; i++) vd.record('agent-a', now);
    // Check 2 seconds later — all should have expired
    const count = vd.getCount('agent-a', now + 2_000);
    expect(count).toBe(0);
  });

  it('getCount returns correct window count', () => {
    const vd = new VelocityDetector({ threshold: 10, windowMs: 60_000 });
    const now = Date.now();
    for (let i = 0; i < 7; i++) vd.record('agent-a', now + i);
    expect(vd.getCount('agent-a', now + 7)).toBe(7);
  });

  it('reset clears specific agent', () => {
    const vd = new VelocityDetector({ threshold: 2, windowMs: 60_000 });
    const now = Date.now();
    for (let i = 0; i < 5; i++) { vd.record('agent-a', now + i); vd.record('agent-b', now + i); }
    vd.reset('agent-a');
    expect(vd.getCount('agent-a', now + 5)).toBe(0);
    expect(vd.getCount('agent-b', now + 5)).toBe(5);
  });

  it('reset() with no arg clears all agents', () => {
    const vd = new VelocityDetector({ threshold: 2, windowMs: 60_000 });
    const now = Date.now();
    for (let i = 0; i < 3; i++) { vd.record('a', now + i); vd.record('b', now + i); }
    vd.reset();
    expect(vd.getCount('a', now + 3)).toBe(0);
    expect(vd.getCount('b', now + 3)).toBe(0);
  });

  it('config getter returns all options', () => {
    const vd = new VelocityDetector({ threshold: 15, windowMs: 30_000, maxBoost: 0.5, decayFactor: 0.02 });
    expect(vd.config).toEqual({ threshold: 15, windowMs: 30_000, maxBoost: 0.5, decayFactor: 0.02 });
  });

  it('default options are sane', () => {
    const vd = new VelocityDetector();
    expect(vd.config.threshold).toBe(20);
    expect(vd.config.windowMs).toBe(60_000);
    expect(vd.config.maxBoost).toBe(0.4);
    expect(vd.config.decayFactor).toBe(0.05);
  });
});

describe('VelocityDetector wired into pipeline', () => {
  it('pipeline applies velocity boost when detector fires', async () => {
    const { createPipeline } = await import('../../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../../src/modules/m7-intervention/index.js');
    const { VelocityDetector: VD } = await import('../../src/utils/velocity-detector.js');
    const { randomUUID } = await import('node:crypto');

    const velocityDetector = new VD({ threshold: 2, windowMs: 60_000, maxBoost: 0.5, decayFactor: 0.3 });
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(0.3, 0.7),
      velocityDetector,
    });

    function makeOp() {
      return {
        id: randomUUID(), agentId: 'agent-fast', tool: 'filesystem', method: 'read_file',
        params: {}, timestamp: new Date(), sessionId: 'sess-1',
      };
    }

    // First 2 ops: no boost (at/below threshold=2)
    const d1 = await pipeline.evaluateRisk!(makeOp());
    const d2 = await pipeline.evaluateRisk!(makeOp());
    expect(d1.riskScore).toBeLessThanOrEqual(0.2); // L1 read score = 0.05
    expect(d2.riskScore).toBeLessThanOrEqual(0.2);

    // 3rd op: excess=1 → boost=0.3 → risk = 0.05 + 0.3 = 0.35 → require_approval
    const d3 = await pipeline.evaluateRisk!(makeOp());
    expect(d3.riskScore).toBeGreaterThan(0.2);
    // Velocity rule should appear in firedRules
    const velocityRule = d3.firedRules?.find(r => r.id === 'VELOCITY_BOOST');
    expect(velocityRule).toBeDefined();
    expect(velocityRule!.score).toBeCloseTo(0.3);
  });
});
