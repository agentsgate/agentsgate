/**
 * Protection levels.
 *
 * The defaults were unusable for the case most people have: one person keeping
 * an agent from wrecking their own project. `git status` was blocked. So was
 * `npm test`. So was a one-row `UPDATE ... WHERE id = 1`. Writing a file needed
 * approval every time. Meanwhile the thing everyone actually fears —
 * `DROP TABLE` — was blocked too, so the signal was buried in the noise.
 *
 * Thresholds could not fix that on their own: `DROP TABLE` (1.00) and
 * `SELECT * FROM users` (0.60) differ in kind, and raising the bar past the
 * SELECT also clears `DELETE FROM orders` (0.90). Levels act on the category.
 */
import { describe, it, expect } from 'vitest';
import { createPipeline } from '../src/modules/m1-proxy/index.js';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import { InterventionController } from '../src/modules/m7-intervention/index.js';
import {
  getProtectionLevel, resolveLevelAction, PROTECTION_LEVEL_NAMES, DEFAULT_PROTECTION_LEVEL,
} from '../src/protection-levels.js';
import type { MCPOperation, ProxyDecision } from '../src/types/interfaces.js';

function pipelineAt(level?: string): (op: Partial<MCPOperation>) => Promise<ProxyDecision> {
  const p = createPipeline({
    riskEngine: new RiskScoringEngine(),
    interventionController: new InterventionController({ allowBelow: 0.3, blockAtOrAbove: 0.7 }),
    ...(level ? { protectionLevel: getProtectionLevel(level)! } : {}),
  });
  return over => p.evaluateRisk!({
    id: 'op', agentId: 'a', tool: 'filesystem', method: 'read_file', params: {},
    timestamp: new Date(), sessionId: 's', ...over,
  } as MCPOperation);
}

const CASES = {
  gitStatus:   { tool: 'shell', method: 'execute', params: { command: 'git status' } },
  writeFile:   { tool: 'filesystem', method: 'write_file', params: { path: '/app/x.ts', content: 'x' } },
  deleteFile:  { tool: 'filesystem', method: 'delete_file', params: { path: '/app/x.ts' } },
  envWrite:    { tool: 'filesystem', method: 'write_file', params: { path: '/app/.env', content: 'K=1' } },
  rowUpdate:   { tool: 'database', method: 'execute', params: { sql: 'UPDATE orders SET status=1 WHERE id=1' } },
  readUsers:   { tool: 'database', method: 'query', params: { sql: 'SELECT * FROM users' } },
  dropTable:   { tool: 'database', method: 'execute_ddl', params: { sql: 'DROP TABLE orders' } },
  deleteAll:   { tool: 'database', method: 'execute', params: { sql: 'DELETE FROM orders' } },
  sendMail:    { tool: 'gmail', method: 'send_email', params: { to: 'a@b.c' } },
  deleteMail:  { tool: 'gmail', method: 'delete_email', params: { id: '1' } },
} as const;

describe('the level table', () => {
  it('offers three levels and defaults to balanced', () => {
    expect(PROTECTION_LEVEL_NAMES).toEqual(['minimal', 'balanced', 'strict']);
    expect(DEFAULT_PROTECTION_LEVEL).toBe('balanced');
  });

  it('is case-insensitive and rejects anything else', () => {
    expect(getProtectionLevel('BALANCED')?.name).toBe('balanced');
    expect(getProtectionLevel('paranoid')).toBeUndefined();
  });

  it('takes the strictest category when several fire', () => {
    const strict = getProtectionLevel('balanced')!;
    expect(resolveLevelAction(strict, ['write_update', 'credential'])).toBe('block');
    expect(resolveLevelAction(strict, ['read', 'outbound_delete'])).toBe('require_approval');
    expect(resolveLevelAction(strict, ['read'])).toBe('allow');
  });

  it('leaves the decision to the thresholds when nothing fired', () => {
    expect(resolveLevelAction(getProtectionLevel('balanced')!, [])).toBeNull();
  });

  it('never lets wholesale destruction through, at any level', () => {
    for (const name of PROTECTION_LEVEL_NAMES) {
      const level = getProtectionLevel(name)!;
      expect(level.categories.destructive, name).toBe('block');
      expect(level.categories.injection, name).toBe('block');
    }
  });
});

describe('balanced — the default', () => {
  const run = pipelineAt('balanced');

  it('gets out of the way for everyday work', async () => {
    for (const key of ['gitStatus', 'writeFile', 'rowUpdate', 'readUsers'] as const) {
      expect((await run(CASES[key])).action, key).toBe('allow');
    }
  });

  it('still refuses to wipe data', async () => {
    expect((await run(CASES.dropTable)).action).toBe('block');
    expect((await run(CASES.deleteAll)).action).toBe('block');
  });

  it('still refuses to touch credentials', async () => {
    expect((await run(CASES.envWrite)).action).toBe('block');
  });

  it('asks before deleting something outside, where there is no undo', async () => {
    expect((await run(CASES.deleteMail)).action).toBe('require_approval');
  });

  it('does not ask before deleting a file — a checkpoint covers that', async () => {
    expect((await run(CASES.deleteFile)).action).toBe('allow');
  });

  it('sends without asking', async () => {
    expect((await run(CASES.sendMail)).action).toBe('allow');
  });

  it('says which level decided, so the log explains itself', async () => {
    const d = await run(CASES.gitStatus);
    expect(d.reasons.join(' ')).toMatch(/balanced/);
  });
});

describe('minimal', () => {
  const run = pipelineAt('minimal');

  it('stops only wholesale destruction', async () => {
    expect((await run(CASES.dropTable)).action).toBe('block');
    expect((await run(CASES.deleteAll)).action).toBe('block');
  });

  it('runs everything else, credentials and deletes included', async () => {
    for (const key of ['gitStatus', 'writeFile', 'deleteFile', 'envWrite', 'readUsers', 'deleteMail'] as const) {
      expect((await run(CASES[key])).action, key).toBe('allow');
    }
  });
});

describe('strict', () => {
  const run = pipelineAt('strict');

  it('still lets adding and updating through', async () => {
    expect((await run(CASES.writeFile)).action).toBe('allow');
    expect((await run(CASES.rowUpdate)).action).toBe('allow');
  });

  it('asks before reading personal data, deleting, or sending', async () => {
    expect((await run(CASES.readUsers)).action).toBe('require_approval');
    expect((await run(CASES.deleteFile)).action).toBe('require_approval');
    expect((await run(CASES.sendMail)).action).toBe('require_approval');
    expect((await run(CASES.gitStatus)).action).toBe('require_approval');
  });

  it('blocks outbound deletion outright', async () => {
    expect((await run(CASES.deleteMail)).action).toBe('block');
  });
});

describe('with no level configured', () => {
  it('decides on thresholds alone, as before levels existed', async () => {
    const run = pipelineAt();
    expect((await run(CASES.gitStatus)).action).toBe('block');       // 0.80
    expect((await run(CASES.writeFile)).action).toBe('require_approval');  // 0.65
  });
});
