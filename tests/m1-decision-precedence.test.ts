/**
 * Who gets the last word on a decision.
 *
 * Four things can now change a verdict — thresholds, the protection level,
 * policy rules, and a one-shot grant — on top of the guards that refuse an
 * operation before it is ever scored. Getting the order wrong is not a
 * cosmetic bug: a level that could undo a rate-limit block, or a grant that
 * could spend its way past a `block`, would each be a way around the gate.
 *
 * The intended order, innermost first:
 *
 *   1. session expiry, quota, circuit breaker, allow-list, rate limit
 *      — refuse before scoring; nothing downstream can revive them
 *   2. thresholds turn a score into a verdict
 *   3. the protection level rewrites it by category — it may loosen as well
 *      as tighten, which is the whole point
 *   4. a policy rule beats the level, because it is the operator being
 *      specific rather than picking a preset
 *   5. dry-run forces allow, whatever anyone else decided
 *   6. a grant is spent only on a verdict that is still require_approval
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import { AgentRateLimiter } from '../src/utils/rate-limiter.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { getProtectionLevel } from '../src/protection-levels.js';
import { operationFingerprint } from '../src/utils/operation-fingerprint.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';
import type { AgentsGatePolicy } from '../src/policy.js';

let dir: string;
let store: StateStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-prec-'));
  store = new StateStore(path.join(dir, 'p.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

function run(extra: Record<string, unknown> = {}) {
  const p = createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.7 }),
    ...extra,
  });
  return (op: Partial<MCPOperation>): Promise<ProxyDecision> => p.evaluateRisk!({
    id: 'op', agentId: 'claude', tool: 'filesystem', method: 'read_file', params: {},
    timestamp: new Date(), sessionId: 'sess', ...op,
  } as MCPOperation);
}

/** Scores 0.90, category `credential` — blocked at balanced, allowed at minimal. */
const ENV_WRITE = { tool: 'filesystem', method: 'write_file', params: { path: '/app/.env', content: 'K=1' } };
/** Scores 0.05, category `read`. */
const READ = { tool: 'filesystem', method: 'read_file', params: { path: '/app/x.ts' } };

describe('the guards that run before scoring', () => {
  it('cannot be undone by a level that would allow the operation', async () => {
    // minimal allows everything except wholesale destruction, so if the level
    // were applied to these the block would evaporate.
    const level = getProtectionLevel('minimal')!;

    const expired = run({ protectionLevel: level, expiredSessions: new Set(['sess']) });
    expect((await expired(READ)).action).toBe('block');

    const limiter = new AgentRateLimiter(1);
    const limited = run({ protectionLevel: level, rateLimiter: limiter });
    await limited(READ);                       // spends the one allowance
    expect((await limited(READ)).action).toBe('block');
  });
});

describe('the protection level', () => {
  it('loosens a threshold verdict', async () => {
    const strictThresholds = run({ protectionLevel: getProtectionLevel('minimal')! });
    expect((await strictThresholds(ENV_WRITE)).action).toBe('allow');   // 0.90, but minimal allows credentials
  });

  it('tightens one', async () => {
    const level = getProtectionLevel('strict')!;
    const shell = { tool: 'shell', method: 'execute', params: { command: 'ls' } };
    // 0.80 would block on thresholds; strict calls exec an approval matter.
    expect((await run({ protectionLevel: level })(shell)).action).toBe('require_approval');
  });

  it('says so in the reasons, so a surprising verdict can be traced', async () => {
    const d = await run({ protectionLevel: getProtectionLevel('minimal')! })(ENV_WRITE);
    expect(d.reasons.join(' ')).toMatch(/Protection level "minimal"/);
  });
});

describe('a policy rule', () => {
  it('beats the level, in the tightening direction', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'NO_ENV', match: { pathPattern: '\\.env' }, action: 'block' }],
    };
    const d = await run({ protectionLevel: getProtectionLevel('minimal')!, policy })(ENV_WRITE);
    expect(d.action).toBe('block');            // level said allow
  });

  it('beats the level in the loosening direction too', async () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'TRUST_ENV', match: { pathPattern: '\\.env' }, action: 'allow' }],
    };
    const d = await run({ protectionLevel: getProtectionLevel('balanced')!, policy })(ENV_WRITE);
    expect(d.action).toBe('allow');            // level said block
  });
});

describe('dry-run', () => {
  it('forces allow even where the level says block', async () => {
    const d = await run({ protectionLevel: getProtectionLevel('balanced')!, dryRun: true })(ENV_WRITE);
    expect(d.action).toBe('allow');
    expect(d.dryRun).toBe(true);
    expect(d.reasons.join(' ')).toMatch(/DRY-RUN/);
  });
});

describe('a one-shot grant', () => {
  it('cannot spend its way past a block', async () => {
    // The grant is only consulted for a verdict that is still
    // require_approval. A blocked operation must stay blocked however many
    // grants exist for it.
    await store.createApprovalGrant(
      operationFingerprint({ ...ENV_WRITE, id: 'x', agentId: 'claude', sessionId: 'sess' } as MCPOperation),
      'x', new Date(Date.now() + 300_000)
    );
    const d = await run({ protectionLevel: getProtectionLevel('balanced')!, grantStore: store })(ENV_WRITE);
    expect(d.action).toBe('block');
    // ...and the grant is still there, unspent.
    expect(await store.consumeApprovalGrant(
      operationFingerprint({ ...ENV_WRITE, id: 'x', agentId: 'claude', sessionId: 'sess' } as MCPOperation)
    )).toBe(true);
  });

  it('is spent on a verdict the level left at require_approval', async () => {
    const del = { tool: 'gmail', method: 'delete_email', params: { id: '1' } };
    const fp = operationFingerprint({ ...del, id: 'x', agentId: 'claude', sessionId: 'sess' } as MCPOperation);
    await store.createApprovalGrant(fp, 'x', new Date(Date.now() + 300_000));

    const d = await run({ protectionLevel: getProtectionLevel('balanced')!, grantStore: store })(del);
    expect(d.action).toBe('allow');
    expect(await store.consumeApprovalGrant(fp)).toBe(false);   // spent
  });
});
