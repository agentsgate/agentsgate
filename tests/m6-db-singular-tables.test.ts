/**
 * A singular table name is as sensitive as a plural one.
 *
 * `L1_DB_EXFIL` searched the whole SQL string for words like `users` or
 * `password`. That list carries a singular form for almost every concept —
 * `password`, `token`, `secret` — but deliberately not for `user`, because as a
 * substring it would hit `user_id` and `username` in any ordinary query.
 *
 * The result was that `SELECT * FROM user` scored 0.05 while
 * `SELECT * FROM users` scored 0.60, on identical data. Schemas that name
 * tables in the singular — Django, JPA and Prisma conventions among them — got
 * no protection at all.
 *
 * The fix reads table names out of their position after FROM and JOIN, where
 * `user` cannot be confused with a column, and leaves the whole-text search in
 * place so a sensitive *column* name still counts.
 */
import { describe, it, expect } from 'vitest';
import { RiskScoringEngine } from '../src/modules/m6-risk/index.js';
import type { MCPOperation } from '../src/types/interfaces.js';

const engine = new RiskScoringEngine();
const EXFIL = 'L1_DB_EXFIL';

async function rules(sql: string): Promise<string[]> {
  const r = await engine.assess({
    id: 'op', agentId: 'a', tool: 'agentsgate-pg-database', method: 'query',
    params: { sql }, timestamp: new Date(), sessionId: 's',
  } as MCPOperation);
  return r.triggeredRules;
}

const flags = async (sql: string): Promise<boolean> => (await rules(sql)).includes(EXFIL);

describe('singular table names', () => {
  it('are treated like the plural', async () => {
    expect(await flags('SELECT * FROM user')).toBe(true);
    expect(await flags('SELECT * FROM users')).toBe(true);
  });

  it('are found through quoting and schema prefixes', async () => {
    for (const sql of [
      'SELECT * FROM public.user',
      'SELECT * FROM "user"',
      'SELECT * FROM `user`',
      'SELECT * FROM [user]',
      'SELECT * FROM user u',
      'SELECT * FROM user AS u',
      'SELECT * FROM orders, user',
      'SELECT * FROM orders JOIN user ON orders.uid = user.id',
      'SELECT * FROM   USER',
    ]) {
      expect(await flags(sql), sql).toBe(true);
    }
  });

  it('are found as one component of a compound name', async () => {
    expect(await flags('SELECT * FROM user_accounts')).toBe(true);
    expect(await flags('SELECT * FROM app_user')).toBe(true);
    expect(await flags('SELECT * FROM auth_token')).toBe(true);
  });
});

describe('what must not start matching', () => {
  it('leaves a column named user_id alone', async () => {
    // The whole point of keeping `user` out of the text search.
    expect(await flags('SELECT user_id FROM orders')).toBe(false);
    expect(await flags('SELECT username FROM profiles')).toBe(false);
    expect(await flags('SELECT o.user_id, o.total FROM orders o')).toBe(false);
  });

  it('leaves unrelated tables alone', async () => {
    expect(await flags('SELECT * FROM orders')).toBe(false);
    expect(await flags('SELECT * FROM inventory')).toBe(false);
  });

  it('keeps the count exemption', async () => {
    expect(await flags('SELECT count(*) FROM user')).toBe(false);
    expect(await flags('SELECT count(*) FROM user_accounts')).toBe(false);
  });
});

describe('the existing whole-text search still applies', () => {
  it('flags a sensitive column even on an unremarkable table', async () => {
    expect(await flags('SELECT password FROM accounts')).toBe(true);
    expect(await flags('SELECT ssn FROM records')).toBe(true);
  });
});
