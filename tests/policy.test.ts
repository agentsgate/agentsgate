import { describe, it, expect } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  matchRule,
  evaluatePolicyScore,
  evaluatePolicyAction,
  loadPolicy,
  savePolicy,
  type PolicyRule,
  type AgentsGatePolicy,
} from '../src/policy.js';
import type { MCPOperation } from '../src/types/interfaces.js';

// ── Test fixtures ─────────────────────────────────────────────────────────────

function makeOp(overrides: Partial<MCPOperation> = {}): MCPOperation {
  return {
    id: 'op-test',
    agentId: 'test-agent',
    tool: 'filesystem',
    method: 'write_file',
    params: { path: '/home/user/notes.txt' },
    timestamp: new Date(),
    sessionId: 'session-1',
    ...overrides,
  };
}

// ── matchRule ─────────────────────────────────────────────────────────────────

describe('matchRule', () => {
  it('matches when all specified fields are exact', () => {
    const rule: PolicyRule = {
      id: 'R1',
      match: { tool: 'filesystem', method: 'write_file' },
    };
    expect(matchRule(rule, makeOp())).toBe(true);
  });

  it('returns false when a field does not match', () => {
    const rule: PolicyRule = {
      id: 'R2',
      match: { tool: 'database' },
    };
    expect(matchRule(rule, makeOp())).toBe(false);
  });

  it('matches tool via /regex/ syntax', () => {
    const rule: PolicyRule = {
      id: 'R3',
      match: { tool: '/file|fs/' },
    };
    expect(matchRule(rule, makeOp({ tool: 'filesystem' }))).toBe(true);
    expect(matchRule(rule, makeOp({ tool: 'fs' }))).toBe(true);
    expect(matchRule(rule, makeOp({ tool: 'database' }))).toBe(false);
  });

  it('matches method via /regex/ syntax case-insensitively', () => {
    const rule: PolicyRule = {
      id: 'R4',
      match: { method: '/DELETE|REMOVE/' },
    };
    expect(matchRule(rule, makeOp({ method: 'delete_record' }))).toBe(true);
    expect(matchRule(rule, makeOp({ method: 'write_file' }))).toBe(false);
  });

  it('matches agentId exactly', () => {
    const rule: PolicyRule = {
      id: 'R5',
      match: { agentId: 'readonly-agent' },
    };
    expect(matchRule(rule, makeOp({ agentId: 'readonly-agent' }))).toBe(true);
    expect(matchRule(rule, makeOp({ agentId: 'other-agent' }))).toBe(false);
  });

  it('matches pathPattern against params.path', () => {
    const rule: PolicyRule = {
      id: 'R6',
      match: { pathPattern: '\\.env' }, // raw regex: matches literal ".env"
    };
    expect(matchRule(rule, makeOp({ params: { path: '/home/user/.env' } }))).toBe(true);
    expect(matchRule(rule, makeOp({ params: { path: '/home/user/notes.txt' } }))).toBe(false);
  });

  it('matches pathPattern against params.filePath', () => {
    const rule: PolicyRule = {
      id: 'R7',
      match: { pathPattern: 'secrets' },
    };
    expect(matchRule(rule, makeOp({ params: { filePath: '/etc/secrets/key.pem' } }))).toBe(true);
  });

  it('applies AND logic — all specified fields must match', () => {
    const rule: PolicyRule = {
      id: 'R8',
      match: { tool: 'filesystem', method: 'delete_file', agentId: 'agent-x' },
    };
    // Tool and method match but agentId differs
    expect(matchRule(rule, makeOp({ tool: 'filesystem', method: 'delete_file', agentId: 'other' }))).toBe(false);
    // All three match
    expect(matchRule(rule, makeOp({ tool: 'filesystem', method: 'delete_file', agentId: 'agent-x' }))).toBe(true);
  });

  it('empty match {} matches everything', () => {
    const rule: PolicyRule = { id: 'R9', match: {} };
    expect(matchRule(rule, makeOp())).toBe(true);
  });

  it('returns false on invalid regex in pathPattern', () => {
    const rule: PolicyRule = {
      id: 'R10',
      match: { pathPattern: '[invalid' },
    };
    expect(matchRule(rule, makeOp())).toBe(false);
  });
});

// ── evaluatePolicyScore ───────────────────────────────────────────────────────

describe('evaluatePolicyScore', () => {
  it('returns null when no rules match', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tool: 'database' }, score: 0.9 }],
    };
    expect(evaluatePolicyScore(policy, makeOp({ tool: 'filesystem' }))).toBeNull();
  });

  it('returns the score from the first matching rule', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'R1', match: { agentId: 'trusted-agent' }, score: 0.05 },
        { id: 'R2', match: { tool: 'filesystem' }, score: 0.8 },
      ],
    };
    // Both match, but R1 is first
    expect(evaluatePolicyScore(policy, makeOp({ agentId: 'trusted-agent' }))).toBe(0.05);
  });

  it('skips rules with no score field', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'R1', match: { tool: 'filesystem' }, action: 'block' }, // no score
        { id: 'R2', match: { tool: 'filesystem' }, score: 0.7 },
      ],
    };
    expect(evaluatePolicyScore(policy, makeOp())).toBe(0.7);
  });

  it('clamps score to [0, 1]', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: {}, score: 1.5 }],
    };
    expect(evaluatePolicyScore(policy, makeOp())).toBe(1.0);
  });

  it('returns null for empty policy', () => {
    const policy: AgentsGatePolicy = { rules: [] };
    expect(evaluatePolicyScore(policy, makeOp())).toBeNull();
  });
});

// ── evaluatePolicyAction ──────────────────────────────────────────────────────

describe('evaluatePolicyAction', () => {
  it('returns null when no rules match', () => {
    const policy: AgentsGatePolicy = {
      rules: [{ id: 'R1', match: { tool: 'database' }, action: 'block' }],
    };
    expect(evaluatePolicyAction(policy, makeOp({ tool: 'filesystem' }))).toBeNull();
  });

  it('returns the action from the first matching rule', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'R1', match: { method: '/delete/' }, action: 'block' },
        { id: 'R2', match: { tool: 'filesystem' }, action: 'allow' },
      ],
    };
    expect(evaluatePolicyAction(policy, makeOp({ method: 'delete_file' }))).toBe('block');
    expect(evaluatePolicyAction(policy, makeOp({ method: 'write_file' }))).toBe('allow');
  });

  it('skips rules with no action field', () => {
    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'R1', match: { tool: 'filesystem' }, score: 0.9 }, // no action
        { id: 'R2', match: { tool: 'filesystem' }, action: 'require_approval' },
      ],
    };
    expect(evaluatePolicyAction(policy, makeOp())).toBe('require_approval');
  });

  it('returns null for empty policy', () => {
    const policy: AgentsGatePolicy = { rules: [] };
    expect(evaluatePolicyAction(policy, makeOp())).toBeNull();
  });
});

// ── loadPolicy / savePolicy ───────────────────────────────────────────────────

describe('loadPolicy', () => {
  it('returns empty policy when file does not exist', async () => {
    const policy = await loadPolicy('/nonexistent/policy.json');
    expect(policy.rules).toEqual([]);
    expect(policy.thresholds).toBeUndefined();
  });

  it('loads and parses a policy file', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-policy-${Date.now()}.json`);
    const data: AgentsGatePolicy = {
      rules: [
        { id: 'BLOCK_PROD', match: { tool: 'database' }, action: 'block' },
      ],
      thresholds: { allowBelow: 0.2, blockAtOrAbove: 0.85 },
    };
    await fs.writeFile(tmpFile, JSON.stringify(data));

    const policy = await loadPolicy(tmpFile);
    expect(policy.rules).toHaveLength(1);
    expect(policy.rules[0].id).toBe('BLOCK_PROD');
    expect(policy.thresholds?.allowBelow).toBe(0.2);
    expect(policy.thresholds?.blockAtOrAbove).toBe(0.85);

    await fs.unlink(tmpFile);
  });

  it('defaults rules to [] when file has no rules key', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-policy-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({ thresholds: { allowBelow: 0.1 } }));
    const policy = await loadPolicy(tmpFile);
    expect(policy.rules).toEqual([]);
    await fs.unlink(tmpFile);
  });
});

describe('savePolicy', () => {
  it('round-trips a policy through save + load', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-policy-${Date.now()}.json`);
    const original: AgentsGatePolicy = {
      rules: [
        { id: 'R1', match: { tool: '/fs|filesystem/' }, score: 0.8, action: 'require_approval' },
      ],
      thresholds: { blockAtOrAbove: 0.9 },
    };
    await savePolicy(original, tmpFile);
    const loaded = await loadPolicy(tmpFile);
    expect(loaded.rules[0].id).toBe('R1');
    expect(loaded.rules[0].score).toBe(0.8);
    expect(loaded.thresholds?.blockAtOrAbove).toBe(0.9);
    await fs.unlink(tmpFile);
  });
});

// ── Pipeline integration ──────────────────────────────────────────────────────

describe('policy integration with createPipeline', () => {
  it('policy score override replaces L1 static score in decision', async () => {
    const { createPipeline } = await import('../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../src/modules/m7-intervention/index.js');

    const policy: AgentsGatePolicy = {
      rules: [
        // Trust reads from this specific agent — score 0.01 (below allowBelow=0.3 → allow)
        { id: 'TRUST_READ_AGENT', match: { agentId: 'trusted-reader' }, score: 0.01 },
      ],
    };

    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy,
    });

    // Without policy, a delete would score ~0.9 → block
    // With policy override score 0.01, it should be allowed
    const op = makeOp({ agentId: 'trusted-reader', method: 'delete_file' });
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.action).toBe('allow');
    expect(decision.riskScore).toBeLessThan(0.3);
  });

  it('policy action override forces block regardless of low score', async () => {
    const { createPipeline } = await import('../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../src/modules/m7-intervention/index.js');

    const policy: AgentsGatePolicy = {
      rules: [
        // Always block any operation touching /production/
        { id: 'BLOCK_PRODUCTION', match: { pathPattern: 'production' }, action: 'block' },
      ],
    };

    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy,
    });

    // read_file would normally be low risk (0.05) → allow, but policy forces block
    const op = makeOp({
      method: 'read_file',
      params: { path: '/production/config.yaml' },
    });
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.action).toBe('block');
    expect(decision.reasons.some(r => r.includes('Policy rule forced action'))).toBe(true);
  });

  it('policy has no effect when no rules match', async () => {
    const { createPipeline } = await import('../src/modules/m1-proxy/index.js');
    const { RiskScoringEngine } = await import('../src/modules/m6-risk/index.js');
    const { InterventionController } = await import('../src/modules/m7-intervention/index.js');

    const policy: AgentsGatePolicy = {
      rules: [
        { id: 'DATABASE_ONLY', match: { tool: 'database' }, action: 'block' },
      ],
    };

    const pipeline = createPipeline({
      riskEngine: new RiskScoringEngine(),
      interventionController: new InterventionController(),
      policy,
    });

    // read_file on filesystem — policy rule only matches 'database', so no override
    const op = makeOp({ method: 'read_file', tool: 'filesystem' });
    const decision = await pipeline.evaluateRisk!(op);
    expect(decision.action).toBe('allow'); // normal L1 logic: read → 0.05 → allow
  });

  it('policy thresholds applied at InterventionController construction', async () => {
    const { InterventionController } = await import('../src/modules/m7-intervention/index.js');
    // Tighter thresholds: allowBelow=0.1, blockAtOrAbove=0.5
    const ctrl = new InterventionController({ allowBelow: 0.1, blockAtOrAbove: 0.5 });
    // A score of 0.15 would be 'allow' with defaults (allowBelow=0.3) but 'require_approval' with tighter thresholds
    const fakeAssessment = {
      operationId: 'x',
      staticScore: 0.15,
      userHistoryScore: -1,
      communityScore: -1,
      finalScore: 0.15,
      triggeredRules: [] as string[],
      assessedAt: new Date(),
    };
    const d = await ctrl.decide(fakeAssessment);
    expect(d.action).toBe('require_approval');
  });
});
