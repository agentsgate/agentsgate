/**
 * A `require_approval` verdict must not reach the child MCP server.
 *
 * The stdio proxy short-circuited only on `block`; `require_approval` took the
 * same path as `allow` and was forwarded, with the score annotated onto the
 * params. The comment in the source called this "approval can be handled
 * async", but an approval that arrives after the tool has run is a
 * notification, not a gate — and `agentsgate inject` wires Claude Desktop
 * through exactly this path, so with the default thresholds the whole
 * 0.3–0.7 band executed unchecked.
 *
 * With no approval resolver configured the proxy now fails closed. With one, it
 * holds the request until the resolver answers.
 */
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { MCPStdioProxy } from '../src/modules/m1-proxy/stdio.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

const CHILD = [
  process.execPath,
  '-e',
  `const rl=require('readline').createInterface({input:process.stdin});
   rl.on('line',l=>{let m;try{m=JSON.parse(l)}catch{return}
     if(m.method==='tools/call'){
       process.stderr.write('CHILD_RAN:'+m.params.name+'\\n');
       process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{ran:true}})+'\\n');
     }});`,
];

interface Harness {
  send: (msg: unknown) => void;
  responses: () => Array<Record<string, unknown>>;
  childRan: () => boolean;
  stop: () => void;
}

function start(
  action: ProxyDecision['action'],
  awaitApproval?: (op: MCPOperation, d: ProxyDecision) => Promise<'approved' | 'denied'>
): Harness {
  const toClient = new PassThrough();
  const fromClient = new PassThrough();
  const childErr = new PassThrough();

  const out: Array<Record<string, unknown>> = [];
  toClient.on('data', chunk => {
    for (const line of String(chunk).split('\n')) {
      if (line.trim()) { try { out.push(JSON.parse(line)); } catch { /* partial */ } }
    }
  });
  let stderrText = '';
  childErr.on('data', c => { stderrText += String(c); });

  const proxy = new MCPStdioProxy({
    command: CHILD,
    stdin: fromClient,
    stdout: toClient,
    stderr: childErr,
    ...(awaitApproval ? { awaitApproval } : {}),
    evaluateRisk: async (op): Promise<ProxyDecision> => ({
      operationId: op.id, action, riskScore: 0.5,
      reasons: ['test'], timestamp: new Date(),
    }),
  });
  void proxy.start();

  return {
    send: msg => fromClient.write(JSON.stringify(msg) + '\n'),
    responses: () => out,
    childRan: () => stderrText.includes('CHILD_RAN'),
    stop: () => proxy.stop(),
  };
}

const CALL = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delete_everything', arguments: {} } };
const settle = (ms = 700): Promise<void> => new Promise(r => setTimeout(r, ms));

describe('require_approval with no resolver configured', () => {
  it('does not reach the child', async () => {
    const h = start('require_approval');
    h.send(CALL);
    await settle();
    expect(h.childRan()).toBe(false);
    h.stop();
  });

  it('answers the client with an error rather than hanging', async () => {
    const h = start('require_approval');
    h.send(CALL);
    await settle();
    const [res] = h.responses();
    expect(res?.['id']).toBe(1);
    expect(res?.['error']).toBeDefined();
    expect(String((res?.['error'] as { message: string }).message)).toMatch(/approval/i);
    h.stop();
  });
});

describe('require_approval with a resolver', () => {
  it('forwards once the operation is approved', async () => {
    const h = start('require_approval', async () => 'approved');
    h.send(CALL);
    await settle();
    expect(h.childRan()).toBe(true);
    expect(h.responses()[0]?.['result']).toBeDefined();
    h.stop();
  });

  it('refuses once the operation is denied, and never runs it', async () => {
    const h = start('require_approval', async () => 'denied');
    h.send(CALL);
    await settle();
    expect(h.childRan()).toBe(false);
    expect(h.responses()[0]?.['error']).toBeDefined();
    h.stop();
  });

  it('holds the request while the resolver is still deciding', async () => {
    let release!: (v: 'approved') => void;
    const pending = new Promise<'approved'>(r => { release = r; });
    const h = start('require_approval', () => pending);

    h.send(CALL);
    await settle(400);
    expect(h.childRan()).toBe(false);          // still waiting
    expect(h.responses()).toHaveLength(0);

    release('approved');
    await settle(400);
    expect(h.childRan()).toBe(true);           // released
    h.stop();
  });

  it('fails closed when the resolver throws', async () => {
    const h = start('require_approval', async () => { throw new Error('dashboard unreachable'); });
    h.send(CALL);
    await settle();
    expect(h.childRan()).toBe(false);
    expect(h.responses()[0]?.['error']).toBeDefined();
    h.stop();
  });

  it('is not consulted for allow or block', async () => {
    const resolver = vi.fn(async () => 'approved' as const);

    const allowed = start('allow', resolver);
    allowed.send(CALL);
    await settle();
    expect(allowed.childRan()).toBe(true);
    allowed.stop();

    const blocked = start('block', resolver);
    blocked.send(CALL);
    await settle();
    expect(blocked.childRan()).toBe(false);
    blocked.stop();

    expect(resolver).not.toHaveBeenCalled();
  });
});
