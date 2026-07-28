/**
 * T146 — Per-tool sliding-window rate limiter tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ToolRateLimiter } from '../../src/utils/rate-limiter.js';

describe('ToolRateLimiter', () => {
  let limiter: ToolRateLimiter;

  beforeEach(() => {
    limiter = new ToolRateLimiter(10); // 10 ops per 60s globally
  });

  it('allows operations under the global limit', () => {
    for (let i = 0; i < 10; i++) {
      expect(limiter.check('agent-1', 'shell')).toBe(true);
    }
  });

  it('blocks operations over the global limit', () => {
    for (let i = 0; i < 10; i++) limiter.check('agent-1', 'shell');
    expect(limiter.check('agent-1', 'shell')).toBe(false);
  });

  it('tracks (agentId, tool) pairs independently', () => {
    for (let i = 0; i < 10; i++) limiter.check('agent-1', 'shell');
    // Different tool for same agent — should still be allowed
    expect(limiter.check('agent-1', 'filesystem')).toBe(true);
    // Different agent for same tool — should still be allowed
    expect(limiter.check('agent-2', 'shell')).toBe(true);
  });

  it('applies per-tool override (exact match)', () => {
    limiter = new ToolRateLimiter(10, { shell: { maxOpsPerWindow: 3 } });
    expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(false);
    // filesystem still uses global limit
    for (let i = 0; i < 10; i++) expect(limiter.check('agent-1', 'filesystem')).toBe(true);
    expect(limiter.check('agent-1', 'filesystem')).toBe(false);
  });

  it('applies per-tool override via regex pattern', () => {
    limiter = new ToolRateLimiter(10, { '/shell|exec/': { maxOpsPerWindow: 2 } });
    expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(false);
    // exec also matched by regex
    expect(limiter.check('agent-1', 'exec')).toBe(true);
    expect(limiter.check('agent-1', 'exec')).toBe(true);
    expect(limiter.check('agent-1', 'exec')).toBe(false);
    // filesystem is unaffected
    expect(limiter.check('agent-1', 'filesystem')).toBe(true);
  });

  it('prefers exact match over regex when both could match', () => {
    limiter = new ToolRateLimiter(10, {
      shell: { maxOpsPerWindow: 5 },
      '/shell/': { maxOpsPerWindow: 1 },
    });
    // exact match → limit 5
    for (let i = 0; i < 5; i++) expect(limiter.check('agent-1', 'shell')).toBe(true);
    expect(limiter.check('agent-1', 'shell')).toBe(false);
  });

  it('getCount returns current window count', () => {
    limiter.check('agent-1', 'shell');
    limiter.check('agent-1', 'shell');
    expect(limiter.getCount('agent-1', 'shell')).toBe(2);
    expect(limiter.getCount('agent-1', 'filesystem')).toBe(0);
    expect(limiter.getCount('agent-2', 'shell')).toBe(0);
  });

  it('reset clears all timestamps', () => {
    for (let i = 0; i < 10; i++) limiter.check('agent-1', 'shell');
    expect(limiter.check('agent-1', 'shell')).toBe(false);
    limiter.reset();
    expect(limiter.check('agent-1', 'shell')).toBe(true);
  });

  it('accepts full ToolRateLimitConfig object as global', () => {
    limiter = new ToolRateLimiter({ maxOpsPerWindow: 2, windowMs: 60_000 });
    expect(limiter.check('a', 'tool')).toBe(true);
    expect(limiter.check('a', 'tool')).toBe(true);
    expect(limiter.check('a', 'tool')).toBe(false);
  });

  it('skips invalid regex patterns gracefully', () => {
    limiter = new ToolRateLimiter(5, { '/[invalid/': { maxOpsPerWindow: 1 } });
    // invalid regex falls through to global limit (5)
    for (let i = 0; i < 5; i++) expect(limiter.check('agent-1', '[invalid')).toBe(true);
    expect(limiter.check('agent-1', '[invalid')).toBe(false);
  });
});
