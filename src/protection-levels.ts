/**
 * Protection levels.
 *
 * Thresholds alone cannot express what most people actually want. `DROP TABLE`
 * scores 1.00 and `SELECT * FROM users` scores 0.60: they differ in *kind*, not
 * in degree, so raising the bar until the SELECT passes also lets
 * `DELETE FROM orders` (0.90) through. Someone protecting a hobby project from
 * an agent that deletes their database wants the first stopped and the second
 * ignored, and no single number does that.
 *
 * So every built-in rule carries a category, and a level says what to do with
 * each category. Levels are few and switch in one command, on the same
 * reasoning as an editor's permission modes: a control nobody can find is a
 * control nobody uses.
 */

/** What a rule is about, as opposed to how badly it scores. */
export type RuleCategory =
  | 'destructive'      // irreversible, wholesale: DROP, TRUNCATE, DELETE with no WHERE
  | 'injection'        // the shape of an attack rather than an operation
  | 'credential'       // keys, tokens, .env — reading or writing them
  | 'exfiltration'     // reading personal data
  | 'outbound_write'   // sending or creating something outside: email, messages, events
  | 'outbound_delete'  // deleting something outside, where there is no undo
  | 'write_create'     // adding
  | 'write_update'     // changing
  | 'write_delete'     // removing
  | 'exec'             // running arbitrary commands
  | 'read';            // looking

export type CategoryAction = 'allow' | 'require_approval' | 'block';

export type ProtectionLevelName = 'minimal' | 'balanced' | 'strict';

export interface ProtectionLevel {
  name: ProtectionLevelName;
  summary: string;
  categories: Record<RuleCategory, CategoryAction>;
}

const LEVELS: Record<ProtectionLevelName, ProtectionLevel> = {
  /**
   * Throwaway work: a scratch project, a local database you would not miss.
   * Still refuses to wipe a table, because nobody means that one.
   */
  minimal: {
    name: 'minimal',
    summary: 'Only wholesale destruction is stopped. Everything else runs.',
    categories: {
      destructive: 'block',
      injection: 'block',
      credential: 'allow',
      exfiltration: 'allow',
      outbound_write: 'allow',
      outbound_delete: 'allow',
      write_create: 'allow',
      write_update: 'allow',
      write_delete: 'allow',
      exec: 'allow',
      read: 'allow',
    },
  },

  /**
   * The default. An individual working on something real: the agent can write
   * code, run tests and edit rows, but it cannot wipe a table, read your keys,
   * or delete things you cannot get back.
   */
  balanced: {
    name: 'balanced',
    summary: 'Destruction and credentials are stopped; deletions need a yes. Ordinary work runs.',
    categories: {
      destructive: 'block',
      injection: 'block',
      credential: 'block',
      exfiltration: 'allow',
      outbound_write: 'allow',
      outbound_delete: 'require_approval',
      write_create: 'allow',
      write_update: 'allow',
      write_delete: 'require_approval',
      exec: 'allow',
      read: 'allow',
    },
  },

  /**
   * Real data that is not only yours: customer records, a shared environment.
   * Adding and updating still run — it is reading people's data and sending
   * things outward that now want a human.
   */
  strict: {
    name: 'strict',
    summary: 'Adds personal-data reads and outbound sends to what needs a human.',
    categories: {
      destructive: 'block',
      injection: 'block',
      credential: 'block',
      exfiltration: 'require_approval',
      outbound_write: 'require_approval',
      outbound_delete: 'block',
      write_create: 'allow',
      write_update: 'allow',
      write_delete: 'require_approval',
      exec: 'require_approval',
      read: 'allow',
    },
  },
};

export const PROTECTION_LEVEL_NAMES = Object.keys(LEVELS) as ProtectionLevelName[];

export const DEFAULT_PROTECTION_LEVEL: ProtectionLevelName = 'balanced';

export function getProtectionLevel(name: string): ProtectionLevel | undefined {
  return LEVELS[name.toLowerCase() as ProtectionLevelName];
}

const SEVERITY: Record<CategoryAction, number> = {
  allow: 0,
  require_approval: 1,
  block: 2,
};

/**
 * The action a level calls for, given the categories that fired.
 *
 * The strictest wins: an operation that both deletes a row and touches a
 * credential is treated as the credential case. Returns null when nothing
 * fired, leaving the ordinary threshold comparison to decide.
 */
export function resolveLevelAction(
  level: ProtectionLevel,
  categories: readonly RuleCategory[]
): CategoryAction | null {
  let strongest: CategoryAction | null = null;
  for (const category of categories) {
    const action = level.categories[category];
    if (action === undefined) continue;
    if (strongest === null || SEVERITY[action] > SEVERITY[strongest]) strongest = action;
  }
  return strongest;
}
