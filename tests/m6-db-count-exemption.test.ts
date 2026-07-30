/**
 * A SELECT that can only return a row count is not exfiltration.
 *
 * `L1_DB_EXFIL` fires on any SELECT naming a sensitive table, which put
 * `SELECT count(*) FROM users` — a query that reveals one number and no column
 * values — behind an approval prompt. This exempts counting, and only counting.
 *
 * The exemption is an allowlist for a reason. Plenty of things look like
 * aggregates and hand back the data:
 *
 *   max(password)                  the largest password, verbatim
 *   group_concat(email)            every email, in one string  (SQLite, MySQL)
 *   string_agg / array_agg         the same  (PostgreSQL)
 *   mode() WITHIN GROUP            the most common value
 *   sum(balance) WHERE id = 42     one person's balance, exactly
 *
 * `sum` and `avg` are excluded for that last reason: narrowed to a single row
 * they report that row's value. `count` cannot — the worst it gives up is
 * whether a row exists.
 */
import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

const engine = new RiskScoringEngine();

async function score(sql: string, method = 'query'): Promise<{ score: number; rules: string[] }> {
  const op = {
    id: 'op', agentId: 'a', tool: 'agentsgate-pg-database', method,
    params: { sql }, timestamp: new Date(), sessionId: 's',
  } as MCPOperation;
  const r = await engine.assess(op);
  return { score: r.finalScore, rules: r.triggeredRules };
}

const EXFIL = 'L1_DB_EXFIL';

describe('counting rows in a sensitive table', () => {
  it('scores as a plain read', async () => {
    const { score: s, rules } = await score('SELECT count(*) FROM users');
    expect(rules).toContain('L1_DB_READ');
    expect(rules).not.toContain(EXFIL);
    expect(s).toBe(0.05);
  });

  it('is still a plain read with a WHERE clause', async () => {
    const { score: s } = await score("SELECT count(*) FROM users WHERE active = true");
    expect(s).toBe(0.05);
  });

  it('accepts the usual spellings', async () => {
    for (const sql of [
      'SELECT COUNT(*) FROM users',
      'select count(*) from users',
      'SELECT count(1) FROM users',
      'SELECT count(id) FROM users',
      'SELECT count(DISTINCT email) FROM users',
      'SELECT count(*) AS total FROM users',
      'SELECT   count( * )   FROM   users',
      'SELECT count(*), count(DISTINCT id) FROM users',
      'SELECT count(*) FROM (SELECT * FROM users) t',
    ]) {
      expect(await score(sql), sql).toMatchObject({ score: 0.05 });
    }
  });
});

describe('what the exemption must not cover', () => {
  it('still flags a SELECT that returns columns', async () => {
    for (const sql of [
      'SELECT * FROM users',
      'SELECT email FROM users',
      'SELECT count(*), email FROM users GROUP BY email',
      'SELECT id, count(*) FROM users GROUP BY id',
    ]) {
      const { rules } = await score(sql);
      expect(rules, sql).toContain(EXFIL);
    }
  });

  it('still flags aggregates that hand back column values', async () => {
    for (const sql of [
      'SELECT max(password) FROM users',
      'SELECT min(email) FROM users',
      'SELECT group_concat(email) FROM users',
      "SELECT string_agg(email, ',') FROM users",
      'SELECT array_agg(email) FROM users',
      'SELECT json_agg(u) FROM users u',
      'SELECT any_value(password) FROM users',
      'SELECT mode() WITHIN GROUP (ORDER BY password) FROM users',
    ]) {
      const { rules } = await score(sql);
      expect(rules, sql).toContain(EXFIL);
    }
  });

  it('still flags sum and avg, which report a single row narrowed by WHERE', async () => {
    // SELECT sum(balance) FROM users WHERE id = 42 is that user's balance.
    const { rules } = await score('SELECT sum(balance) FROM users WHERE id = 42');
    expect(rules).toContain(EXFIL);
    expect((await score('SELECT avg(salary) FROM users')).rules).toContain(EXFIL);
  });

  it('still flags a count with data smuggled alongside it', async () => {
    for (const sql of [
      'SELECT count(*) FROM users UNION SELECT password FROM users',
      'SELECT count(*), (SELECT password FROM users LIMIT 1) FROM users',
      'SELECT count(*) FROM users GROUP BY password',
    ]) {
      const { rules } = await score(sql);
      expect(rules, sql).toContain(EXFIL);
    }
  });

  it('leaves every other database rule alone', async () => {
    // The exemption applies to the exfil rule, not to destructive SQL.
    expect((await score('SELECT count(*) FROM users;')).rules).toContain('L1_DB_BATCH_DESTROY');
    expect((await score('DROP TABLE users', 'execute_ddl')).rules).toContain('L1_DB_DROP');
    expect((await score('DELETE FROM users', 'execute')).rules).toContain('L1_DB_DELETE_NO_WHERE');
  });
});

describe('non-sensitive tables are unaffected', () => {
  it('counts and reads alike stay at the read score', async () => {
    expect((await score('SELECT count(*) FROM orders')).score).toBe(0.05);
    expect((await score('SELECT * FROM orders')).score).toBe(0.05);
  });
});
