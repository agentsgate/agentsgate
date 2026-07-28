import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { TelemetryService } from '../../src/modules/m13-telemetry/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

function makeOp(tool: string, method = 'write_file'): MCPOperation {
  return {
    id: `op-${Math.random()}`,
    agentId: 'agent-secret-123',       // should NOT appear in stats
    tool,
    method,
    params: { path: '/sensitive/secret.env' },  // should NOT appear in stats
    timestamp: new Date(),
    sessionId: 'session-secret-456',
  };
}

const allowDecision: ProxyDecision = {
  action: 'allow', riskScore: 0.05, reasons: ['Triggered rule: L1_READ_ONLY'],
};
const blockDecision: ProxyDecision = {
  action: 'block', riskScore: 0.92, reasons: ['Triggered rule: L1_DELETE_FILE'],
};

describe('TelemetryService', () => {
  it('should record an operation anonymously (no file paths or agent IDs)', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), allowDecision);

    const stats = await svc.getStats();
    const statsStr = JSON.stringify(stats);

    // PII must not appear
    expect(statsStr).not.toContain('agent-secret-123');
    expect(statsStr).not.toContain('session-secret-456');
    expect(statsStr).not.toContain('/sensitive/secret.env');
    expect(stats.totalEvents).toBe(1);
  });

  it('should aggregate operation counts by tool', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), allowDecision);
    await svc.record(makeOp('filesystem'), allowDecision);
    await svc.record(makeOp('github'), blockDecision);

    const stats = await svc.getStats();
    expect(stats.byTool['filesystem']).toBe(2);
    expect(stats.byTool['github']).toBe(1);
  });

  it('should return stats with risk score distribution', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem', 'read_file'), { action: 'allow', riskScore: 0.05, reasons: [] });
    await svc.record(makeOp('filesystem', 'write_file'), { action: 'require_approval', riskScore: 0.55, reasons: [] });
    await svc.record(makeOp('filesystem', 'delete_file'), { action: 'block', riskScore: 0.9, reasons: [] });

    const stats = await svc.getStats();
    expect(stats.riskHistogram['0.0-0.2']).toBe(1);
    expect(stats.riskHistogram['0.4-0.6']).toBe(1);
    expect(stats.riskHistogram['0.8-1.0']).toBe(1);
    expect(stats.avgRiskScore).toBeCloseTo(0.5, 1);
  });

  it('should flush buffered events to the store', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), allowDecision);
    expect((await svc.getStats()).totalEvents).toBe(1);

    await svc.flush();
    expect((await svc.getStats()).totalEvents).toBe(0);
  });

  it('should not store raw agent IDs or file paths', async () => {
    const svc = new TelemetryService();
    for (let i = 0; i < 5; i++) {
      await svc.record(makeOp('database', 'delete_record'), blockDecision);
    }
    const stats = await svc.getStats();
    expect(stats.totalEvents).toBe(5);
    expect(stats.byAction.block).toBe(5);
    // Confirm the internal buffer is inaccessible from getStats output
    expect(JSON.stringify(stats)).not.toContain('agent-secret');
  });
});

describe('TelemetryService.exportTo', () => {
  let receiver: http.Server;
  let receivedPayload: unknown;
  let receiverPort: number;

  afterEach(() => {
    receiver?.close();
  });

  function startReceiver(): Promise<void> {
    return new Promise(resolve => {
      receiver = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          receivedPayload = JSON.parse(Buffer.concat(chunks).toString()) as unknown;
          res.writeHead(200);
          res.end();
        });
      });
      receiver.listen(0, () => {
        receiverPort = (receiver.address() as { port: number }).port;
        resolve();
      });
    });
  }

  it('should POST anonymized stats to the endpoint and flush the buffer', async () => {
    await startReceiver();
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), allowDecision);
    await svc.record(makeOp('github'), blockDecision);

    const result = await svc.exportTo(`http://127.0.0.1:${receiverPort}/telemetry`);
    expect(result.ok).toBe(true);
    expect(result.statusCode).toBe(200);

    // Buffer flushed after successful export
    expect((await svc.getStats()).totalEvents).toBe(0);

    // Payload contains stats and exportedAt
    const payload = receivedPayload as { stats: { totalEvents: number }; exportedAt: string };
    expect(payload.stats.totalEvents).toBe(2);
    expect(payload.exportedAt).toBeDefined();
  });

  it('should return ok:false when the endpoint is unreachable', async () => {
    const svc = new TelemetryService();
    await svc.record(makeOp('filesystem'), allowDecision);

    const result = await svc.exportTo('http://127.0.0.1:19999/telemetry');
    expect(result.ok).toBe(false);
    expect(result.error).toBeDefined();
    // Buffer should NOT be flushed on failure
    expect((await svc.getStats()).totalEvents).toBe(1);
  });
});
