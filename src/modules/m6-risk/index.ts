import type { RuleCategory } from '../../protection-levels.js';
import type { MCPOperation, RiskAssessment, FiredRule } from '../../types/interfaces.js';

// ── L1 Static Rule definitions ────────────────────────────────────────────────

interface StaticRule {
  /**
   * What the rule is about, for protection levels. Two rules can share a score
   * and want different treatment — `DROP TABLE` and a personal-data SELECT are
   * not the same kind of thing.
   */
  category: RuleCategory;
  id: string;
  score: number;
  description: string;
  matches: (op: MCPOperation) => boolean;
}

/** Sensitive path patterns: files that must never be overwritten without review. */
const SENSITIVE_PATH_PATTERNS = [
  /\.env(\.|$)/i,
  /\.aws\//i,
  /\.ssh\//i,
  /credentials/i,
  /secret/i,
  /private[_-]?key/i,
  /id_rsa/i,
  /id_ed25519/i,
  /\.npmrc$/i,
  /\.netrc$/i,
];

/**
 * File extensions that warrant elevated risk when written/modified.
 * These are high-value target files (key material, config secrets, certs).
 */
const SENSITIVE_EXTENSIONS = /\.(env|pem|key|p12|pfx|crt|cer|jks|keystore|asc|gpg|ovpn|ppk)$/i;

function isSensitivePath(params: Record<string, unknown>): boolean {
  const p = params['path'] ?? params['filePath'] ?? params['file'] ?? '';
  const pathStr = String(p);
  return SENSITIVE_PATH_PATTERNS.some(re => re.test(pathStr));
}

function methodContains(op: MCPOperation, ...keywords: string[]): boolean {
  const m = op.method.toLowerCase();
  return keywords.some(k => m.includes(k));
}

function isReadOnly(op: MCPOperation): boolean {
  const m = op.method.toLowerCase();
  return (
    m.startsWith('read') ||
    m.startsWith('get') ||
    m.startsWith('list') ||
    m.startsWith('describe') ||
    m.startsWith('show') ||
    m.startsWith('fetch') ||
    m.startsWith('search') ||
    m.startsWith('find') ||
    m === 'stat' ||
    m === 'exists'
  );
}

/** Extract the SQL string from op.params if present. */
function getSql(op: MCPOperation): string {
  const s = op.params['sql'] ?? op.params['query'] ?? '';
  return String(s).toUpperCase().trim();
}

/** Returns true if the SQL text contains a word-boundary match for the keyword. */
function sqlContains(op: MCPOperation, keyword: string): boolean {
  const sql = getSql(op);
  if (!sql) return false;
  return new RegExp(`\\b${keyword}\\b`).test(sql);
}

/** Returns true if SQL is a DELETE without a WHERE clause. */
function sqlDeleteWithoutWhere(op: MCPOperation): boolean {
  const sql = getSql(op);
  if (!sql.startsWith('DELETE')) return false;
  return !/\bWHERE\b/.test(sql);
}

/** Returns true if SQL is an UPDATE without a WHERE clause. */
function sqlUpdateWithoutWhere(op: MCPOperation): boolean {
  const sql = getSql(op);
  if (!sql.startsWith('UPDATE')) return false;
  return !/\bWHERE\b/.test(sql);
}

/**
 * Sensitive words, searched for anywhere in the SQL — so a sensitive *column*
 * counts too, as in `SELECT password FROM accounts`.
 *
 * `user` is absent on purpose: as a substring it matches `user_id` and
 * `username`, which appear in perfectly ordinary queries. It is picked up by
 * table position instead, below.
 */
const SENSITIVE_SQL_WORDS =
  /\b(users|passwords|password|tokens|token|secrets|secret|credentials|credential|api_keys|api_key|auth_tokens|auth_token|private_keys|private_key|billing|ssn|payment|credit_card)\b/i;

/** The same concepts in singular base form, for matching a table name. */
const SENSITIVE_TABLE_WORDS = new Set([
  'user', 'password', 'token', 'secret', 'credential',
  'api_key', 'auth_token', 'private_key',
  'billing', 'ssn', 'payment', 'credit_card',
]);

/**
 * Table names as they appear after FROM or JOIN, stripped of schema prefix,
 * quoting and alias: `public."User" AS u` → `USER`.
 */
const TABLE_LIST_END =
  /\b(WHERE|GROUP|ORDER|LIMIT|HAVING|UNION|INTERSECT|EXCEPT|JOIN|ON|USING|INNER|LEFT|RIGHT|FULL|CROSS|WINDOW|OFFSET|FETCH|FOR)\b/;

function sqlTableNames(sql: string): string[] {
  const names: string[] = [];
  const re = /\b(?:FROM|JOIN)\s+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    let list = sql.slice(m.index + m[0].length);
    const end = list.search(TABLE_LIST_END);
    if (end >= 0) list = list.slice(0, end);
    // `orders o, public."User" AS u` → one entry per comma; the table is the
    // first token of each, and the alias that may follow is discarded.
    for (const entry of list.split(',')) {
      const first = entry.trim().split(/\s+/)[0] ?? '';
      const bare = (first.split('.').pop() ?? first).replace(/["`[\]()]/g, '');
      if (bare && /^[A-Z0-9_]+$/.test(bare)) names.push(bare);
    }
  }
  return names;
}

/**
 * Does a table name name something sensitive?
 *
 * Compared per underscore-separated component with a trailing `s` stripped, so
 * `user`, `users`, `USER`, `app_user` and `user_accounts` all count while a
 * column called `user_id` — never in table position — does not.
 */
function isSensitiveTableName(name: string): boolean {
  return name.split('_').some((_, i, parts) => {
    for (let end = parts.length; end > i; end--) {
      const candidate = parts.slice(i, end).join('_').replace(/S$/, '').toLowerCase();
      if (SENSITIVE_TABLE_WORDS.has(candidate)) return true;
    }
    return false;
  });
}

/** Returns true if SELECT targets a known-sensitive table or column name. */
function sqlTargetsSensitiveTable(op: MCPOperation): boolean {
  const sql = getSql(op);
  if (!sql.startsWith('SELECT')) return false;
  if (SENSITIVE_SQL_WORDS.test(sql)) return true;
  return sqlTableNames(sql).some(isSensitiveTableName);
}

/**
 * Split a projection list on commas that sit outside brackets and quotes.
 * `count(DISTINCT a), sum(b)` is two items; `count(a, b)` is one.
 */
function splitProjection(list: string): string[] {
  const items: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { items.push(list.slice(start, i)); start = i + 1; }
  }
  items.push(list.slice(start));
  return items.map(t => t.trim()).filter(Boolean);
}

/** The projection list of a SELECT — everything between SELECT and its own FROM. */
function projectionOf(sql: string): string | null {
  if (!sql.startsWith('SELECT')) return null;
  const body = sql.slice('SELECT'.length);
  let depth = 0;
  let quote: string | null = null;
  for (let i = 0; i < body.length; i++) {
    const c = body[i]!;
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && body.startsWith('FROM', i) && /\s/.test(body[i - 1] ?? ' ')) {
      return body.slice(0, i);
    }
  }
  return body;   // `SELECT count(*)` with no FROM
}

/**
 * Returns true when the SELECT can only hand back row counts.
 *
 * `SELECT count(*) FROM users` reveals one number and no column values, so it
 * is not exfiltration however sensitive the table is. This is an allowlist of
 * exactly one function, because most things that look like aggregates return
 * the data: `max(password)` is the largest password verbatim, `group_concat`
 * and `string_agg` return every row in one string, `mode() WITHIN GROUP` the
 * most common value. `sum` and `avg` are excluded too — narrowed to a single
 * row by a WHERE clause they report that row's value exactly.
 *
 * GROUP BY disqualifies: one row per group still enumerates the grouping
 * column's cardinality. So does a set operator, which can append a second,
 * unrelated SELECT.
 *
 * A WHERE clause is allowed, which leaves a blind-oracle residue: repeated
 * counts filtered on a guess narrow a value down. That takes many queries
 * against one table, which is what rate limiting and the operation log are for.
 */
function sqlIsCountOnly(op: MCPOperation): boolean {
  const sql = getSql(op);
  if (/\b(UNION|INTERSECT|EXCEPT)\b/.test(sql)) return false;
  if (/\bGROUP\s+BY\b|\bHAVING\b/.test(sql)) return false;

  const projection = projectionOf(sql);
  if (projection === null) return false;

  const items = splitProjection(projection);
  if (items.length === 0) return false;

  // Every item must be a COUNT call, optionally aliased. Anything else — a bare
  // column, a subquery, a different function — means values can come back.
  return items.every(item => /^COUNT\s*\((?:[^()]*)\)(?:\s+(?:AS\s+)?[A-Z0-9_"]+)?$/.test(item));
}

/** Returns true if SQL params contain a semicolon (multi-statement injection risk). */
function sqlHasSemicolon(op: MCPOperation): boolean {
  const sql = getSql(op);
  return sql.includes(';');
}

/** A path naming more than one thing: a glob, or a trailing separator. */
function pathTargetsMany(op: MCPOperation): boolean {
  const p = String(op.params['path'] ?? op.params['filePath'] ?? op.params['file'] ?? '');
  return p.includes('*') || p.includes('?') || /[\\/]$/.test(p);
}

/** Removing a directory, or a set of files, rather than one named file. */
function deletesManyFiles(op: MCPOperation): boolean {
  const isFs = op.tool === 'filesystem' || op.tool === 'fs';
  if (isFs) {
    const m = op.method.toLowerCase();
    const removes = /(delete|remove|unlink|rmdir|\brm\b)/.test(m);
    if (removes && /(dir|directory|folder|tree|recursive|all)/.test(m)) return true;
    if (removes && pathTargetsMany(op)) return true;
    return false;
  }
  // Through a shell: `rm -r`, `rm -rf`, `rm --recursive`.
  const cmd = String(op.params['command'] ?? op.params['cmd'] ?? '');
  return /\brm\s+(-[a-z]*r[a-z]*\b|--recursive\b)/i.test(cmd);
}

/** Commands no checkpoint can undo — the disk itself is gone. */
function isUnrecoverableCommand(op: MCPOperation): boolean {
  const cmd = String(op.params['command'] ?? op.params['cmd'] ?? '');
  if (!cmd) return false;
  return /\bmkfs(\.[a-z0-9]+)?\s+\S/i.test(cmd)          // mkfs.ext4 /dev/sda1
    || /\bdd\b[^\n]*\bof=\/dev\//i.test(cmd)             // dd of=/dev/sda
    || /\bshred\b\s+-\S*\s*\S/i.test(cmd)                // shred -u file
    || /[>]\s*\/dev\/(sd|nvme|disk|hd)/i.test(cmd)        // echo x > /dev/sda
    || /\bmkswap\b|\bfdisk\b[^\n]*--wipe|\bwipefs\b/i.test(cmd);
}

/** Returns true if the operation is from any AgentsGate database MCP server. */
/** Tools that run arbitrary commands, as opposed to merely having an `execute` method. */
function isShellTool(tool: string): boolean {
  return /\b(shell|bash|zsh|sh|cmd|powershell|pwsh|terminal|console|exec|command|process|subprocess)\b/i
    .test(tool.replace(/[-_]/g, ' '));
}

function isDbTool(tool: string): boolean {
  return tool === 'database' ||
    tool === 'agentsgate-database' ||
    tool === 'agentsgate-pg-database' ||
    tool === 'agentsgate-mysql-database' ||
    tool === 'pg-database' ||
    tool === 'mysql-database';
}

const L1_RULES: StaticRule[] = [
  // ── Destructive filesystem ops ──────────────────────────────────────────
  {
    id: 'L1_DELETE_TREE',
    score: 0.95,
    category: 'bulk_delete',
    description: 'Removes a directory or a set of files at once — many things in one call',
    // Deleting one file and deleting a tree used to be the same rule, so the
    // filesystem had no equivalent of the database's "DELETE with no WHERE".
    matches: op => deletesManyFiles(op),
  },
  {
    id: 'L1_DESTRUCTIVE_COMMAND',
    score: 0.98,
    category: 'destructive',
    description: 'Command with no undo — filesystem creation, raw device write, secure erase',
    // Distinguished from `rm -rf` on purpose: a checkpoint can restore files,
    // and nothing can restore an overwritten device.
    matches: op => isUnrecoverableCommand(op),
  },
  {
    id: 'L1_DELETE_FILE',
    score: 0.9,
    category: 'write_delete',
    description: 'Filesystem delete/remove/unlink operation — irreversible file loss',
    matches: op =>
      (op.tool === 'filesystem' || op.tool === 'fs') &&
      methodContains(op, 'delete', 'remove', 'unlink', 'rmdir', 'rm'),
  },
  {
    id: 'L1_OVERWRITE_FILE',
    score: 0.65,
    category: 'write_update',
    description: 'Filesystem write/overwrite/create — existing content may be lost',
    matches: op =>
      (op.tool === 'filesystem' || op.tool === 'fs') &&
      methodContains(op, 'write', 'overwrite', 'truncate', 'create'),
  },
  // ── Sensitive path writes ───────────────────────────────────────────────
  {
    id: 'L1_SENSITIVE_PATH_WRITE',
    score: 0.9,
    category: 'credential',
    description: 'Write to sensitive path (.env, .aws, .ssh, credentials, secrets)',
    matches: op =>
      !isReadOnly(op) && isSensitivePath(op.params),
  },
  // ── Destructive database ops ────────────────────────────────────────────
  {
    id: 'L1_DROP_TABLE',
    score: 0.95,
    category: 'destructive',
    description: 'Database drop/truncate — destroys table data permanently',
    matches: op => methodContains(op, 'drop', 'truncate') && op.tool !== 'filesystem',
  },
  {
    id: 'L1_DELETE_RECORD',
    score: 0.75,
    category: 'write_delete',
    description: 'Database delete/remove record operation',
    matches: op => methodContains(op, 'delete', 'remove') && op.tool !== 'filesystem',
  },
  // ── Command execution ───────────────────────────────────────────────────
  {
    id: 'L1_EXECUTE_COMMAND',
    score: 0.8,
    category: 'exec',
    description: 'Shell command execution — arbitrary code execution risk',
    // Not on a database tool. They name their write method `execute`, so
    // matching the method alone scored a one-row UPDATE as arbitrary code
    // execution — 0.80, blocked — and since scoring takes the maximum, the
    // database rule's own 0.30 could never take effect. Everything else keeps
    // the original reading, including a tool that merely looks like a shell.
    matches: op =>
      !isDbTool(op.tool) &&
      (isShellTool(op.tool) || methodContains(op, 'execute', 'exec', 'run_command', 'shell', 'spawn')),
  },
  // ── Destructive git/VCS ops ─────────────────────────────────────────────
  {
    id: 'L1_GIT_FORCE_PUSH',
    score: 0.85,
    category: 'destructive',
    description: 'Destructive git operation (force push / reset / rebase) — rewrites history',
    matches: op =>
      (op.tool === 'github' || op.tool === 'git') &&
      methodContains(op, 'force', 'reset', 'rebase') &&
      !isReadOnly(op),
  },
  // ── Slack ops ───────────────────────────────────────────────────────────
  {
    id: 'L1_SLACK_SEND',
    score: 0.7,
    category: 'outbound_write',
    description: 'Slack message send/post — visible to channel or user, cannot be unsent without delete',
    matches: op =>
      op.tool === 'slack' &&
      methodContains(op, 'send', 'post', 'reply'),
  },
  {
    id: 'L1_SLACK_DELETE',
    score: 0.8,
    category: 'outbound_delete',
    description: 'Slack message/file delete — irreversible removal of content',
    matches: op =>
      op.tool === 'slack' &&
      methodContains(op, 'delete', 'remove'),
  },
  {
    id: 'L1_SLACK_READ',
    score: 0.05,
    category: 'read',
    description: 'Slack read/list/search — no data modification',
    matches: op =>
      op.tool === 'slack' &&
      isReadOnly(op),
  },
  // ── Google Calendar ops ─────────────────────────────────────────────────
  {
    id: 'L1_GCAL_CREATE',
    score: 0.4,
    category: 'outbound_write',
    description: 'Google Calendar event creation — adds event to attendees calendars',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'create', 'insert', 'add'),
  },
  {
    id: 'L1_GCAL_UPDATE',
    score: 0.5,
    category: 'outbound_write',
    description: 'Google Calendar event update/patch — modifies existing event and notifies attendees',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'update', 'patch', 'edit', 'modify'),
  },
  {
    id: 'L1_GCAL_DELETE',
    score: 0.7,
    category: 'outbound_delete',
    description: 'Google Calendar event deletion — removes event and cancels attendee invites',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'delete', 'remove', 'cancel'),
  },
  {
    id: 'L1_GCAL_READ',
    score: 0.05,
    category: 'read',
    description: 'Google Calendar read/list/search — no data modification',
    matches: op =>
      op.tool === 'google-calendar' &&
      isReadOnly(op),
  },
  // ── Gmail ops ───────────────────────────────────────────────────────────
  {
    id: 'L1_GMAIL_SEND',
    score: 0.9,
    category: 'outbound_write',
    description: 'Gmail send email — high risk: email is delivered externally and cannot be recalled',
    matches: op =>
      op.tool === 'gmail' &&
      methodContains(op, 'send', 'reply', 'forward'),
  },
  {
    id: 'L1_GMAIL_DELETE',
    score: 0.85,
    category: 'outbound_delete',
    description: 'Gmail delete/trash email — moves to trash or permanently deletes',
    matches: op =>
      op.tool === 'gmail' &&
      methodContains(op, 'delete', 'trash', 'remove'),
  },
  {
    id: 'L1_GMAIL_DRAFT',
    score: 0.3,
    category: 'outbound_write',
    description: 'Gmail create/update draft — saved locally, not yet sent',
    matches: op =>
      op.tool === 'gmail' &&
      !methodContains(op, 'send', 'reply', 'forward') &&
      methodContains(op, 'draft', 'create', 'compose'),
  },
  {
    id: 'L1_GMAIL_READ',
    score: 0.05,
    category: 'read',
    description: 'Gmail read/list/search — no data modification',
    matches: op =>
      op.tool === 'gmail' &&
      isReadOnly(op),
  },
  // ── Database MCP ops ────────────────────────────────────────────────────
  {
    id: 'L1_DB_DROP',
    score: 1.0,
    category: 'destructive',
    description: 'Database DROP TABLE/DATABASE/INDEX — permanent, unrecoverable data loss',
    matches: op =>
      isDbTool(op.tool) &&
      (op.method === 'execute_ddl' || sqlContains(op, 'DROP')),
  },
  {
    id: 'L1_DB_TRUNCATE',
    score: 0.95,
    category: 'destructive',
    description: 'Database TRUNCATE — wipes all table data without row-level recovery',
    matches: op =>
      isDbTool(op.tool) &&
      sqlContains(op, 'TRUNCATE'),
  },
  {
    id: 'L1_DB_DELETE_NO_WHERE',
    score: 0.9,
    category: 'destructive',
    description: 'Database DELETE without WHERE clause — deletes all rows in table',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute' &&
      sqlDeleteWithoutWhere(op),
  },
  {
    id: 'L1_DB_UPDATE_NO_WHERE',
    score: 0.85,
    category: 'destructive',
    description: 'Database UPDATE without WHERE clause — updates every row in table',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute' &&
      sqlUpdateWithoutWhere(op),
  },
  {
    id: 'L1_DB_DDL',
    score: 0.7,
    category: 'write_create',
    description: 'Database DDL operation (CREATE/ALTER/PRAGMA) — structural schema change',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute_ddl' &&
      !sqlContains(op, 'DROP') &&
      !sqlContains(op, 'TRUNCATE'),
  },
  {
    id: 'L1_DB_EXECUTE',
    score: 0.3,
    category: 'write_update',
    description: 'Database DML execute (INSERT/UPDATE/DELETE with WHERE) — modifies data',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute' &&
      !sqlDeleteWithoutWhere(op) &&
      !sqlUpdateWithoutWhere(op),
  },
  {
    id: 'L1_DB_READ',
    score: 0.05,
    category: 'read',
    description: 'Database read-only operation (SELECT query, list tables, describe)',
    matches: op =>
      isDbTool(op.tool) &&
      (op.method === 'query' || op.method === 'list_tables' || op.method === 'describe_table' || op.method === 'list_snapshots'),
  },
  {
    id: 'L1_DB_RESTORE',
    score: 0.6,
    category: 'write_update',
    description: 'Database snapshot restore — replaces current table contents with snapshot data',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'restore_snapshot',
  },
  {
    id: 'L1_DB_EXFIL',
    score: 0.6,
    category: 'exfiltration',
    description: 'SELECT query targeting sensitive table names (users, passwords, tokens, secrets, credentials, billing, etc.)',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'query' &&
      sqlTargetsSensitiveTable(op) &&
      !sqlIsCountOnly(op),
  },
  {
    id: 'L1_DB_BATCH_DESTROY',
    score: 0.95,
    category: 'injection',
    description: 'SQL parameter contains semicolon — possible multi-statement injection (DROP, DELETE, TRUNCATE after DML)',
    matches: op =>
      isDbTool(op.tool) &&
      (op.method === 'execute' || op.method === 'execute_ddl' || op.method === 'query') &&
      sqlHasSemicolon(op),
  },
  // ── Sensitive file-type boost ───────────────────────────────────────────
  {
    id: 'L1_SENSITIVE_FILE_TYPE',
    score: 0.75,
    category: 'credential',
    description: 'Write to high-value file type (.pem, .key, .env, .crt, etc.) — likely key material or secrets',
    matches: op => {
      if (isReadOnly(op)) return false;
      const p = String(op.params['path'] ?? op.params['filePath'] ?? op.params['file'] ?? '');
      return SENSITIVE_EXTENSIONS.test(p);
    },
  },
  // ── Read-only ops ───────────────────────────────────────────────────────
  {
    id: 'L1_READ_ONLY',
    score: 0.05,
    category: 'read',
    description: 'Read-only operation — no data modification risk',
    matches: op => isReadOnly(op),
  },
];

/** Default L1 score when no specific rule fires. */
const DEFAULT_STATIC_SCORE = 0.2;

// ── RiskScoringEngine ─────────────────────────────────────────────────────────

/**
 * M6: Risk Scoring Engine
 *
 * L1 (static rules) — implemented here.
 * L2 (user history) — returns -1 until M11 Intelligence is wired in.
 * L3 (community)    — returns -1 until M12 Registry is wired in.
 *
 * finalScore weighting:
 *   Only L1 available:        finalScore = staticScore
 *   L1 + L2 available:        finalScore = 0.6 * L1 + 0.4 * L2
 *   L1 + L2 + L3 available:   finalScore = 0.5 * L1 + 0.3 * L2 + 0.2 * L3
 */
export class RiskScoringEngine {
  async assess(operation: MCPOperation): Promise<RiskAssessment> {
    // Evaluate all L1 rules, collect fired rules, take the max score
    const matchedRules: StaticRule[] = L1_RULES.filter(r => r.matches(operation));
    const triggeredRules = matchedRules.map(r => r.id);
    const firedRuleDetails: FiredRule[] = matchedRules.map(r => ({
      id: r.id,
      score: r.score,
      layer: 'L1' as const,
      description: r.description,
      category: r.category,
    }));
    const staticScore =
      matchedRules.length > 0
        ? Math.max(...matchedRules.map(r => r.score))
        : DEFAULT_STATIC_SCORE;

    // L2 (user history) and L3 (community) scores are not available in the
    // standalone assess() method. They are blended in by createPipeline() in M1
    // when an intelligenceEngine is configured.
    const userHistoryScore = -1;
    const communityScore = -1;

    const finalScore = computeFinalScore(staticScore, userHistoryScore, communityScore);

    return {
      operationId: operation.id,
      staticScore,
      userHistoryScore,
      communityScore,
      finalScore,
      triggeredRules,
      firedRuleDetails,
      assessedAt: new Date(),
    };
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function computeFinalScore(l1: number, l2: number, l3: number): number {
  const hasL2 = l2 >= 0;
  const hasL3 = l3 >= 0;

  if (hasL2 && hasL3) return clamp(0.5 * l1 + 0.3 * l2 + 0.2 * l3);
  if (hasL2) return clamp(0.6 * l1 + 0.4 * l2);
  return clamp(l1);
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

// ── L1 Rule Snapshot ──────────────────────────────────────────────────────────

/** Serializable metadata for a single L1 static rule (no match function). */
export interface L1RuleSnapshot {
  id: string;
  score: number;
  description: string;
}

/**
 * Returns a serializable snapshot of all built-in L1 static rules.
 * Useful for display in the dashboard — the `matches` function is omitted.
 */
export function getL1RulesSnapshot(): L1RuleSnapshot[] {
  return L1_RULES.map(r => ({ id: r.id, score: r.score, description: r.description }));
}
