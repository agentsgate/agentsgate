import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../../src/types/interfaces.js';

function makeOp(tool: string, method: string, params: Record<string, unknown> = {}): MCPOperation {
  return {
    id: 'op-test',
    agentId: 'agent-1',
    tool,
    method,
    params,
    timestamp: new Date(),
    sessionId: 'session-1',
  };
}

describe('RiskScoringEngine', () => {
  const engine = new RiskScoringEngine();

  it('should return high staticScore for delete_file operations', async () => {
    const result = await engine.assess(makeOp('filesystem', 'delete_file', { path: '/tmp/x.txt' }));

    expect(result.staticScore).toBeGreaterThanOrEqual(0.85);
    expect(result.finalScore).toBeGreaterThanOrEqual(0.85);
    expect(result.triggeredRules).toContain('L1_DELETE_FILE');
  });

  it('should return high staticScore for writes to sensitive paths (.env, ~/.ssh)', async () => {
    const envResult = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/project/.env' })
    );
    expect(envResult.staticScore).toBeGreaterThanOrEqual(0.85);
    expect(envResult.triggeredRules).toContain('L1_SENSITIVE_PATH_WRITE');

    const sshResult = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/home/user/.ssh/id_rsa' })
    );
    expect(sshResult.staticScore).toBeGreaterThanOrEqual(0.85);
    expect(sshResult.triggeredRules).toContain('L1_SENSITIVE_PATH_WRITE');
  });

  it('should return low staticScore for read-only operations', async () => {
    const readResult = await engine.assess(makeOp('filesystem', 'read_file', { path: '/tmp/x.txt' }));
    expect(readResult.staticScore).toBeLessThanOrEqual(0.1);
    expect(readResult.triggeredRules).toContain('L1_READ_ONLY');

    const listResult = await engine.assess(makeOp('filesystem', 'list_directory', { path: '/tmp' }));
    expect(listResult.staticScore).toBeLessThanOrEqual(0.1);

    const getResult = await engine.assess(makeOp('database', 'get_record', { table: 'users', id: 1 }));
    expect(getResult.staticScore).toBeLessThanOrEqual(0.1);
  });

  it('should include triggered rule IDs in the assessment', async () => {
    const result = await engine.assess(makeOp('database', 'drop_table', { table: 'users' }));

    expect(result.triggeredRules).toBeInstanceOf(Array);
    expect(result.triggeredRules.length).toBeGreaterThan(0);
    expect(result.triggeredRules).toContain('L1_DROP_TABLE');
    expect(result.staticScore).toBeGreaterThanOrEqual(0.9);
  });

  it('should return -1 for userHistoryScore when history is insufficient', async () => {
    const result = await engine.assess(makeOp('filesystem', 'read_file'));
    expect(result.userHistoryScore).toBe(-1);
  });

  it('should return -1 for communityScore when opt-in is disabled', async () => {
    const result = await engine.assess(makeOp('filesystem', 'read_file'));
    expect(result.communityScore).toBe(-1);
    // finalScore should equal staticScore when only L1 is available
    expect(result.finalScore).toBeCloseTo(result.staticScore, 5);
    expect(result.assessedAt).toBeInstanceOf(Date);
  });

  it('should score writes to sensitive file types (.pem, .key, .crt) as high risk', async () => {
    const pemResult = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/certs/server.pem' })
    );
    expect(pemResult.staticScore).toBeGreaterThanOrEqual(0.7);
    expect(pemResult.triggeredRules).toContain('L1_SENSITIVE_FILE_TYPE');

    const keyResult = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/keys/private.key' })
    );
    expect(keyResult.staticScore).toBeGreaterThanOrEqual(0.7);
    expect(keyResult.triggeredRules).toContain('L1_SENSITIVE_FILE_TYPE');

    const crtResult = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/certs/ca.crt' })
    );
    expect(crtResult.staticScore).toBeGreaterThanOrEqual(0.7);
    expect(crtResult.triggeredRules).toContain('L1_SENSITIVE_FILE_TYPE');
  });

  it('should NOT fire L1_SENSITIVE_FILE_TYPE for read-only operations', async () => {
    const result = await engine.assess(
      makeOp('filesystem', 'read_file', { path: '/certs/server.pem' })
    );
    expect(result.triggeredRules).not.toContain('L1_SENSITIVE_FILE_TYPE');
    expect(result.triggeredRules).toContain('L1_READ_ONLY');
  });

  it('should NOT fire L1_SENSITIVE_FILE_TYPE for ordinary extensions', async () => {
    const result = await engine.assess(
      makeOp('filesystem', 'write_file', { path: '/src/app.ts' })
    );
    expect(result.triggeredRules).not.toContain('L1_SENSITIVE_FILE_TYPE');
  });
});
