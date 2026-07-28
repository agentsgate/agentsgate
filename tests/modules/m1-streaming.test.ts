/**
 * T111 — Streaming tool-call response support in stdio proxy.
 *
 * Tests the progress-notification relay logic and cancel-request handling
 * without spawning a real child process.  We feed raw JSON-RPC lines into
 * the proxy's internal handleClientLine / handleChildLine via its public
 * stream pairs.
 */
import { describe, it, expect, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { MCPStdioProxy } from '../../src/modules/m1-proxy/stdio.js';
import type { MCPOperation, ProxyDecision } from '../../src/types/interfaces.js';

const allowDecision: ProxyDecision = { action: 'allow', riskScore: 0.1, reasons: [] };

/** Build an MCPStdioProxy wired to in-memory PassThrough streams. */
function makeProxy(opts: {
  onPartialResult?: (id: string | number, partial: unknown) => void;
  onIntercept?: (op: MCPOperation, dec: ProxyDecision) => void;
}) {
  const clientIn  = new PassThrough();  // what "client" sends to proxy
  const clientOut = new PassThrough();  // what proxy sends back to "client"
  const childIn   = new PassThrough();  // what proxy sends to child
  const childOut  = new PassThrough();  // what child sends back to proxy

  // We intercept child stdin/stdout by swapping them out post-construction
  // via the echo-server trick: wire childIn → childOut externally in tests.

  const proxy = new MCPStdioProxy({
    command: ['node', '--version'],  // spawned but immediately replaced
    evaluateRisk: async () => allowDecision,
    agentId: 'test-agent',
    sessionId: 'sess-1',
    stdin: clientIn,
    stdout: clientOut,
    ...(opts.onPartialResult ? { onPartialResult: opts.onPartialResult } : {}),
    ...(opts.onIntercept     ? { onIntercept: opts.onIntercept }         : {}),
  });

  // Expose internal streams for direct testing
  return { proxy, clientIn, clientOut, childIn, childOut };
}

/**
 * Directly call the proxy's internal child-line handler by accessing it
 * (it's private, but we access via the prototype for unit testing).
 */
function callHandleChildLine(proxy: MCPStdioProxy, line: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (proxy as any).handleChildLine(line);
}

function callHandleClientLine(proxy: MCPStdioProxy, line: string): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (proxy as any).handleClientLine(line);
}

function collectOutput(stream: PassThrough): string[] {
  const lines: string[] = [];
  stream.on('data', (chunk: Buffer) => {
    chunk.toString().split('\n').filter(Boolean).forEach(l => lines.push(l));
  });
  return lines;
}

describe('MCPStdioProxy — streaming partial-result relay', () => {
  it('onPartialResult is called for notifications/progress matching a pending call', async () => {
    const partial = vi.fn();
    const { proxy, clientOut } = makeProxy({ onPartialResult: partial });
    // Simulate child stdin to satisfy writeToChild
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any).child = { stdin: { write: () => {} }, kill: () => {} };

    const lines = collectOutput(clientOut);

    // Send a tools/call from client — creates pending entry with id "req-1"
    await callHandleClientLine(proxy, JSON.stringify({
      jsonrpc: '2.0', id: 'req-1', method: 'tools/call',
      params: { name: 'read_file', arguments: { path: '/tmp/f' } },
    }));

    expect(proxy.getPendingCallCount()).toBe(1);

    // Simulate child sending a progress notification referencing req-1
    callHandleChildLine(proxy, JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: 'req-1', progress: 50, total: 100 },
    }));

    expect(partial).toHaveBeenCalledOnce();
    const [calledId, calledPartial] = partial.mock.calls[0] as [string | number, unknown];
    expect(calledId).toBe('req-1');
    expect((calledPartial as Record<string, unknown>)['progress']).toBe(50);

    // The notification is still relayed to the client
    expect(lines.some(l => l.includes('notifications/progress'))).toBe(true);
  });

  it('pending call is cleared when final response arrives', async () => {
    const { proxy } = makeProxy({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any).child = { stdin: { write: () => {} }, kill: () => {} };

    await callHandleClientLine(proxy, JSON.stringify({
      jsonrpc: '2.0', id: 42, method: 'tools/call',
      params: { name: 'write_file', arguments: {} },
    }));
    expect(proxy.getPendingCallCount()).toBe(1);

    // Child sends final response
    callHandleChildLine(proxy, JSON.stringify({
      jsonrpc: '2.0', id: 42, result: { content: [{ type: 'text', text: 'done' }] },
    }));

    expect(proxy.getPendingCallCount()).toBe(0);
  });

  it('$/cancelRequest clears the pending call and is forwarded to child', async () => {
    const written: string[] = [];
    const { proxy } = makeProxy({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any).child = {
      stdin: { write: (d: string) => written.push(d) },
      kill: () => {},
    };

    await callHandleClientLine(proxy, JSON.stringify({
      jsonrpc: '2.0', id: 'req-cancel', method: 'tools/call',
      params: { name: 'read_file', arguments: {} },
    }));
    expect(proxy.getPendingCallCount()).toBe(1);

    // Client cancels
    await callHandleClientLine(proxy, JSON.stringify({
      jsonrpc: '2.0', method: '$/cancelRequest',
      params: { id: 'req-cancel' },
    }));

    expect(proxy.getPendingCallCount()).toBe(0);
    expect(written.some(w => w.includes('cancelRequest'))).toBe(true);
  });

  it('onPartialResult is NOT called for notifications unrelated to pending calls', async () => {
    const partial = vi.fn();
    const { proxy } = makeProxy({ onPartialResult: partial });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any).child = { stdin: { write: () => {} }, kill: () => {} };

    // No pending calls — send a progress notification
    callHandleChildLine(proxy, JSON.stringify({
      jsonrpc: '2.0', method: 'notifications/progress',
      params: { progressToken: 'unknown-token', progress: 10 },
    }));

    expect(partial).not.toHaveBeenCalled();
  });

  it('non-tools/call requests are forwarded without creating pending entries', async () => {
    const { proxy } = makeProxy({});
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (proxy as any).child = { stdin: { write: () => {} }, kill: () => {} };

    await callHandleClientLine(proxy, JSON.stringify({
      jsonrpc: '2.0', id: 'init-1', method: 'initialize',
      params: { protocolVersion: '2024-11-05' },
    }));

    expect(proxy.getPendingCallCount()).toBe(0);
  });
});
