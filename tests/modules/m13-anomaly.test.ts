/**
 * T127 — Telemetry anomaly detection (z-score per-tool spike alert).
 */
import { describe, it, expect } from 'vitest';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool: string): MCPOperation {
  return {
    id: `op-${Math.random()}`, agentId: 'agent-1', tool, method: 'call',
    params: {}, timestamp: new Date(), sessionId: 'sess-1',
  };
}

function dec(score: number): ProxyDecision {
  return { action: 'allow', riskScore: score, reasons: [] };
}

/** Inject an event directly at a specific timestamp offset from now. */
async function recordAt(svc: TelemetryService, tool: string, score: number, offsetMs: number) {
  await svc.record(makeOp(tool), dec(score));
  const buf = (svc as unknown as { buffer: Array<{ timestamp: number }> }).buffer;
  buf[buf.length - 1].timestamp = Date.now() - offsetMs;
}

/**
 * Historical baseline: 10 events at low scores with small natural variance.
 * Pattern: alternating 0.08, 0.12 → mean=0.10, stddev=0.02
 */
async function addHistorical(svc: TelemetryService, tool: string, windowMs: number) {
  const scores = [0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12, 0.08, 0.12];
  for (const s of scores) {
    await recordAt(svc, tool, s, windowMs * 0.7); // firmly in historical zone
  }
}

describe('TelemetryService.detectAnomalies', () => {
  it('returns empty when fewer than 5 events', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), dec(0.8));
    await svc.record(makeOp('filesystem'), dec(0.9));
    const alerts = await svc.detectAnomalies();
    expect(alerts).toHaveLength(0);
  });

  it('returns empty when all historical scores are uniform (stddev = 0)', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    for (let i = 0; i < 10; i++) await recordAt(svc, 'filesystem', 0.5, windowMs * 0.7);
    for (let i = 0; i < 3; i++)  await recordAt(svc, 'filesystem', 0.9, windowMs * 0.05);
    const alerts = await svc.detectAnomalies(windowMs, 2.0);
    // stddev = 0 → skipped → no alert
    expect(alerts).toHaveLength(0);
  });

  it('detects a spike when recent avg is high relative to historical mean', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    // Historical: mean=0.10, stddev=0.02
    await addHistorical(svc, 'filesystem', windowMs);
    // Recent spike: avg ≈ 0.90 → z ≈ (0.9-0.1)/0.02 = 40
    for (let i = 0; i < 5; i++) await recordAt(svc, 'filesystem', 0.9, windowMs * 0.05);

    const alerts = await svc.detectAnomalies(windowMs, 2.0);
    expect(alerts.length).toBeGreaterThan(0);
    const a = alerts[0];
    expect(a.tool).toBe('filesystem');
    expect(a.metric).toBe('avg_risk_score');
    expect(a.zScore).toBeGreaterThan(2.0);
    expect(a.threshold).toBe(2.0);
    expect(a.value).toBeCloseTo(0.9, 1);
    expect(a.detectedAt).toBeInstanceOf(Date);
  });

  it('does NOT alert when recent risk is close to historical mean', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    // Historical: mean=0.10, stddev=0.02
    await addHistorical(svc, 'shell', windowMs);
    // Recent: same pattern, no spike
    for (let i = 0; i < 5; i++) await recordAt(svc, 'shell', 0.10, windowMs * 0.05);

    const alerts = await svc.detectAnomalies(windowMs, 2.0);
    expect(alerts.filter(a => a.tool === 'shell')).toHaveLength(0);
  });

  it('only alerts for the spiking tool, not stable tools', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;

    // 'shell' — stable (no spike)
    await addHistorical(svc, 'shell', windowMs);
    for (let i = 0; i < 5; i++) await recordAt(svc, 'shell', 0.10, windowMs * 0.05);

    // 'filesystem' — historical low, recent spike
    await addHistorical(svc, 'filesystem', windowMs);
    for (let i = 0; i < 5; i++) await recordAt(svc, 'filesystem', 0.9, windowMs * 0.05);

    const alerts = await svc.detectAnomalies(windowMs, 2.0);
    const tools = alerts.map(a => a.tool);
    expect(tools).toContain('filesystem');
    expect(tools).not.toContain('shell');
  });

  it('ignores events outside the windowMs', async () => {
    const svc = new TelemetryService();
    const windowMs = 30_000;
    // All events are older than windowMs — excluded from detection
    for (let i = 0; i < 20; i++) await recordAt(svc, 'database', 0.9, windowMs + 10_000);
    const alerts = await svc.detectAnomalies(windowMs, 2.0);
    expect(alerts).toHaveLength(0);
  });

  it('respects custom zScoreThreshold — high threshold suppresses alert', async () => {
    const svc = new TelemetryService();
    const windowMs = 60_000;
    // Historical: mean=0.10, stddev=0.02; recent: 0.15 → z ≈ 2.5
    await addHistorical(svc, 'git', windowMs);
    for (let i = 0; i < 5; i++) await recordAt(svc, 'git', 0.15, windowMs * 0.05);

    // z ≈ (0.15-0.10)/0.02 = 2.5 → fires at threshold 2.0, not at 3.0
    const alertsLow  = await svc.detectAnomalies(windowMs, 2.0);
    const alertsHigh = await svc.detectAnomalies(windowMs, 3.0);
    expect(alertsLow.filter(a => a.tool === 'git').length).toBeGreaterThan(0);
    expect(alertsHigh.filter(a => a.tool === 'git')).toHaveLength(0);
  });
});
