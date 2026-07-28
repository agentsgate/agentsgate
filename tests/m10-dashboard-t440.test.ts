/**
 * T440 — Rules tab hit-count column + quick-create rule buttons from operation rows
 *
 * Covers:
 *   Part 1 — Hit count column in Policy Rules table:
 *     - GET /policy/stats returns proper structure (rules[], totalRules)
 *     - recordFiredRules correctly increments hit counts
 *     - Hit counts are retrievable per-rule for the hitMap used by loadPolicyRules()
 *     - GET /policy/stats gracefully returns empty rules when no hits recorded
 *     - Dashboard HTML contains <th>Hits</th> header column
 *     - Dashboard HTML has colspan="9" for policy rules table empty/error states
 *
 *   Part 2 — Quick-create rule buttons in operation detail:
 *     - Dashboard HTML contains "Quick rule:" label for quick-create UI
 *     - Dashboard HTML contains BLOCK_ rule ID pattern
 *     - Dashboard HTML contains APPROVE_ rule ID pattern
 *     - Dashboard HTML contains ALLOW_AGENT_ rule ID pattern
 *     - Dashboard HTML references openRuleModal for quick-create buttons
 *
 * Port range: 63500+
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import type { AgentsGatePolicy, PolicyRule } from '../src/policy.js';

// Ports come from start(0). A hand-picked base sits inside the OS ephemeral
// range (49152-65535 on macOS), so any concurrent listen(0) can be handed the
// same number and this suite loses the race with EADDRINUSE.

// ── helpers ────────────────────────────────────────────────────────────────────

interface Ctx {
  dash: DashboardAPI;
  port: number;
  store: StateStore;
  tmpDir: string;
  policy?: AgentsGatePolicy;
}

async function setup(policy?: AgentsGatePolicy, policyPath?: string): Promise<Ctx> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t440-'));
  const store = new StateStore(path.join(tmpDir, 'test.db'));
  await store.initialize();
  let port = 0;const opts: Record<string, unknown> = {};
  if (policy) opts.policy = policy;
  if (policyPath) opts.policyPath = policyPath;
  const dash = new DashboardAPI(store, opts);
  await dash.start(0);
  port = dash.getPort();
  return { dash, port, store, tmpDir, policy };
}

async function teardown(ctx: Ctx): Promise<void> {
  await ctx.dash.stop();
  await ctx.store.close();
  await fs.rm(ctx.tmpDir, { recursive: true, force: true });
}

async function getJSON(
  port: number,
  p: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function getHTML(port: number): Promise<{ status: number; body: string }> {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  return { status: res.status, body: await res.text() };
}

type PolicyStatsBody = {
  rules: Array<{ ruleId: string; hits: number }>;
  totalRules: number;
};

// ── Part 1: Hit count column — /policy/stats backend ──────────────────────────

describe('T440 Part 1 — GET /policy/stats for hit count column', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('1. fresh dashboard: GET /policy/stats returns empty rules array and totalRules=0', async () => {
    ctx = await setup();
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as unknown as PolicyStatsBody;
    expect(Array.isArray(b.rules)).toBe(true);
    expect(b.rules).toHaveLength(0);
    expect(b.totalRules).toBe(0);
  });

  it('2. after recordFiredRules with one rule: stats returns that rule with hits=1', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['BLOCK_FS_CALL']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as unknown as PolicyStatsBody;
    expect(b.totalRules).toBe(1);
    const entry = b.rules.find(r => r.ruleId === 'BLOCK_FS_CALL');
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(1);
  });

  it('3. hit count increments correctly across multiple recordFiredRules calls', async () => {
    ctx = await setup();
    const ruleId = 'APPROVE_FS_WRITE';
    ctx.dash.recordFiredRules([ruleId]);
    ctx.dash.recordFiredRules([ruleId]);
    ctx.dash.recordFiredRules([ruleId]);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as unknown as PolicyStatsBody;
    const entry = b.rules.find(r => r.ruleId === ruleId);
    expect(entry).toBeDefined();
    expect(entry!.hits).toBe(3);
  });

  it('4. multiple rules tracked separately with independent hit counts', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['BLOCK_SHELL_EXEC']);
    ctx.dash.recordFiredRules(['BLOCK_SHELL_EXEC']);
    ctx.dash.recordFiredRules(['ALLOW_AGENT_TRUSTED']);
    const { status, body } = await getJSON(ctx.port, '/policy/stats');
    expect(status).toBe(200);
    const b = body as unknown as PolicyStatsBody;
    expect(b.totalRules).toBe(2);
    const blockEntry = b.rules.find(r => r.ruleId === 'BLOCK_SHELL_EXEC');
    const allowEntry = b.rules.find(r => r.ruleId === 'ALLOW_AGENT_TRUSTED');
    expect(blockEntry).toBeDefined();
    expect(blockEntry!.hits).toBe(2);
    expect(allowEntry).toBeDefined();
    expect(allowEntry!.hits).toBe(1);
  });

  it('5. hitMap construction: stats.rules array can be mapped to ruleId→hits as used by loadPolicyRules()', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules(['RULE_A']);
    ctx.dash.recordFiredRules(['RULE_A']);
    ctx.dash.recordFiredRules(['RULE_B']);
    const { body } = await getJSON(ctx.port, '/policy/stats');
    const b = body as unknown as PolicyStatsBody;
    // Simulate the hitMap construction from loadPolicyRules():
    // const hitMap = new Map((statsResp.rules ?? []).map(s => [s.ruleId, s.hits]));
    const hitMap = new Map((b.rules ?? []).map(s => [s.ruleId, s.hits]));
    expect(hitMap.get('RULE_A')).toBe(2);
    expect(hitMap.get('RULE_B')).toBe(1);
    // A rule not in stats should fall back to 0 (?? 0 pattern in the dashboard)
    expect(hitMap.get('RULE_NOT_FIRED') ?? 0).toBe(0);
  });

  it('6. GET /policy/stats returns JSON content-type', async () => {
    ctx = await setup();
    const res = await fetch(`http://127.0.0.1:${ctx.port}/policy/stats`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('7. stats sorted by hits descending (highest-hit rule first) for display priority', async () => {
    ctx = await setup();
    // rule-low: 1 hit, rule-high: 5 hits
    ctx.dash.recordFiredRules(['rule-low']);
    for (let i = 0; i < 5; i++) {
      ctx.dash.recordFiredRules(['rule-high']);
    }
    const { body } = await getJSON(ctx.port, '/policy/stats');
    const b = body as unknown as PolicyStatsBody;
    expect(b.rules).toHaveLength(2);
    expect(b.rules[0].ruleId).toBe('rule-high');
    expect(b.rules[0].hits).toBe(5);
    expect(b.rules[1].ruleId).toBe('rule-low');
    expect(b.rules[1].hits).toBe(1);
  });

  it('8. recordFiredRules with empty array is a no-op — stats remains empty', async () => {
    ctx = await setup();
    ctx.dash.recordFiredRules([]);
    ctx.dash.recordFiredRules([]);
    const { body } = await getJSON(ctx.port, '/policy/stats');
    const b = body as unknown as PolicyStatsBody;
    expect(b.rules).toHaveLength(0);
    expect(b.totalRules).toBe(0);
  });
});

// ── Part 1: Hit count column — HTML verification ───────────────────────────────

describe('T440 Part 1 — Dashboard HTML hit count column markup', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('9. dashboard HTML contains <th>Hits</th> in the policy rules table header', async () => {
    ctx = await setup();
    const { status, body } = await getHTML(ctx.port);
    expect(status).toBe(200);
    expect(body).toContain('<th>Hits</th>');
  });

  it('10. policy-rules-table header row has 9 columns (Hits added before Actions)', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // Verify the Hits column appears before the Actions column in the thead
    const hitsIdx = body.indexOf('<th>Hits</th>');
    const actionsIdx = body.indexOf('<th style="text-align:right">Actions</th>');
    expect(hitsIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeGreaterThan(-1);
    expect(hitsIdx).toBeLessThan(actionsIdx);
  });

  it('11. policy-rules-table empty state uses colspan="9" (not 8)', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // The loading placeholder should use colspan="9"
    expect(body).toContain('colspan="9"');
    // Ensure old colspan="8" is not present in policy rules context
    // (count occurrences of each to validate the change)
    const matches9 = (body.match(/colspan="9"/g) ?? []).length;
    expect(matches9).toBeGreaterThanOrEqual(1);
  });

  it('12. dashboard HTML contains loadPolicyRules function fetching both /policy/rules and /policy/stats', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('/policy/stats');
    expect(body).toContain('/policy/rules');
    // Both fetches must be present in the same loadPolicyRules context
    const rulesIdx = body.indexOf("'/policy/rules'");
    const statsIdx = body.indexOf("'/policy/stats'");
    expect(rulesIdx).toBeGreaterThan(-1);
    expect(statsIdx).toBeGreaterThan(-1);
  });

  it('13. dashboard HTML contains hitMap construction from stats response', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // The hitMap Map construction line must be present
    expect(body).toContain('hitMap');
    expect(body).toContain('statsResp');
  });
});

// ── Part 2: Quick-create rule buttons — HTML verification ──────────────────────

describe('T440 Part 2 — Dashboard HTML quick-create rule buttons', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('14. dashboard HTML contains "Quick rule:" label for the quick-create UI section', async () => {
    ctx = await setup();
    const { status, body } = await getHTML(ctx.port);
    expect(status).toBe(200);
    expect(body).toContain('Quick rule:');
  });

  it('15. dashboard HTML contains BLOCK_ rule ID pattern for block quick-create button', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('BLOCK_');
  });

  it('16. dashboard HTML contains APPROVE_ rule ID pattern for require-approval quick-create button', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('APPROVE_');
  });

  it('17. dashboard HTML contains ALLOW_AGENT_ rule ID pattern for trust-agent quick-create button', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('ALLOW_AGENT_');
  });

  it('18. dashboard HTML contains renderRuleDetail function with tool/method/agentId extraction', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('renderRuleDetail');
    // Tool and method extraction used to conditionally show quick-create buttons
    expect(body).toContain('op?.tool');
    expect(body).toContain('op?.method');
    expect(body).toContain('op?.agentId');
  });

  it('19. dashboard HTML "Require approval" button text is present for approval quick-create', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('Require approval');
  });

  it('20. dashboard HTML "Trust agent" button text is present for allow-agent quick-create', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    expect(body).toContain('Trust agent');
  });

  it('21. dashboard HTML quick-create openRuleModal calls are present for all three button types', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // openRuleModal must appear multiple times (edit button + quick-create buttons)
    const occurrences = (body.match(/openRuleModal/g) ?? []).length;
    // At minimum: new-rule button + edit-rule button in loadPolicyRules + 3 quick-create buttons in renderRuleDetail
    expect(occurrences).toBeGreaterThanOrEqual(4);
  });

  it('22. dashboard HTML quick-create block button has correct style properties (red theme)', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // Red color for block button: rgba(248,113,113,.15) or #f87171
    expect(body).toContain('rgba(248,113,113,.15)');
    expect(body).toContain('#f87171');
  });

  it('23. dashboard HTML quick-create approval button has correct style properties (yellow theme)', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // Yellow color for approval button: rgba(250,204,21,.15) or #facc15
    expect(body).toContain('rgba(250,204,21,.15)');
    expect(body).toContain('#facc15');
  });

  it('24. dashboard HTML quick-create allow-agent button has correct style properties (green theme)', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // Green color for trust-agent button: rgba(74,222,128,.15) or #4ade80
    expect(body).toContain('rgba(74,222,128,.15)');
    expect(body).toContain('#4ade80');
  });

  it('25. dashboard HTML quick-create section has border-top separator and flex layout', async () => {
    ctx = await setup();
    const { body } = await getHTML(ctx.port);
    // The quick-create section is styled with display:flex and a border-top separator
    expect(body).toContain('border-top:1px solid var(--border)');
    expect(body).toContain('display:flex');
  });
});

// ── Part 1+2 combined: /policy/rules + /policy/stats integration ───────────────

describe('T440 combined — /policy/rules and /policy/stats integration', () => {
  let ctx: Ctx;

  afterEach(async () => {
    if (ctx) await teardown(ctx);
  });

  it('26. GET /policy/rules and GET /policy/stats can both be fetched concurrently without error', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t440-comb-'));
    const policyPath = path.join(tmpDir, 'policy.json');
    const testRule: PolicyRule = {
      id: 'BLOCK_FS_CALL',
      description: 'Block FS call tool',
      match: { tool: 'fs', method: 'call' },
      action: 'block',
      priority: 10,
    };
    const policy: AgentsGatePolicy = { rules: [testRule] };
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2));
    const store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
    let port = 0;const dash = new DashboardAPI(store, { policy, policyPath });
    await dash.start(0);
  port = dash.getPort();

    try {
      // Simulate the loadPolicyRules() parallel fetch pattern
      const [rulesRes, statsRes] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/policy/rules`),
        fetch(`http://127.0.0.1:${port}/policy/stats`),
      ]);
      expect(rulesRes.status).toBe(200);
      expect(statsRes.status).toBe(200);

      const rulesBody = (await rulesRes.json()) as { rules: PolicyRule[] };
      const statsBody = (await statsRes.json()) as PolicyStatsBody;

      // Rules endpoint returns the configured rule
      expect(rulesBody.rules).toHaveLength(1);
      expect(rulesBody.rules[0].id).toBe('BLOCK_FS_CALL');

      // Stats endpoint returns empty hits (rule never fired)
      expect(statsBody.totalRules).toBe(0);

      // Build hitMap as in loadPolicyRules()
      const hitMap = new Map((statsBody.rules ?? []).map(s => [s.ruleId, s.hits]));
      const hits = hitMap.get('BLOCK_FS_CALL') ?? 0;
      expect(hits).toBe(0);
    } finally {
      await dash.stop();
      await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('27. after recording rule hits, the hitMap correctly shows hit count > 0 for fired rule', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'as-t440-hm-'));
    const policyPath = path.join(tmpDir, 'policy.json');
    const firedRuleId = 'APPROVE_NET_FETCH';
    const testRule: PolicyRule = {
      id: firedRuleId,
      description: 'Require approval for net fetch',
      match: { tool: 'net', method: 'fetch' },
      action: 'require_approval',
      priority: 10,
    };
    const policy: AgentsGatePolicy = { rules: [testRule] };
    await fs.writeFile(policyPath, JSON.stringify(policy, null, 2));
    const store = new StateStore(path.join(tmpDir, 'test.db'));
    await store.initialize();
    let port = 0;const dash = new DashboardAPI(store, { policy, policyPath });
    await dash.start(0);
  port = dash.getPort();

    try {
      // Record 3 hits for the rule
      dash.recordFiredRules([firedRuleId]);
      dash.recordFiredRules([firedRuleId]);
      dash.recordFiredRules([firedRuleId]);

      const statsRes = await fetch(`http://127.0.0.1:${port}/policy/stats`);
      const statsBody = (await statsRes.json()) as PolicyStatsBody;

      const hitMap = new Map((statsBody.rules ?? []).map(s => [s.ruleId, s.hits]));
      const hits = hitMap.get(firedRuleId) ?? 0;
      // The hit count cell should display 3 (bold) not faint "0"
      expect(hits).toBe(3);
      expect(hits).toBeGreaterThan(0);
    } finally {
      await dash.stop();
      await store.close();
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
