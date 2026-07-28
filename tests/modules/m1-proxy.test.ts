import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import http from 'node:http';
import { MCPProxy, createPipeline } from '../../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { RiskIntelligenceEngine } from '../../src/modules/m11-intelligence/index.js';
import type { MCPOperation, ProxyDecision, ExecutionResult } from '../../src/types/interfaces.js';

// Test port — use an ephemeral port (0) so the OS assigns one
const TEST_PORT = 0;

function makeOperation(id = 'op-1'): MCPOperation {
  return {
    id,
    agentId: 'agent-test',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/tmp/x.txt', content: 'hi' },
    timestamp: new Date(),
    sessionId: 'session-test',
  };
}

/** POST an MCPOperation to the proxy HTTP server and return the parsed decision. */
async function postOperation(port: number, op: MCPOperation): Promise<ProxyDecision> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(op);
    const req = http.request(
      { host: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve(JSON.parse(Buffer.concat(chunks).toString()) as ProxyDecision));
        res.on('error', reject);
      }
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('MCPProxy', () => {
  let proxy: MCPProxy;
  let port: number;

  afterEach(async () => {
    await proxy?.stop();
  });

  it('should start and listen on the given port', async () => {
    proxy = new MCPProxy();
    await proxy.start(TEST_PORT);
    // Retrieve the actual bound port
    const address = (proxy as unknown as { server: http.Server }).server?.address();
    expect(address).not.toBeNull();
    port = (address as { port: number }).port;
    expect(port).toBeGreaterThan(0);
  });

  it('should intercept an incoming MCP operation', async () => {
    proxy = new MCPProxy();
    await proxy.start(TEST_PORT);
    port = ((proxy as unknown as { server: http.Server }).server.address() as { port: number }).port;

    const decision = await postOperation(port, makeOperation());
    expect(decision.action).toBe('allow');
    expect(decision.riskScore).toBe(0);
    expect(decision.reasons).toContain('pass-through: no risk rules configured');
  });

  it('should forward allowed operations to the actual MCP tool', async () => {
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>()
      .mockResolvedValue({ success: true, durationMs: 5 });

    proxy = new MCPProxy({ forwardToTool });
    const decision = await proxy.intercept(makeOperation());

    expect(decision.action).toBe('allow');
    expect(forwardToTool).toHaveBeenCalledOnce();
    expect(forwardToTool.mock.calls[0][0].id).toBe('op-1');
  });

  it('should block operations when decision is "block"', async () => {
    const forwardToTool = vi.fn<[MCPOperation], Promise<ExecutionResult>>()
      .mockResolvedValue({ success: true, durationMs: 0 });

    const evaluateRisk = vi.fn<[MCPOperation], Promise<ProxyDecision>>()
      .mockResolvedValue({ action: 'block', riskScore: 0.95, reasons: ['destructive operation'] });

    proxy = new MCPProxy({ evaluateRisk, forwardToTool });
    const decision = await proxy.intercept(makeOperation());

    expect(decision.action).toBe('block');
    expect(forwardToTool).not.toHaveBeenCalled();
  });

  it('should stop cleanly', async () => {
    proxy = new MCPProxy();
    await proxy.start(TEST_PORT);
    await expect(proxy.stop()).resolves.toBeUndefined();
    // Stopping again should not throw
    await expect(proxy.stop()).resolves.toBeUndefined();
  });
});

describe('createPipeline (M6 + M7 wired into M1)', () => {
  it('should block delete_file operations via the full risk pipeline', async () => {
    const riskEngine = new RiskScoringEngine();
    const interventionController = new InterventionController();

    const proxy = new MCPProxy(createPipeline({ riskEngine, interventionController }));

    const deleteOp: MCPOperation = {
      id: 'op-del',
      agentId: 'agent-1',
      tool: 'filesystem',
      method: 'delete_file',
      params: { path: '/important/file.txt' },
      timestamp: new Date(),
      sessionId: 'session-1',
    };

    const decision = await proxy.intercept(deleteOp);
    expect(decision.action).toBe('block');
    expect(decision.riskScore).toBeGreaterThanOrEqual(0.7);
    expect(decision.reasons.some(r => r.includes('L1_DELETE_FILE'))).toBe(true);
  });

  it('should allow read_file operations via the full risk pipeline', async () => {
    const riskEngine = new RiskScoringEngine();
    const interventionController = new InterventionController();
    const proxy = new MCPProxy(createPipeline({ riskEngine, interventionController }));

    const readOp: MCPOperation = {
      id: 'op-read',
      agentId: 'agent-1',
      tool: 'filesystem',
      method: 'read_file',
      params: { path: '/tmp/notes.txt' },
      timestamp: new Date(),
      sessionId: 'session-1',
    };

    const decision = await proxy.intercept(readOp);
    expect(decision.action).toBe('allow');
    expect(decision.riskScore).toBeLessThan(0.3);
  });

  it('should blend L2 score when intelligenceEngine has enough history', async () => {
    const riskEngine = new RiskScoringEngine();
    const interventionController = new InterventionController();
    const intelligenceEngine = new RiskIntelligenceEngine();

    // Record 10 outcomes — all approved → user history score = 1 - 10/10 = 0.0
    for (let i = 0; i < 10; i++) {
      await intelligenceEngine.recordOutcome(`op-${i}`, true, 'trusted-agent', 'filesystem');
    }

    const proxy = new MCPProxy(createPipeline({ riskEngine, interventionController, intelligenceEngine }));

    // write_file normally scores 0.65 (L1_OVERWRITE_FILE) → require_approval
    // with L2=0.0: finalScore = 0.6*0.65 + 0.4*0.0 = 0.39 → still require_approval but lower
    const writeOp: MCPOperation = {
      id: 'op-write-l2',
      agentId: 'trusted-agent',
      tool: 'filesystem',
      method: 'write_file',
      params: { path: '/tmp/output.txt', content: 'data' },
      timestamp: new Date(),
      sessionId: 'session-l2',
    };

    const decision = await proxy.intercept(writeOp);
    // Score should be blended: 0.6*0.65 + 0.4*0.0 = 0.39 — below block threshold (0.7)
    expect(decision.action).not.toBe('block');
    expect(decision.riskScore).toBeCloseTo(0.39, 1);
  });
});
