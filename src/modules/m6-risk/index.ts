import type { MCPOperation, RiskAssessment, FiredRule } from '../../types/interfaces.js';

// ── L1 Static Rule definitions ────────────────────────────────────────────────

interface StaticRule {
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

/** Returns true if SELECT targets a known-sensitive table name. */
function sqlTargetsSensitiveTable(op: MCPOperation): boolean {
  const sql = getSql(op);
  if (!sql.startsWith('SELECT')) return false;
  const SENSITIVE = /\b(users|passwords|password|tokens|token|secrets|secret|credentials|credential|api_keys|api_key|auth_tokens|auth_token|private_keys|private_key|billing|ssn|payment|credit_card)\b/i;
  return SENSITIVE.test(sql);
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

/** Returns true if the operation is from any AgentsGate database MCP server. */
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
    id: 'L1_DELETE_FILE',
    score: 0.9,
    description: 'Filesystem delete/remove/unlink operation — irreversible file loss',
    matches: op =>
      (op.tool === 'filesystem' || op.tool === 'fs') &&
      methodContains(op, 'delete', 'remove', 'unlink', 'rmdir', 'rm'),
  },
  {
    id: 'L1_OVERWRITE_FILE',
    score: 0.65,
    description: 'Filesystem write/overwrite/create — existing content may be lost',
    matches: op =>
      (op.tool === 'filesystem' || op.tool === 'fs') &&
      methodContains(op, 'write', 'overwrite', 'truncate', 'create'),
  },
  // ── Sensitive path writes ───────────────────────────────────────────────
  {
    id: 'L1_SENSITIVE_PATH_WRITE',
    score: 0.9,
    description: 'Write to sensitive path (.env, .aws, .ssh, credentials, secrets)',
    matches: op =>
      !isReadOnly(op) && isSensitivePath(op.params),
  },
  // ── Destructive database ops ────────────────────────────────────────────
  {
    id: 'L1_DROP_TABLE',
    score: 0.95,
    description: 'Database drop/truncate — destroys table data permanently',
    matches: op => methodContains(op, 'drop', 'truncate') && op.tool !== 'filesystem',
  },
  {
    id: 'L1_DELETE_RECORD',
    score: 0.75,
    description: 'Database delete/remove record operation',
    matches: op => methodContains(op, 'delete', 'remove') && op.tool !== 'filesystem',
  },
  // ── Command execution ───────────────────────────────────────────────────
  {
    id: 'L1_EXECUTE_COMMAND',
    score: 0.8,
    description: 'Shell command execution — arbitrary code execution risk',
    matches: op => methodContains(op, 'execute', 'exec', 'run_command', 'shell', 'spawn'),
  },
  // ── Destructive git/VCS ops ─────────────────────────────────────────────
  {
    id: 'L1_GIT_FORCE_PUSH',
    score: 0.85,
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
    description: 'Slack message send/post — visible to channel or user, cannot be unsent without delete',
    matches: op =>
      op.tool === 'slack' &&
      methodContains(op, 'send', 'post', 'reply'),
  },
  {
    id: 'L1_SLACK_DELETE',
    score: 0.8,
    description: 'Slack message/file delete — irreversible removal of content',
    matches: op =>
      op.tool === 'slack' &&
      methodContains(op, 'delete', 'remove'),
  },
  {
    id: 'L1_SLACK_READ',
    score: 0.05,
    description: 'Slack read/list/search — no data modification',
    matches: op =>
      op.tool === 'slack' &&
      isReadOnly(op),
  },
  // ── Google Calendar ops ─────────────────────────────────────────────────
  {
    id: 'L1_GCAL_CREATE',
    score: 0.4,
    description: 'Google Calendar event creation — adds event to attendees calendars',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'create', 'insert', 'add'),
  },
  {
    id: 'L1_GCAL_UPDATE',
    score: 0.5,
    description: 'Google Calendar event update/patch — modifies existing event and notifies attendees',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'update', 'patch', 'edit', 'modify'),
  },
  {
    id: 'L1_GCAL_DELETE',
    score: 0.7,
    description: 'Google Calendar event deletion — removes event and cancels attendee invites',
    matches: op =>
      op.tool === 'google-calendar' &&
      methodContains(op, 'delete', 'remove', 'cancel'),
  },
  {
    id: 'L1_GCAL_READ',
    score: 0.05,
    description: 'Google Calendar read/list/search — no data modification',
    matches: op =>
      op.tool === 'google-calendar' &&
      isReadOnly(op),
  },
  // ── Gmail ops ───────────────────────────────────────────────────────────
  {
    id: 'L1_GMAIL_SEND',
    score: 0.9,
    description: 'Gmail send email — high risk: email is delivered externally and cannot be recalled',
    matches: op =>
      op.tool === 'gmail' &&
      methodContains(op, 'send', 'reply', 'forward'),
  },
  {
    id: 'L1_GMAIL_DELETE',
    score: 0.85,
    description: 'Gmail delete/trash email — moves to trash or permanently deletes',
    matches: op =>
      op.tool === 'gmail' &&
      methodContains(op, 'delete', 'trash', 'remove'),
  },
  {
    id: 'L1_GMAIL_DRAFT',
    score: 0.3,
    description: 'Gmail create/update draft — saved locally, not yet sent',
    matches: op =>
      op.tool === 'gmail' &&
      !methodContains(op, 'send', 'reply', 'forward') &&
      methodContains(op, 'draft', 'create', 'compose'),
  },
  {
    id: 'L1_GMAIL_READ',
    score: 0.05,
    description: 'Gmail read/list/search — no data modification',
    matches: op =>
      op.tool === 'gmail' &&
      isReadOnly(op),
  },
  // ── Database MCP ops ────────────────────────────────────────────────────
  {
    id: 'L1_DB_DROP',
    score: 1.0,
    description: 'Database DROP TABLE/DATABASE/INDEX — permanent, unrecoverable data loss',
    matches: op =>
      isDbTool(op.tool) &&
      (op.method === 'execute_ddl' || sqlContains(op, 'DROP')),
  },
  {
    id: 'L1_DB_TRUNCATE',
    score: 0.95,
    description: 'Database TRUNCATE — wipes all table data without row-level recovery',
    matches: op =>
      isDbTool(op.tool) &&
      sqlContains(op, 'TRUNCATE'),
  },
  {
    id: 'L1_DB_DELETE_NO_WHERE',
    score: 0.9,
    description: 'Database DELETE without WHERE clause — deletes all rows in table',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute' &&
      sqlDeleteWithoutWhere(op),
  },
  {
    id: 'L1_DB_UPDATE_NO_WHERE',
    score: 0.85,
    description: 'Database UPDATE without WHERE clause — updates every row in table',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'execute' &&
      sqlUpdateWithoutWhere(op),
  },
  {
    id: 'L1_DB_DDL',
    score: 0.7,
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
    description: 'Database read-only operation (SELECT query, list tables, describe)',
    matches: op =>
      isDbTool(op.tool) &&
      (op.method === 'query' || op.method === 'list_tables' || op.method === 'describe_table' || op.method === 'list_snapshots'),
  },
  {
    id: 'L1_DB_RESTORE',
    score: 0.6,
    description: 'Database snapshot restore — replaces current table contents with snapshot data',
    matches: op =>
      isDbTool(op.tool) &&
      op.method === 'restore_snapshot',
  },
  {
    id: 'L1_DB_EXFIL',
    score: 0.6,
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
