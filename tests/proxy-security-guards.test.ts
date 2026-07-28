/**
 * Security regression tests for the proxy core hardening (2026-07 review):
 *  - recursive secret redaction in the operation logger
 *  - request body size cap on the HTTP proxy transport (413)
 *  - case/whitespace/Unicode-insensitive matching for policy identifier fields
 */

import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { redactParams } from '../src/modules/m3-logger/index.js';
import { matchRule } from '../src/policy.js';
import { MCPProxy } from '../src/modules/m1-proxy/index.js';
import type { MCPOperation, PolicyRule } from '../src/types/interfaces.js';

describe('redactParams — recursive secret redaction', () => {
  it('redacts secrets nested inside objects and arrays', () => {
    const out = redactParams({
      tool: 'http',
      headers: { Authorization: 'Bearer eyJhbGciOi...' },
      users: [{ name: 'a', password: 'hunter2' }],
      config: { db: { connectionString: 'postgres://u:p@h/db' } },
    });
    expect(JSON.stringify(out)).not.toContain('eyJhbGciOi');
    expect(JSON.stringify(out)).not.toContain('hunter2');
    expect(JSON.stringify(out)).not.toContain('u:p@h');
    // Non-secret fields survive
    expect(out['tool']).toBe('http');
  });

  it('catches bare secret key names missed by the old compound-only patterns', () => {
    const out = redactParams({ token: 'abc', pwd: 'x', idToken: 'y', refreshToken: 'z' });
    expect(out['token']).toBe('[REDACTED]');
    expect(out['pwd']).toBe('[REDACTED]');
    expect(out['idToken']).toBe('[REDACTED]');
    expect(out['refreshToken']).toBe('[REDACTED]');
  });

  it('drops prototype-polluting keys and tolerates cycles', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic['self'] = cyclic;
    const out = redactParams(JSON.parse('{"__proto__":{"polluted":true},"ok":1}'));
    expect(Object.prototype.hasOwnProperty.call(out, '__proto__')).toBe(false);
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
    expect(() => redactParams(cyclic)).not.toThrow();
  });
});

describe('policy matching — identifier fields resist case/whitespace evasion', () => {
  const makeOp = (over: Partial<MCPOperation>): MCPOperation => ({
    id: 'op', agentId: 'a', tool: 'database', method: 'delete_record',
    params: {}, timestamp: new Date(), sessionId: 's', ...over,
  });

  it('a block rule still matches when the method case/whitespace differs', () => {
    const rule: PolicyRule = { id: 'R', match: { tool: 'database', method: 'delete_record' }, action: 'block' };
    expect(matchRule(rule, makeOp({ method: 'DELETE_RECORD' }))).toBe(true);
    expect(matchRule(rule, makeOp({ method: 'delete_record ' }))).toBe(true);
    expect(matchRule(rule, makeOp({ tool: 'DataBase', method: 'delete_record' }))).toBe(true);
  });
});

describe('MCPProxy — request body size cap', () => {
  let proxy: MCPProxy | undefined;
  afterEach(async () => { await proxy?.stop(); });

  it('rejects an oversized POST body with 413', async () => {
    proxy = new MCPProxy();
    await proxy.start(0);
    const port = ((proxy as unknown as { server: http.Server }).server.address() as { port: number }).port;

    const huge = 'x'.repeat(2 * 1024 * 1024); // 2 MiB > 1 MiB cap
    const status = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port, method: 'POST', headers: { 'Content-Type': 'application/json' } },
        res => { res.resume(); res.on('end', () => resolve(res.statusCode ?? 0)); },
      );
      req.on('error', reject);
      req.end(huge);
    });
    expect(status).toBe(413);
  });
});
