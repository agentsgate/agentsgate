/**
 * T437 — Unit tests for getL1RulesSnapshot()
 *
 * Verifies that the exported function returns serializable rule metadata
 * (id, score, description) for all known L1 rules, with no `matches` function
 * present in the results.
 */

import { describe, it, expect } from 'vitest';
import { getL1RulesSnapshot } from '../src/modules/m6-risk/index.js';
import type { L1RuleSnapshot } from '../src/modules/m6-risk/index.js';

// The full set of rule IDs expected in L1_RULES (as defined in m6-risk/index.ts)
const EXPECTED_RULE_IDS = [
  'L1_DELETE_FILE',
  'L1_OVERWRITE_FILE',
  'L1_SENSITIVE_PATH_WRITE',
  'L1_DROP_TABLE',
  'L1_DELETE_RECORD',
  'L1_EXECUTE_COMMAND',
  'L1_GIT_FORCE_PUSH',
  'L1_SLACK_SEND',
  'L1_SLACK_DELETE',
  'L1_SLACK_READ',
  'L1_GCAL_CREATE',
  'L1_GCAL_UPDATE',
  'L1_GCAL_DELETE',
  'L1_GCAL_READ',
  'L1_GMAIL_SEND',
  'L1_GMAIL_DELETE',
  'L1_GMAIL_DRAFT',
  'L1_GMAIL_READ',
  'L1_SENSITIVE_FILE_TYPE',
  'L1_READ_ONLY',
  'L1_DB_DROP',
  'L1_DB_TRUNCATE',
  'L1_DB_DELETE_NO_WHERE',
  'L1_DB_UPDATE_NO_WHERE',
  'L1_DB_DDL',
  'L1_DB_EXECUTE',
  'L1_DB_READ',
  'L1_DB_RESTORE',
  'L1_DB_EXFIL',
  'L1_DB_BATCH_DESTROY',
];

describe('T437 — getL1RulesSnapshot() unit tests', () => {
  it('1. returns an array', () => {
    const snapshot = getL1RulesSnapshot();
    expect(Array.isArray(snapshot)).toBe(true);
  });

  it('2. array is non-empty', () => {
    const snapshot = getL1RulesSnapshot();
    expect(snapshot.length).toBeGreaterThan(0);
  });

  it('3. each object has id, score, description fields', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      expect(rule).toHaveProperty('id');
      expect(rule).toHaveProperty('score');
      expect(rule).toHaveProperty('description');
    }
  });

  it('4. id is a non-empty string for every rule', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      expect(typeof rule.id).toBe('string');
      expect(rule.id.length).toBeGreaterThan(0);
    }
  });

  it('5. score is a number between 0 and 1 (inclusive) for every rule', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      expect(typeof rule.score).toBe('number');
      expect(rule.score).toBeGreaterThanOrEqual(0);
      expect(rule.score).toBeLessThanOrEqual(1);
    }
  });

  it('6. description is a non-empty string for every rule', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      expect(typeof rule.description).toBe('string');
      expect(rule.description.length).toBeGreaterThan(0);
    }
  });

  it('7. no `matches` function present in returned objects (serializable)', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      expect((rule as Record<string, unknown>)['matches']).toBeUndefined();
    }
  });

  it('8. all known rule IDs are present', () => {
    const snapshot = getL1RulesSnapshot();
    const ids = snapshot.map((r: L1RuleSnapshot) => r.id);
    for (const expectedId of EXPECTED_RULE_IDS) {
      expect(ids).toContain(expectedId);
    }
  });

  it('9. no extra unknown keys beyond id, score, description', () => {
    const snapshot = getL1RulesSnapshot();
    for (const rule of snapshot) {
      const keys = Object.keys(rule);
      expect(keys.sort()).toEqual(['description', 'id', 'score'].sort());
    }
  });

  it('10. returns a new array each call (not a reference leak)', () => {
    const snap1 = getL1RulesSnapshot();
    const snap2 = getL1RulesSnapshot();
    expect(snap1).not.toBe(snap2);
  });

  it('11. returned objects are independent copies (mutation does not affect next call)', () => {
    const snap1 = getL1RulesSnapshot();
    // Mutate the first result
    (snap1[0] as Record<string, unknown>)['score'] = 9999;
    const snap2 = getL1RulesSnapshot();
    // Score in new snapshot should be the original value, not 9999
    expect(snap2[0]!.score).toBeLessThanOrEqual(1);
  });

  it('12. snapshot length matches expected rule count', () => {
    const snapshot = getL1RulesSnapshot();
    expect(snapshot.length).toBe(EXPECTED_RULE_IDS.length);
  });

  it('13. result is JSON-serializable (no circular references or functions)', () => {
    const snapshot = getL1RulesSnapshot();
    expect(() => JSON.stringify(snapshot)).not.toThrow();
    const parsed = JSON.parse(JSON.stringify(snapshot)) as L1RuleSnapshot[];
    expect(parsed.length).toBe(snapshot.length);
  });

  it('14. L1_DELETE_FILE has score >= 0.8 (high risk)', () => {
    const snapshot = getL1RulesSnapshot();
    const rule = snapshot.find(r => r.id === 'L1_DELETE_FILE');
    expect(rule).toBeDefined();
    expect(rule!.score).toBeGreaterThanOrEqual(0.8);
  });

  it('15. L1_GMAIL_SEND has score >= 0.8 (high risk)', () => {
    const snapshot = getL1RulesSnapshot();
    const rule = snapshot.find(r => r.id === 'L1_GMAIL_SEND');
    expect(rule).toBeDefined();
    expect(rule!.score).toBeGreaterThanOrEqual(0.8);
  });

  it('16. L1_SLACK_SEND has score between 0 and 1', () => {
    const snapshot = getL1RulesSnapshot();
    const rule = snapshot.find(r => r.id === 'L1_SLACK_SEND');
    expect(rule).toBeDefined();
    expect(rule!.score).toBeGreaterThan(0);
    expect(rule!.score).toBeLessThanOrEqual(1);
  });

  it('17. read-only rules (L1_READ_ONLY, L1_SLACK_READ, L1_GCAL_READ, L1_GMAIL_READ) have low scores (<= 0.15)', () => {
    const snapshot = getL1RulesSnapshot();
    const readOnlyIds = ['L1_READ_ONLY', 'L1_SLACK_READ', 'L1_GCAL_READ', 'L1_GMAIL_READ'];
    for (const id of readOnlyIds) {
      const rule = snapshot.find(r => r.id === id);
      expect(rule).toBeDefined();
      expect(rule!.score).toBeLessThanOrEqual(0.15);
    }
  });
});
