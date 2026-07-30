/**
 * Tests for MCPStdioProxy — the JSON-RPC stdio intercept layer.
 *
 * Uses an in-process mock "MCP server" (a Transform stream that echoes responses)
 * instead of spawning a real child process.
 * We test the proxy by passing JSON-RPC lines directly to handleClientLine.
 */
import { describe, it, expect } from 'vitest';
import { MCPStdioProxy } from '../../src/modules/m1-proxy/stdio.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { Writable, Readable, PassThrough } from 'node:stream';
import type { ProxyDecision } from '../../src/types/interfaces.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Collect all written chunks from a Writable into a string array. */
class LineCollector extends Writable {
  readonly lines: string[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void) {
    String(chunk).split('\n').filter(l => l.trim()).forEach(l => this.lines.push(l));
    cb();
  }
}

/** Build a ready-to-intercept proxy without spawning a real child process. */
function makeTestProxy(opts: {
  mockServerRespond?: (line: string) => string | null;
} = {}) {
  const pipeline = createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(),
  });

  const clientOutput = new LineCollector();
  const childInput   = new LineCollector();

  // We don't spawn a real process — stub the child by bypassing start()
  const proxy = new MCPStdioProxy({
    command: ['echo', 'stub'],
    evaluateRisk: pipeline.evaluateRisk!,
    agentId: 'test-agent',
    sessionId: 'test-session',
    stdout: clientOutput,
    stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
    stdin: new PassThrough(), // not used in these unit tests
  });

  // Expose handleClientLine via accessor for white-box testing
  const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);

  // Stub writeToChild to capture what would go to the child
  (proxy as unknown as { writeToChild(l: string): void }).writeToChild = (line: string) => {
    childInput._write(Buffer.from(line), 'utf-8', () => {});
    // Simulate server echo response for tools/call
    if (opts.mockServerRespond) {
      const response = opts.mockServerRespond(line);
      if (response) clientOutput.write(response + '\n');
    }
  };

  return { proxy, handle, clientOutput, childInput };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCPStdioProxy', () => {

  it('passes non-tools/call requests through to child unchanged', async () => {
    const { handle, childInput, clientOutput } = makeTestProxy();

    const initMsg = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { version: '1.0' } });
    await handle(initMsg);

    expect(childInput.lines).toHaveLength(1);
    expect(JSON.parse(childInput.lines[0]).method).toBe('initialize');
    expect(clientOutput.lines).toHaveLength(0); // no response yet — child would respond
  });

  it('passes through tools/list requests', async () => {
    const { handle, childInput } = makeTestProxy();
    await handle(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }));
    expect(childInput.lines[0]).toContain('tools/list');
  });

  it('allows low-risk tool calls (read_file) and forwards to child', async () => {
    const { handle, childInput } = makeTestProxy();

    const req = { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/tmp/data.txt' } } };
    await handle(JSON.stringify(req));

    expect(childInput.lines).toHaveLength(1);
    const forwarded = JSON.parse(childInput.lines[0]);
    expect(forwarded.method).toBe('tools/call');
    expect(forwarded.params.name).toBe('read_file');
  });

  it('blocks high-risk tool calls (delete_file) and returns JSON-RPC error', async () => {
    const { handle, clientOutput, childInput } = makeTestProxy();

    const req = {
      jsonrpc: '2.0', id: 42,
      method: 'tools/call',
      params: { name: 'delete_file', arguments: { path: '/critical/data.db' } },
    };
    await handle(JSON.stringify(req));

    // Child should NOT have received the request
    expect(childInput.lines).toHaveLength(0);

    // Client should have received a JSON-RPC error
    expect(clientOutput.lines).toHaveLength(1);
    const response = JSON.parse(clientOutput.lines[0]) as { error: { code: number; message: string; data: { riskScore: number } } };
    expect(response.error.code).toBe(-32600);
    expect(response.error.message).toContain('AgentsGate blocked');
    expect(response.error.data.riskScore).toBeGreaterThanOrEqual(0.7);
  });

  it('injects _agentsgate metadata for an approved require_approval tool call', async () => {
    // The call is held until the approver answers; this covers what is
    // forwarded afterwards. The held-and-refused paths are in
    // tests/m1-stdio-approval-gate.test.ts.
    const clientOutput = new LineCollector();
    const childInput   = new LineCollector();
    const proxy = new MCPStdioProxy({
      command: ['echo', 'stub'],
      evaluateRisk: async () => ({
        action: 'require_approval' as const,
        riskScore: 0.55,
        reasons: ['test stub'],
        operationId: 'stub-op',
        timestamp: new Date(),
      }),
      agentId: 'test-agent',
      sessionId: 'test-session',
      awaitApproval: async () => 'approved' as const,
      stdout: clientOutput,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
      stdin: new PassThrough(),
    });
    (proxy as unknown as { writeToChild(l: string): void }).writeToChild = (line: string) => {
      childInput._write(Buffer.from(line), 'utf-8', () => {});
    };
    const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);

    const req = {
      jsonrpc: '2.0', id: 55,
      method: 'tools/call',
      params: { name: 'write_file', arguments: { path: '/app/config.json', content: '{}' } },
    };
    await handle(JSON.stringify(req));

    expect(childInput.lines).toHaveLength(1);
    const forwarded = JSON.parse(childInput.lines[0]);
    expect(forwarded.params._agentsgate).toBeDefined();
    expect(forwarded.params._agentsgate.action).toBe('require_approval');
    expect(forwarded.params._agentsgate.riskScore).toBeGreaterThan(0);
  });

  it('passes through invalid JSON lines unchanged', async () => {
    const { handle, childInput } = makeTestProxy();
    await handle('not json at all');
    expect(childInput.lines[0]).toBe('not json at all');
  });

  it('onIntercept callback is called for tools/call requests', async () => {
    const intercepted: ProxyDecision[] = [];
    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
    });

    const clientOutput = new LineCollector();
    const proxy = new MCPStdioProxy({
      command: ['echo'],
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'cb-agent',
      sessionId: 'cb-session',
      stdout: clientOutput,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
      stdin: new PassThrough(),
      onIntercept: (_op, dec) => intercepted.push(dec),
    });

    (proxy as unknown as { writeToChild(l: string): void }).writeToChild = () => {};
    const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);

    await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'read_file', arguments: {} } }));
    expect(intercepted).toHaveLength(1);
    expect(intercepted[0].action).toBe('allow');
  });
});
