/**
 * T101 — MCPStdioProxy e2e smoke test.
 *
 * Spawns a real child process ("echo MCP server" stub) via Node.js and
 * verifies that MCPStdioProxy correctly:
 *  - passes non-tools/call messages through to the child and relays responses
 *  - blocks high-risk tools/call and returns a JSON-RPC error
 *  - allows low-risk tools/call and forwards to the child
 *
 * The "MCP server" stub is a tiny Node.js one-liner that echoes each
 * line it receives back with a result wrapper, so we can see round-trip
 * message flow without needing a real MCP SDK server.
 */
import { describe, it, expect } from 'vitest';
import { MCPStdioProxy } from '../../src/modules/m1-proxy/stdio.js';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import { InterventionController } from '../../src/modules/m7-intervention/index.js';
import { createPipeline } from '../../src/modules/m1-proxy/index.js';
import { PassThrough } from 'node:stream';
import { Writable } from 'node:stream';

// ── Helpers ───────────────────────────────────────────────────────────────────

class LineCollector extends Writable {
  readonly lines: string[] = [];
  _write(chunk: Buffer | string, _enc: string, cb: () => void) {
    String(chunk).split('\n').filter(l => l.trim()).forEach(l => this.lines.push(l));
    cb();
  }
}

/** Wait until at least `count` lines have been collected, or timeout. */
function waitLines(collector: LineCollector, count: number, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`Timeout waiting for ${count} lines`)), timeoutMs);
    const check = setInterval(() => {
      if (collector.lines.length >= count) {
        clearInterval(check);
        clearTimeout(t);
        resolve();
      }
    }, 10);
  });
}

/**
 * Node.js echo-server script: for each newline-delimited JSON-RPC request,
 * echo back a result response with the same id. For tools/call, wrap the
 * forwarded request body in a result object.
 */
const ECHO_SERVER_SCRIPT = `
const rl = require('readline').createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const resp = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method, params: msg.params } });
  process.stdout.write(resp + '\\n');
});
`;

function makePipeline() {
  return createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController(),
  });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MCPStdioProxy e2e (real child process)', () => {

  it('relays initialize response from child back to client', async () => {
    const clientOut = new LineCollector();
    const pipeline = makePipeline();

    const proxy = new MCPStdioProxy({
      command: ['node', '-e', ECHO_SERVER_SCRIPT],
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'e2e-agent',
      sessionId: 'e2e-session',
      stdout: clientOut,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
      stdin: new PassThrough(),
    });

    const startPromise = proxy.start();

    // Send an initialize request via the proxy's stdin (not yet wired; we use handleClientLine directly)
    const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);
    await handle(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { version: '1.0' } }));

    // The child should echo a response → proxy relays it to clientOut
    await waitLines(clientOut, 1);

    proxy.stop();
    await startPromise.catch(() => { /* child killed */ });

    expect(clientOut.lines.length).toBeGreaterThanOrEqual(1);
    const resp = JSON.parse(clientOut.lines[0]);
    expect(resp.result.echoed).toBe('initialize');
    expect(resp.id).toBe(1);
  });

  it('blocks delete_file tools/call and never forwards to child', async () => {
    const clientOut = new LineCollector();
    const childCapture = new LineCollector();
    const pipeline = makePipeline();

    const proxy = new MCPStdioProxy({
      command: ['node', '-e', ECHO_SERVER_SCRIPT],
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'e2e-agent',
      sessionId: 'e2e-session',
      stdout: clientOut,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
      stdin: new PassThrough(),
    });

    // Capture what would go to child stdin (before start, stub writeToChild)
    const startPromise = proxy.start();
    const origWrite = (proxy as unknown as { writeToChild(l: string): void }).writeToChild;
    (proxy as unknown as { writeToChild(l: string): void }).writeToChild = (line: string) => {
      childCapture._write(Buffer.from(line), 'utf-8', () => {});
      origWrite.call(proxy, line);
    };

    const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);

    const req = { jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: 'delete_file', arguments: { path: '/critical/db' } } };
    await handle(JSON.stringify(req));

    // Block is immediate — no need to wait for child
    await waitLines(clientOut, 1);

    proxy.stop();
    await startPromise.catch(() => { /* killed */ });

    // Child should NOT have received the request
    const sentToChild = childCapture.lines.filter(l => {
      try { return JSON.parse(l).params?.name === 'delete_file'; } catch { return false; }
    });
    expect(sentToChild).toHaveLength(0);

    // Client should have received a JSON-RPC error
    const errResp = JSON.parse(clientOut.lines[0]) as { id: number; error: { code: number; message: string } };
    expect(errResp.id).toBe(99);
    expect(errResp.error.code).toBe(-32600);
    expect(errResp.error.message).toContain('AgentsGate blocked');
  });

  it('allows read_file tools/call and echoes child response back to client', async () => {
    const clientOut = new LineCollector();
    const pipeline = makePipeline();

    const proxy = new MCPStdioProxy({
      command: ['node', '-e', ECHO_SERVER_SCRIPT],
      evaluateRisk: pipeline.evaluateRisk!,
      agentId: 'e2e-agent',
      sessionId: 'e2e-session',
      stdout: clientOut,
      stderr: new Writable({ write(_c, _e, cb) { cb(); } }),
      stdin: new PassThrough(),
    });

    const startPromise = proxy.start();
    const handle = (line: string) => (proxy as unknown as { handleClientLine(l: string): Promise<void> }).handleClientLine(line);

    const req = { jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'read_file', arguments: { path: '/tmp/data.txt' } } };
    await handle(JSON.stringify(req));

    // Child echoes → proxy relays to client
    await waitLines(clientOut, 1);

    proxy.stop();
    await startPromise.catch(() => { /* killed */ });

    expect(clientOut.lines.length).toBeGreaterThanOrEqual(1);
    const resp = JSON.parse(clientOut.lines[0]);
    // Echo server returns result.echoed = 'tools/call'
    expect(resp.result.echoed).toBe('tools/call');
    expect(resp.id).toBe(77);
  });
});
