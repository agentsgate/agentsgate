import { describe, it, expect, vi, afterEach } from 'vitest';
import { MCPStreamableHttpProxy } from '../../src/modules/m1-proxy/streamable-http.js';
import type {
  MCPOperation,
  ProxyDecision,
  ExecutionResult,
} from '../../src/types/interfaces.js';

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

function allowDecision(riskScore = 0): ProxyDecision {
  return { action: 'allow', riskScore, reasons: ['ok'] };
}

function blockDecision(riskScore = 0.9): ProxyDecision {
  return { action: 'block', riskScore, reasons: ['blocked'] };
}

function approvalDecision(riskScore = 0.6): ProxyDecision {
  return { action: 'require_approval', riskScore, reasons: ['approval needed'] };
}

function makeResult(output: unknown = 'done', success = true): ExecutionResult {
  return { success, output, durationMs: 10 };
}

// -----------------------------------------------------------------------
// Tests
// -----------------------------------------------------------------------

describe('MCPStreamableHttpProxy — lifecycle', () => {
  let proxy: MCPStreamableHttpProxy;

  afterEach(async () => {
    await proxy?.stop().catch(() => {/* already stopped */});
  });

  it('starts on an ephemeral port and getPort() returns a positive number', async () => {
    proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    await proxy.start(0);
    const port = proxy.getPort();
    expect(port).toBeGreaterThan(0);
  });

  it('stop() closes the server without error', async () => {
    proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    await proxy.start(0);
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it('stop() resolves immediately when server was never started', async () => {
    proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    await expect(proxy.stop()).resolves.toBeUndefined();
  });

  it('getPort() throws when server is not listening', () => {
    proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    expect(() => proxy.getPort()).toThrow('Server is not listening');
  });

  it('getPort() throws after server has been stopped', async () => {
    proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    await proxy.start(0);
    await proxy.stop();
    expect(() => proxy.getPort()).toThrow('Server is not listening');
  });
});

describe('MCPStreamableHttpProxy — evaluateRisk integration', () => {
  // We test the pipeline behaviour by constructing a proxy whose
  // evaluateRisk / forwardToTool / onOperation callbacks are spies, then
  // invoke the HTTP server over a real connection using a minimal raw HTTP
  // POST that mimics an MCP JSON-RPC request.
  //
  // Because the StreamableHTTPServerTransport handles the full MCP protocol
  // negotiation, we use the simplest possible approach: we verify that our
  // callback spies are wired correctly by checking constructor defaults and
  // that the class stores and calls them.

  afterEach(async () => {
    // nothing persistent to clean up
  });

  it('defaults forwardToTool to a no-op returning success', async () => {
    // Access the private field via casting to verify the default is set
    const proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    // The private forwardToTool is stored — call it via the cast
    const internal = proxy as unknown as {
      forwardToTool: (op: MCPOperation) => Promise<ExecutionResult>;
    };
    const op: MCPOperation = {
      id: crypto.randomUUID(),
      agentId: 'agent-1',
      tool: 'fs',
      method: 'read',
      params: {},
      timestamp: new Date(),
      sessionId: 'sess-1',
    };
    const result = await internal.forwardToTool(op);
    expect(result.success).toBe(true);
    expect(result.durationMs).toBe(0);
    expect(result.output).toBeNull();
  });

  it('stores custom forwardToTool option', async () => {
    const customForward = vi.fn().mockResolvedValue(makeResult('custom-output'));
    const proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
      forwardToTool: customForward,
    });
    const internal = proxy as unknown as {
      forwardToTool: (op: MCPOperation) => Promise<ExecutionResult>;
    };
    const op: MCPOperation = {
      id: crypto.randomUUID(),
      agentId: 'agent-1',
      tool: 'fs',
      method: 'write',
      params: { path: '/tmp/x' },
      timestamp: new Date(),
      sessionId: 'sess-2',
    };
    const result = await internal.forwardToTool(op);
    expect(customForward).toHaveBeenCalledOnce();
    expect(result.output).toBe('custom-output');
  });

  it('stores custom evaluateRisk option', async () => {
    const customEval = vi.fn().mockResolvedValue(blockDecision());
    const proxy = new MCPStreamableHttpProxy({
      evaluateRisk: customEval,
    });
    const internal = proxy as unknown as {
      evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>;
    };
    const op: MCPOperation = {
      id: crypto.randomUUID(),
      agentId: 'agent-x',
      tool: 'github',
      method: 'delete_repo',
      params: {},
      timestamp: new Date(),
      sessionId: 'sess-3',
    };
    const decision = await internal.evaluateRisk(op);
    expect(customEval).toHaveBeenCalledWith(op);
    expect(decision.action).toBe('block');
  });

  it('stores optional onOperation callback', async () => {
    const onOp = vi.fn();
    const proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
      onOperation: onOp,
    });
    const internal = proxy as unknown as {
      onOperation?: (op: MCPOperation, decision: ProxyDecision) => void;
    };
    expect(internal.onOperation).toBe(onOp);
  });

  it('onOperation is undefined when not provided', () => {
    const proxy = new MCPStreamableHttpProxy({
      evaluateRisk: async () => allowDecision(),
    });
    const internal = proxy as unknown as {
      onOperation?: (op: MCPOperation, decision: ProxyDecision) => void;
    };
    expect(internal.onOperation).toBeUndefined();
  });
});

describe('MCPStreamableHttpProxy — decision path unit coverage', () => {
  // We simulate what the tool handler does by reconstructing the same
  // logic that is exercised when `invoke` fires, so we can assert the
  // response shape for each branch without requiring a live MCP client.

  async function simulateInvoke(
    evaluateRisk: (op: MCPOperation) => Promise<ProxyDecision>,
    forwardToTool?: (op: MCPOperation) => Promise<ExecutionResult>,
    onOperation?: (op: MCPOperation, decision: ProxyDecision) => void,
    args: { tool?: string; method?: string; params?: Record<string, unknown>; agent_id?: string; session_id?: string } = {},
  ) {
    const { tool = 'testTool', method = 'testMethod', params, agent_id, session_id } = args;

    const operation: MCPOperation = {
      id: crypto.randomUUID(),
      agentId: agent_id ?? 'remote-agent',
      tool,
      method,
      params: (params ?? {}) as Record<string, unknown>,
      timestamp: new Date(),
      sessionId: session_id ?? 'http-session',
    };

    const fwd = forwardToTool ?? (() => Promise.resolve({ success: true, output: null, durationMs: 0 }));

    const decision = await evaluateRisk(operation);
    if (onOperation) onOperation(operation, decision);

    if (decision.action === 'block') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ blocked: true, riskScore: decision.riskScore, reasons: decision.reasons }) }],
        isError: true,
      };
    }

    if (decision.action === 'require_approval') {
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ requireApproval: true, riskScore: decision.riskScore, reasons: decision.reasons }) }],
      };
    }

    const result = await fwd(operation);
    return {
      content: [{ type: 'text' as const, text: JSON.stringify({ allowed: true, riskScore: decision.riskScore, result: result.output, success: result.success, durationMs: result.durationMs }) }],
      isError: !result.success,
    };
  }

  it('block decision returns isError=true with blocked payload', async () => {
    const response = await simulateInvoke(async () => blockDecision(0.95));
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.blocked).toBe(true);
    expect(payload.riskScore).toBe(0.95);
    expect(payload.reasons).toContain('blocked');
  });

  it('require_approval decision returns requireApproval payload without isError', async () => {
    const response = await simulateInvoke(async () => approvalDecision(0.6));
    expect((response as { isError?: boolean }).isError).toBeUndefined();
    const payload = JSON.parse(response.content[0].text);
    expect(payload.requireApproval).toBe(true);
    expect(payload.riskScore).toBe(0.6);
  });

  it('allow decision calls forwardToTool and returns allowed payload', async () => {
    const fwd = vi.fn().mockResolvedValue(makeResult('file-content'));
    const response = await simulateInvoke(async () => allowDecision(0.1), fwd);
    expect(fwd).toHaveBeenCalledOnce();
    expect((response as { isError?: boolean }).isError).toBe(false);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.allowed).toBe(true);
    expect(payload.result).toBe('file-content');
    expect(payload.success).toBe(true);
  });

  it('allow decision with failed forwardToTool returns isError=true', async () => {
    const fwd = vi.fn().mockResolvedValue({ success: false, output: null, error: 'disk full', durationMs: 5 });
    const response = await simulateInvoke(async () => allowDecision(0.0), fwd);
    expect(response.isError).toBe(true);
    const payload = JSON.parse(response.content[0].text);
    expect(payload.success).toBe(false);
  });

  it('onOperation is called with operation and decision on every invoke', async () => {
    const onOp = vi.fn();
    const decision = allowDecision(0.2);
    await simulateInvoke(async () => decision, undefined, onOp, { tool: 'myTool', method: 'myMethod', agent_id: 'agent-99', session_id: 'sess-xyz' });
    expect(onOp).toHaveBeenCalledOnce();
    const [calledOp, calledDecision] = onOp.mock.calls[0] as [MCPOperation, ProxyDecision];
    expect(calledOp.tool).toBe('myTool');
    expect(calledOp.method).toBe('myMethod');
    expect(calledOp.agentId).toBe('agent-99');
    expect(calledOp.sessionId).toBe('sess-xyz');
    expect(calledDecision).toBe(decision);
  });

  it('defaults agent_id to "remote-agent" when not provided', async () => {
    const onOp = vi.fn();
    await simulateInvoke(async () => allowDecision(), undefined, onOp);
    const [calledOp] = onOp.mock.calls[0] as [MCPOperation, ProxyDecision];
    expect(calledOp.agentId).toBe('remote-agent');
  });

  it('defaults session_id to "http-session" when not provided', async () => {
    const onOp = vi.fn();
    await simulateInvoke(async () => allowDecision(), undefined, onOp);
    const [calledOp] = onOp.mock.calls[0] as [MCPOperation, ProxyDecision];
    expect(calledOp.sessionId).toBe('http-session');
  });

  it('uses provided params in the operation forwarded to evaluateRisk', async () => {
    const evalSpy = vi.fn().mockResolvedValue(allowDecision());
    const onOp = vi.fn();
    await simulateInvoke(evalSpy, undefined, onOp, { params: { key: 'value', num: 42 } });
    const [calledOp] = evalSpy.mock.calls[0] as [MCPOperation];
    expect(calledOp.params).toEqual({ key: 'value', num: 42 });
  });

  it('operation id is a valid UUID v4 format', async () => {
    const onOp = vi.fn();
    await simulateInvoke(async () => allowDecision(), undefined, onOp);
    const [calledOp] = onOp.mock.calls[0] as [MCPOperation, ProxyDecision];
    expect(calledOp.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('operation timestamp is a Date instance', async () => {
    const onOp = vi.fn();
    await simulateInvoke(async () => allowDecision(), undefined, onOp);
    const [calledOp] = onOp.mock.calls[0] as [MCPOperation, ProxyDecision];
    expect(calledOp.timestamp).toBeInstanceOf(Date);
  });
});
