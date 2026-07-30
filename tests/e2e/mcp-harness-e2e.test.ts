/**
 * E2E tests for MCPStdioProxy using the full MCP client harness.
 *
 * Every test exercises the complete wire path:
 *
 *   McpClientHarness (JSON-RPC 2.0 NDJSON client)
 *     │  in-memory PassThrough streams
 *     ▼
 *   MCPStdioProxy (production proxy, real evaluateRisk pipeline)
 *     │  spawned child process + real stdin/stdout pipes
 *     ▼
 *   fake-mcp-server.mjs (downstream MCP server, real Node.js process)
 *
 * No private methods are accessed; every assertion goes through the public
 * transport API (request / callTool / listTools / notify / intercepts).
 */
import { describe, it, expect, afterEach } from 'vitest';
import { McpClientHarness, McpToolError } from '../helpers/mcp-client-harness.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

// ── Risk evaluator helpers ────────────────────────────────────────────────────

const allowAll = async (): Promise<ProxyDecision> => ({
  action: 'allow', riskScore: 0.0, reasons: ['test-allow-all'],
});

const blockAll = async (): Promise<ProxyDecision> => ({
  action: 'block', riskScore: 1.0, reasons: ['test-block-all'],
});

/** Stands in for a human saying yes; without one the proxy holds the call. */
const approve = async (): Promise<'approved'> => 'approved';

const requireApprovalAll = async (): Promise<ProxyDecision> => ({
  action: 'require_approval', riskScore: 0.75, reasons: ['test-require-approval'],
});

const allowWithScore = (score: number) => async (): Promise<ProxyDecision> => ({
  action: 'allow', riskScore: score, reasons: [`test-allow-score-${score}`],
});

/** Block only the tool whose name matches `method`. */
const blockTool = (toolName: string) => async (op: MCPOperation): Promise<ProxyDecision> =>
  op.method === toolName
    ? { action: 'block', riskScore: 0.95, reasons: [`blocked-by-test: ${toolName}`] }
    : { action: 'allow', riskScore: 0.05, reasons: ['pass'] };

// ── Shared harness instance (created/torn-down per test) ──────────────────────

let h: McpClientHarness;

afterEach(async () => {
  await h?.stop();
});

// ── 1. Transport layer — handshake and protocol pass-through ─────────────────

describe('MCP transport layer', () => {

  it('start() completes MCP initialize handshake without error', async () => {
    h = new McpClientHarness();
    // start() internally sends initialize, awaits the response, then sends
    // notifications/initialized.  If the handshake fails it throws.
    await h.start({ evaluateRisk: allowAll });
    // initialize is not a tools/call so the proxy does not intercept it.
    expect(h.intercepts).toHaveLength(0);
  });

  it('tools/list passes through transparently — no intercept recorded', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const tools = await h.listTools();
    expect(Array.isArray(tools)).toBe(true);
    expect(h.intercepts).toHaveLength(0); // tools/list is not a tools/call
  });

  it('tools/list returns expected tool names from fake server', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const tools = await h.listTools() as Array<{ name: string }>;
    const names = tools.map(t => t.name);
    expect(names).toContain('echo');
    expect(names).toContain('fail');
    expect(names).toContain('slow');
    expect(names).toContain('inspect_request');
  });

  it('unknown method returns JSON-RPC error from downstream server', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const resp = await h.request('resources/list');
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32601);
  });

});

// ── 2. Allow path ─────────────────────────────────────────────────────────────

describe('MCPStdioProxy — allow decision', () => {

  it('forwards allowed tool call and relays server response to client', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const result = await h.callTool('echo', { message: 'hello world' });
    const text = (result as { content: Array<{ type: string; text: string }> }).content[0]?.text;
    expect(text).toBe('hello world');
  });

  it('records one intercept with correct method and allow action', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'test' });
    expect(h.intercepts).toHaveLength(1);
    expect(h.lastIntercept?.operation.method).toBe('echo');
    expect(h.lastIntercept?.decision.action).toBe('allow');
    expect(h.lastIntercept?.decision.riskScore).toBe(0.0);
  });

  it('attaches caller-supplied agentId and sessionId to the intercepted operation', async () => {
    h = new McpClientHarness();
    await h.start({
      evaluateRisk: allowAll,
      agentId: 'my-agent-id',
      sessionId: 'my-session-42',
    });
    await h.callTool('echo', { message: 'x' });
    expect(h.lastIntercept?.operation.agentId).toBe('my-agent-id');
    expect(h.lastIntercept?.operation.sessionId).toBe('my-session-42');
  });

  it('injects _agentsgate metadata into forwarded request when riskScore > 0', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowWithScore(0.42) });
    // inspect_request echoes the raw tools/call params — including proxy injections.
    const result = await h.callTool('inspect_request', {});
    const params = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    const shield = params['_agentsgate'] as { riskScore: number; action: string } | undefined;
    expect(shield).toBeDefined();
    expect(shield?.riskScore).toBeCloseTo(0.42, 5);
    expect(shield?.action).toBe('allow');
  });

  it('does NOT inject _agentsgate when riskScore is exactly 0', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll }); // riskScore = 0.0
    const result = await h.callTool('inspect_request', {});
    const params = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    expect(params['_agentsgate']).toBeUndefined();
  });

  it('intercept operation.params matches the arguments passed by the client', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'param-check', extra: 123 });
    const params = h.lastIntercept?.operation.params;
    expect(params?.['message']).toBe('param-check');
    expect(params?.['extra']).toBe(123);
  });

});

// ── 3. Block path ─────────────────────────────────────────────────────────────

describe('MCPStdioProxy — block decision', () => {

  it('returns JSON-RPC error to client when tool call is blocked', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'hi' } });
    expect(resp.error).toBeDefined();
    expect(resp.error?.code).toBe(-32600);
    expect(resp.error?.message).toContain('AgentsGate blocked');
  });

  it('error response carries riskScore and reasons in the data field', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'hi' } });
    const data = resp.error?.data as { riskScore: number; reasons: string[] };
    expect(data.riskScore).toBe(1.0);
    expect(data.reasons).toContain('test-block-all');
  });

  it('blocked request has no result field and does not reach downstream server', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    const resp = await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(resp.result).toBeUndefined(); // server was never called
    expect(resp.error).toBeDefined();
  });

  it('callTool() throws McpToolError when the proxy blocks', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    await expect(h.callTool('echo', { message: 'x' })).rejects.toBeInstanceOf(McpToolError);
  });

  it('selective block: blocks one tool while allowing others', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockTool('fail') });

    // 'echo' should be allowed and reach the server.
    const ok = await h.callTool('echo', { message: 'allowed' });
    expect((ok as { content: Array<{ text: string }> }).content[0]?.text).toBe('allowed');

    // 'fail' should be blocked by the proxy (AgentsGate error, not server error).
    const resp = await h.request('tools/call', { name: 'fail', arguments: {} });
    expect(resp.error?.message).toContain('AgentsGate blocked');
    expect(resp.error?.message).not.toContain('Tool execution failed'); // server wasn't called
  });

  it('block decision is still recorded as an intercept', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(h.intercepts).toHaveLength(1);
    expect(h.lastIntercept?.decision.action).toBe('block');
  });

});

// ── 4. require_approval path ──────────────────────────────────────────────────

describe('MCPStdioProxy — require_approval decision', () => {

  it('forwards require_approval call to downstream server and relays response', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalAll, awaitApproval: approve });
    const result = await h.callTool('echo', { message: 'approve-me' });
    // Held until the approver answers, then forwarded and relayed as normal.
    expect((result as { content: Array<{ text: string }> }).content[0]?.text).toBe('approve-me');
  });

  it('refuses the call when no approver is configured', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalAll });
    await expect(h.callTool('echo', { message: 'never-runs' })).rejects.toThrow(/approval/i);
  });

  it('refuses the call when the approver denies it', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalAll, awaitApproval: async () => 'denied' });
    await expect(h.callTool('echo', { message: 'never-runs' })).rejects.toThrow(/denied/i);
  });

  it('records require_approval in intercepts with correct action and risk score', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalAll, awaitApproval: approve });
    await h.callTool('echo', { message: 'x' });
    expect(h.lastIntercept?.decision.action).toBe('require_approval');
    expect(h.lastIntercept?.decision.riskScore).toBe(0.75);
  });

});

// ── 5. Downstream server error relay ─────────────────────────────────────────

describe('MCPStdioProxy — downstream server errors', () => {

  it('relays a server-side JSON-RPC error back to the client unchanged', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const resp = await h.request('tools/call', { name: 'fail', arguments: {} });
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toBe('Tool execution failed');
    expect((resp.error?.data as { reason?: string })?.reason).toBe('intentional');
  });

  it('callTool() throws McpToolError on server-side tool error', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const err = await h.callTool('fail').catch(e => e);
    expect(err).toBeInstanceOf(McpToolError);
    expect((err as McpToolError).code).toBe(-32000);
    expect((err as McpToolError).data).toMatchObject({ reason: 'intentional' });
  });

});

// ── 6. Concurrent requests ────────────────────────────────────────────────────

describe('MCPStdioProxy — concurrent requests', () => {

  it('routes concurrent tool call responses to the correct callers', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });

    const [r1, r2, r3] = await Promise.all([
      h.callTool('echo', { message: 'first' }),
      h.callTool('echo', { message: 'second' }),
      h.callTool('echo', { message: 'third' }),
    ]);

    const text = (r: unknown) =>
      (r as { content: Array<{ text: string }> }).content[0]!.text;

    expect(text(r1)).toBe('first');
    expect(text(r2)).toBe('second');
    expect(text(r3)).toBe('third');
    expect(h.intercepts).toHaveLength(3);
  });

  it('handles mix of allowed, blocked, and server-error calls concurrently', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockTool('slow') });

    const [echoResult, blockResp, failResp] = await Promise.all([
      h.callTool('echo', { message: 'concurrent-echo' }),
      h.request('tools/call', { name: 'slow', arguments: { delay: 10 } }),
      h.request('tools/call', { name: 'fail', arguments: {} }),
    ]);

    const echoText = (echoResult as { content: Array<{ text: string }> }).content[0]!.text;
    expect(echoText).toBe('concurrent-echo');
    expect(blockResp.error?.message).toContain('AgentsGate blocked'); // slow was blocked
    expect(failResp.error?.code).toBe(-32000);                          // fail reached server
  });

});

// ── 7. Full M6 + M7 pipeline ──────────────────────────────────────────────────

describe('MCPStdioProxy — full risk pipeline (M6 + M7)', () => {

  it('blocks delete_file via L1 rules and allows low-risk calls', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: pipeline.evaluateRisk! });

    // delete_file hits L1 high-risk rules → should be blocked.
    const blocked = await h.request('tools/call', {
      name: 'delete_file',
      arguments: { path: '/critical/config' },
    });
    expect(blocked.error?.message).toContain('AgentsGate blocked');

    // echo is unknown to L1 rules → low score → allowed.
    const allowed = await h.callTool('echo', { message: 'pipeline-ok' });
    expect((allowed as { content: Array<{ text: string }> }).content[0]?.text)
      .toBe('pipeline-ok');
  });

  it('records riskScore from M6 pipeline in the intercepted decision', async () => {
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });
    h = new McpClientHarness();
    await h.start({
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'pipeline-agent',
    });

    await h.request('tools/call', {
      name: 'delete_file',
      arguments: { path: '/tmp/test' },
    });

    const blocked = h.intercepts.find(r => r.decision.action === 'block');
    expect(blocked).toBeDefined();
    expect(blocked!.decision.riskScore).toBeGreaterThan(0);
    expect(blocked!.operation.agentId).toBe('pipeline-agent');
  });

});

// ── 8. Intercept accumulation across sequential calls ─────────────────────────

describe('McpClientHarness — intercept accumulation', () => {

  it('after N sequential callTool calls, intercepts.length === N', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const N = 4;
    for (let i = 0; i < N; i++) {
      await h.callTool('echo', { message: `msg-${i}` });
    }
    expect(h.intercepts).toHaveLength(N);
  });

  it('lastIntercept reflects the most recent call after each sequential call', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'first' });
    expect(h.lastIntercept?.operation.method).toBe('echo');
    await h.callTool('inspect_request', {});
    expect(h.lastIntercept?.operation.method).toBe('inspect_request');
  });

  it('intercepts are recorded in call order', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'first' });
    await h.callTool('inspect_request', {});
    expect(h.intercepts[0]?.operation.method).toBe('echo');
    expect(h.intercepts[1]?.operation.method).toBe('inspect_request');
  });

  it('intercepts array grows (not reset) across sequential calls', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'a' });
    expect(h.intercepts).toHaveLength(1);
    await h.callTool('echo', { message: 'b' });
    expect(h.intercepts).toHaveLength(2);
    await h.callTool('echo', { message: 'c' });
    expect(h.intercepts).toHaveLength(3);
  });

});

// ── 9. notify() one-way messages ──────────────────────────────────────────────

describe('McpClientHarness — notify() one-way messages', () => {

  it('notify() does not throw and does not block', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    expect(() => h.notify('custom/event', { x: 1 })).not.toThrow();
  });

  it('after notify() the harness can still send a normal request and get a response', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    h.notify('custom/event', { x: 1 });
    const result = await h.callTool('echo', { message: 'post-notify' });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toBe('post-notify');
  });

  it('intercepts count is unchanged after a bare notify', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'before' });
    const countBefore = h.intercepts.length;
    h.notify('custom/event', { x: 1 });
    // Give the proxy a moment to process the notification (if it does anything).
    await new Promise(r => setTimeout(r, 20));
    expect(h.intercepts.length).toBe(countBefore);
  });

});

// ── 10. require_approval _agentsgate injection ───────────────────────────────

describe('MCPStdioProxy — require_approval _agentsgate injection', () => {

  const requireApprovalWithScore = (score: number) => async (): Promise<ProxyDecision> => ({
    action: 'require_approval', riskScore: score, reasons: [`test-require-approval-${score}`],
  });

  it('when evaluateRisk returns require_approval with riskScore > 0, _agentsgate.action === require_approval', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalWithScore(0.55), awaitApproval: approve });
    const result = await h.callTool('inspect_request', {});
    const params = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    const shield = params['_agentsgate'] as { riskScore: number; action: string } | undefined;
    expect(shield).toBeDefined();
    expect(shield?.action).toBe('require_approval');
  });

  it('_agentsgate.riskScore matches the value returned by evaluateRisk', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalWithScore(0.55), awaitApproval: approve });
    const result = await h.callTool('inspect_request', {});
    const params = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    const shield = params['_agentsgate'] as { riskScore: number; action: string } | undefined;
    expect(shield?.riskScore).toBeCloseTo(0.55, 5);
  });

  it('when evaluateRisk returns require_approval with riskScore === 0, _agentsgate is NOT injected', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalWithScore(0), awaitApproval: approve });
    const result = await h.callTool('inspect_request', {});
    const params = JSON.parse(
      (result as { content: Array<{ text: string }> }).content[0]!.text,
    ) as Record<string, unknown>;
    expect(params['_agentsgate']).toBeUndefined();
  });

});

// ── 11. Slow tool behavior ────────────────────────────────────────────────────

describe('MCPStdioProxy — slow tool (delayed server response)', () => {

  it('calling slow with delay: 50 via allowAll returns "slow response" correctly', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const result = await h.callTool('slow', { delay: 50 });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toBe('slow response');
  });

  it('slow call and echo call sent concurrently both resolve with correct results', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const [slowResult, echoResult] = await Promise.all([
      h.callTool('slow', { delay: 50 }),
      h.callTool('echo', { message: 'concurrent-with-slow' }),
    ]);
    const slowText = (slowResult as { content: Array<{ text: string }> }).content[0]?.text;
    const echoText = (echoResult as { content: Array<{ text: string }> }).content[0]?.text;
    expect(slowText).toBe('slow response');
    expect(echoText).toBe('concurrent-with-slow');
  });

  it('the intercept for slow has action: allow and is recorded after the response', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('slow', { delay: 50 });
    expect(h.lastIntercept?.operation.method).toBe('slow');
    expect(h.lastIntercept?.decision.action).toBe('allow');
  });

});

// ── 12. tools/list idempotency ────────────────────────────────────────────────

describe('McpClientHarness — tools/list idempotency', () => {

  it('calling listTools() twice returns the same set of tool names both times', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const tools1 = (await h.listTools()) as Array<{ name: string }>;
    const tools2 = (await h.listTools()) as Array<{ name: string }>;
    const names1 = tools1.map(t => t.name).sort();
    const names2 = tools2.map(t => t.name).sort();
    expect(names1).toEqual(names2);
  });

  it('intercepts count does not increase after listTools() calls', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.listTools();
    await h.listTools();
    expect(h.intercepts).toHaveLength(0);
  });

});

// ── 13. callTool argument edge cases ─────────────────────────────────────────

describe('McpClientHarness — callTool argument edge cases', () => {

  it('callTool("echo") with no second argument responds with empty string', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const result = await h.callTool('echo');
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toBe('');
  });

  it('callTool("inspect_request") with no args records operation.params as empty object', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('inspect_request');
    const params = h.lastIntercept?.operation.params;
    expect(params).toEqual({});
  });

  it('callTool("echo", { message: "" }) returns empty string without error', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const result = await h.callTool('echo', { message: '' });
    const text = (result as { content: Array<{ text: string }> }).content[0]?.text;
    expect(text).toBe('');
  });

});

// ── 14. pendingProxyCallCount() reflects in-flight calls ─────────────────────

describe('McpClientHarness — pendingProxyCallCount()', () => {

  it('before any call, pendingProxyCallCount() is 0', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    expect(h.pendingProxyCallCount()).toBe(0);
  });

  it('while a slow call is in-flight, pendingProxyCallCount() is >= 1', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    const slowPromise = h.request('tools/call', { name: 'slow', arguments: { delay: 200 } });
    await new Promise(r => setTimeout(r, 20)); // let proxy forward the request
    expect(h.pendingProxyCallCount()).toBeGreaterThanOrEqual(1);
    await slowPromise;
    expect(h.pendingProxyCallCount()).toBe(0);
  });

  it('after the slow call resolves, pendingProxyCallCount() returns to 0', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('slow', { delay: 50 });
    expect(h.pendingProxyCallCount()).toBe(0);
  });

});

// ── 15. Decision reasons array ────────────────────────────────────────────────

describe('MCPStdioProxy — decision reasons array', () => {

  it('blockAll evaluator: lastIntercept.decision.reasons contains "test-block-all"', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: blockAll });
    await h.request('tools/call', { name: 'echo', arguments: { message: 'x' } });
    expect(h.lastIntercept?.decision.reasons).toContain('test-block-all');
  });

  it('allowAll evaluator: lastIntercept.decision.reasons contains "test-allow-all"', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: allowAll });
    await h.callTool('echo', { message: 'x' });
    expect(h.lastIntercept?.decision.reasons).toContain('test-allow-all');
  });

  it('requireApprovalAll evaluator: lastIntercept.decision.reasons contains "test-require-approval"', async () => {
    h = new McpClientHarness();
    await h.start({ evaluateRisk: requireApprovalAll, awaitApproval: approve });
    await h.callTool('echo', { message: 'x' });
    expect(h.lastIntercept?.decision.reasons).toContain('test-require-approval');
  });

  it('custom evaluator returning empty reasons []: lastIntercept.decision.reasons is []', async () => {
    const emptyReasons = async (): Promise<ProxyDecision> => ({
      action: 'allow', riskScore: 0.0, reasons: [],
    });
    h = new McpClientHarness();
    await h.start({ evaluateRisk: emptyReasons });
    await h.callTool('echo', { message: 'x' });
    expect(h.lastIntercept?.decision.reasons).toEqual([]);
  });

});
