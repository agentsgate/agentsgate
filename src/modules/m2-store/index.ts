import path from 'node:path';
import fs from 'node:fs/promises';
import Database from 'better-sqlite3';
import type { MCPOperation, OperationLog, Checkpoint, RiskAssessment, ProxyDecision } from '../../types/interfaces.js';

/** Filter options for listOperationLogs(). */
export interface OperationFilter {
  action?: ProxyDecision['action'];
  tool?: string;
  agentId?: string;
  sessionId?: string;
  /** Only include logs with createdAt >= this timestamp */
  from?: Date;
  /** Only include logs with createdAt <= this timestamp */
  to?: Date;
  /** Only include logs whose operation.parentId matches this value */
  parentId?: string;
  /** Only include logs where operation.tags contains ALL of the specified tags */
  tags?: string[];
  /** T399: only include logs where operation.method matches this value */
  method?: string;
}

export interface PendingApprovalRecord {
  id: string;
  operation: MCPOperation;
  riskScore: number;
  checkpointId?: string;
  queuedAt: Date;
}

/**
 * M2: State Store
 * SQLite-backed persistence layer for all AgentsGate data.
 * Uses better-sqlite3 (sync API) wrapped in async methods.
 */
export class StateStore {
  private db: Database.Database | null = null;

  constructor(private readonly dbPath: string) {}

  async initialize(): Promise<void> {
    if (this.dbPath !== ':memory:') {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS operation_logs (
        operation_id TEXT PRIMARY KEY,
        data         TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        agent_id     TEXT,
        tool         TEXT,
        session_id   TEXT
      );

      CREATE TABLE IF NOT EXISTS checkpoints (
        id           TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        data         TEXT NOT NULL,
        created_at   TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS risk_assessments (
        operation_id TEXT PRIMARY KEY,
        data         TEXT NOT NULL,
        assessed_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS outcome_records (
        operation_id  TEXT PRIMARY KEY,
        agent_id      TEXT NOT NULL,
        tool          TEXT NOT NULL,
        was_approved  INTEGER NOT NULL,
        recorded_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_outcomes_agent_tool
        ON outcome_records (agent_id, tool);

      CREATE INDEX IF NOT EXISTS idx_logs_created_at
        ON operation_logs (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_logs_agent_id
        ON operation_logs (agent_id);
      CREATE INDEX IF NOT EXISTS idx_logs_tool
        ON operation_logs (tool);
      CREATE INDEX IF NOT EXISTS idx_logs_session_id
        ON operation_logs (session_id);

      CREATE TABLE IF NOT EXISTS pending_approvals (
        id           TEXT PRIMARY KEY,
        operation_id TEXT NOT NULL,
        data         TEXT NOT NULL,
        queued_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_pending_approvals_queued_at
        ON pending_approvals (queued_at DESC);
    `);

    // Migration: add indexed columns to existing operation_logs tables that predate T403.
    for (const col of [
      'ALTER TABLE operation_logs ADD COLUMN agent_id   TEXT',
      'ALTER TABLE operation_logs ADD COLUMN tool       TEXT',
      'ALTER TABLE operation_logs ADD COLUMN session_id TEXT',
    ]) {
      try { this.db.exec(col); } catch { /* column already exists */ }
    }
  }

  async close(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  // ── OperationLog ──────────────────────────────────────────────────────────

  /**
   * Signature of the most recently inserted log, or null when the table is
   * empty. This is the tip the next record chains onto.
   *
   * Ordered by rowid rather than created_at: rowid is insertion order, which is
   * the order the chain was built in. created_at can tie or move backwards when
   * a caller supplies its own timestamp.
   */
  async getLastLogHmac(): Promise<string | null> {
    this.assertOpen();
    const row = this.db!
      .prepare('SELECT data FROM operation_logs ORDER BY rowid DESC LIMIT 1')
      .get() as { data: string } | undefined;
    if (!row) return null;
    try {
      return (JSON.parse(row.data) as OperationLog).hmac ?? null;
    } catch {
      return null;
    }
  }

  /**
   * All logs in insertion order, oldest first — the order `verifyChain` needs.
   * `listOperationLogs` returns newest-first for display and cannot be used.
   */
  async listOperationLogsForChain(limit?: number): Promise<OperationLog[]> {
    this.assertOpen();
    const sql = limit === undefined
      ? 'SELECT data FROM operation_logs ORDER BY rowid ASC'
      : 'SELECT data FROM operation_logs ORDER BY rowid ASC LIMIT ?';
    const rows = (limit === undefined
      ? this.db!.prepare(sql).all()
      : this.db!.prepare(sql).all(limit)) as Array<{ data: string }>;
    return rows.map(r => deserializeLog(r.data));
  }

  async saveOperationLog(log: OperationLog): Promise<void> {
    this.assertOpen();
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO operation_logs (operation_id, data, created_at, agent_id, tool, session_id)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      log.operationId,
      JSON.stringify(log),
      log.createdAt.toISOString(),
      log.operation.agentId,
      log.operation.tool,
      log.operation.sessionId,
    );
  }

  async getOperationLog(operationId: string): Promise<OperationLog | null> {
    this.assertOpen();
    const row = this.db!.prepare(
      'SELECT data FROM operation_logs WHERE operation_id = ?'
    ).get(operationId) as { data: string } | undefined;
    return row ? deserializeLog(row.data) : null;
  }

  async listOperationLogs(
    limit = 100,
    offset = 0,
    filter?: OperationFilter
  ): Promise<OperationLog[]> {
    this.assertOpen();

    if (!filter) {
      const rows = this.db!.prepare(
        'SELECT data FROM operation_logs ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as { data: string }[];
      return rows.map(r => deserializeLog(r.data));
    }

    // Build SQL WHERE using indexed columns for the common filters; JS-side for the rest.
    const { whereSql, sqlParams } = buildSqlFilter(filter);
    const batchSize = Math.max((limit + offset) * 5, 500);
    const rows = this.db!.prepare(
      `SELECT data FROM operation_logs${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(...sqlParams, batchSize) as { data: string }[];

    const fromMs = filter.from?.getTime();
    const toMs = filter.to?.getTime();

    const filtered = rows
      .map(r => deserializeLog(r.data))
      .filter(log => {
        if (filter.action && log.decision.action !== filter.action) return false;
        if (filter.parentId !== undefined && log.operation.parentId !== filter.parentId) return false;
        if (filter.tags && filter.tags.length > 0) {
          const opTags = log.operation.tags ?? [];
          if (!filter.tags.every(t => opTags.includes(t))) return false;
        }
        if (filter.method && log.operation.method !== filter.method) return false;
        if (fromMs !== undefined && log.createdAt.getTime() < fromMs) return false;
        if (toMs !== undefined && log.createdAt.getTime() > toMs) return false;
        return true;
      });

    return filtered.slice(offset, offset + limit);
  }

  /**
   * Return the total count of operation logs matching an optional filter.
   * Used by GET /operations to return the true total alongside the paged data.
   */
  countOperationLogs(filter?: OperationFilter): number {
    this.assertOpen();
    if (!filter) {
      const row = this.db!.prepare('SELECT COUNT(*) as n FROM operation_logs').get() as { n: number };
      return row.n;
    }
    // Use SQL-side filtering for indexed columns; JS-side for the rest.
    const { whereSql, sqlParams } = buildSqlFilter(filter);
    const batchSize = 10_000;
    const rows = this.db!.prepare(
      `SELECT data FROM operation_logs${whereSql} ORDER BY created_at DESC, rowid DESC LIMIT ?`
    ).all(...sqlParams, batchSize) as { data: string }[];
    const fromMs = filter.from?.getTime();
    const toMs = filter.to?.getTime();
    return rows
      .map(r => deserializeLog(r.data))
      .filter(log => {
        if (filter.action && log.decision.action !== filter.action) return false;
        if (filter.parentId !== undefined && log.operation.parentId !== filter.parentId) return false;
        if (filter.tags && filter.tags.length > 0) {
          const opTags = log.operation.tags ?? [];
          if (!filter.tags.every(t => opTags.includes(t))) return false;
        }
        if (filter.method && log.operation.method !== filter.method) return false; // T399
        if (fromMs !== undefined && log.createdAt.getTime() < fromMs) return false;
        if (toMs !== undefined && log.createdAt.getTime() > toMs) return false;
        return true;
      }).length;
  }

  /**
   * Delete operation logs older than `maxAgeMs` milliseconds.
   * Returns the number of rows deleted.
   */
  pruneOldLogs(maxAgeMs: number): number {
    this.assertOpen();
    const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
    const result = this.db!.prepare(
      'DELETE FROM operation_logs WHERE created_at < ?'
    ).run(cutoff);
    return result.changes;
  }

  // ── Checkpoint ────────────────────────────────────────────────────────────

  async saveCheckpoint(checkpoint: Checkpoint): Promise<void> {
    this.assertOpen();
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO checkpoints (id, operation_id, data, created_at)
      VALUES (?, ?, ?, ?)
    `);
    stmt.run(
      checkpoint.id,
      checkpoint.operationId,
      JSON.stringify(checkpoint),
      checkpoint.createdAt.toISOString()
    );
  }

  async getCheckpoint(checkpointId: string): Promise<Checkpoint | null> {
    this.assertOpen();
    const row = this.db!.prepare(
      'SELECT data FROM checkpoints WHERE id = ?'
    ).get(checkpointId) as { data: string } | undefined;
    return row ? deserializeCheckpoint(row.data) : null;
  }

  async listCheckpoints(operationId?: string): Promise<Checkpoint[]> {
    this.assertOpen();
    const rows = operationId
      ? (this.db!.prepare(
          'SELECT data FROM checkpoints WHERE operation_id = ? ORDER BY created_at DESC'
        ).all(operationId) as { data: string }[])
      : (this.db!.prepare(
          'SELECT data FROM checkpoints ORDER BY created_at DESC'
        ).all() as { data: string }[]);
    return rows.map(r => deserializeCheckpoint(r.data));
  }

  async deleteCheckpoint(checkpointId: string): Promise<void> {
    this.assertOpen();
    this.db!.prepare('DELETE FROM checkpoints WHERE id = ?').run(checkpointId);
  }

  // ── OutcomeRecord (L2 user-history persistence) ───────────────────────────

  async saveOutcomeRecord(
    operationId: string,
    agentId: string,
    tool: string,
    wasApproved: boolean
  ): Promise<void> {
    this.assertOpen();
    this.db!.prepare(`
      INSERT OR REPLACE INTO outcome_records (operation_id, agent_id, tool, was_approved, recorded_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(operationId, agentId, tool, wasApproved ? 1 : 0, new Date().toISOString());
  }

  async listOutcomeRecords(
    agentId: string,
    tool: string
  ): Promise<Array<{ operationId: string; wasApproved: boolean }>> {
    this.assertOpen();
    const rows = this.db!.prepare(`
      SELECT operation_id, was_approved FROM outcome_records
      WHERE agent_id = ? AND tool = ?
      ORDER BY recorded_at ASC
    `).all(agentId, tool) as Array<{ operation_id: string; was_approved: number }>;
    return rows.map(r => ({ operationId: r.operation_id, wasApproved: r.was_approved === 1 }));
  }

  /** List all outcome records for an agent across all tools (for per-tool breakdown). */
  async listAllOutcomeRecords(
    agentId: string
  ): Promise<Array<{ operationId: string; tool: string; wasApproved: boolean }>> {
    this.assertOpen();
    const rows = this.db!.prepare(`
      SELECT operation_id, tool, was_approved FROM outcome_records
      WHERE agent_id = ?
      ORDER BY recorded_at ASC
    `).all(agentId) as Array<{ operation_id: string; tool: string; was_approved: number }>;
    return rows.map(r => ({ operationId: r.operation_id, tool: r.tool, wasApproved: r.was_approved === 1 }));
  }

  // ── Pending approvals ────────────────────────────────────────────────────

  async savePendingApproval(approval: PendingApprovalRecord): Promise<void> {
    this.assertOpen();
    this.db!.prepare(`
      INSERT OR REPLACE INTO pending_approvals (id, operation_id, data, queued_at)
      VALUES (?, ?, ?, ?)
    `).run(
      approval.id,
      approval.operation.id,
      JSON.stringify(approval),
      approval.queuedAt.toISOString()
    );
  }

  async listPendingApprovals(): Promise<PendingApprovalRecord[]> {
    this.assertOpen();
    const rows = this.db!.prepare(
      'SELECT data FROM pending_approvals ORDER BY queued_at DESC'
    ).all() as { data: string }[];
    return rows.map(r => deserializePendingApproval(r.data));
  }

  async deletePendingApproval(id: string): Promise<void> {
    this.assertOpen();
    this.db!.prepare('DELETE FROM pending_approvals WHERE id = ?').run(id);
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /**
   * Delete operation logs older than the given cutoff date.
   * Returns the number of rows deleted.
   */
  async pruneOperationLogs(cutoff: Date): Promise<number> {
    this.assertOpen();
    const result = this.db!.prepare(
      'DELETE FROM operation_logs WHERE created_at < ?'
    ).run(cutoff.toISOString());
    return result.changes;
  }

  /**
   * Return row counts for all tables — used by the /health endpoint.
   */
  async getStats(): Promise<{
    operationLogs: number;
    checkpoints: number;
    pendingApprovals: number;
    outcomeRecords: number;
  }> {
    this.assertOpen();
    const count = (table: string) =>
      (this.db!.prepare(`SELECT COUNT(*) as n FROM ${table}`).get() as { n: number }).n;
    return {
      operationLogs: count('operation_logs'),
      checkpoints: count('checkpoints'),
      pendingApprovals: count('pending_approvals'),
      outcomeRecords: count('outcome_records'),
    };
  }

  // ── RiskAssessment ────────────────────────────────────────────────────────

  async saveRiskAssessment(assessment: RiskAssessment): Promise<void> {
    this.assertOpen();
    const stmt = this.db!.prepare(`
      INSERT OR REPLACE INTO risk_assessments (operation_id, data, assessed_at)
      VALUES (?, ?, ?)
    `);
    stmt.run(
      assessment.operationId,
      JSON.stringify(assessment),
      assessment.assessedAt.toISOString()
    );
  }

  async getRiskAssessment(operationId: string): Promise<RiskAssessment | null> {
    this.assertOpen();
    const row = this.db!.prepare(
      'SELECT data FROM risk_assessments WHERE operation_id = ?'
    ).get(operationId) as { data: string } | undefined;
    return row ? deserializeRiskAssessment(row.data) : null;
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private assertOpen(): void {
    if (!this.db) {
      throw new Error('StateStore not initialized. Call initialize() first.');
    }
  }
}

// ── SQL filter builder (T403: push indexed-column filters to SQL) ─────────────

/**
 * Build a SQL WHERE clause for the indexed columns of operation_logs.
 * Handles agentId, tool, sessionId, and created_at range.
 * Action, tags, parentId, method remain as JS-side filters.
 */
function buildSqlFilter(filter: OperationFilter): { whereSql: string; sqlParams: unknown[] } {
  const conditions: string[] = [];
  const sqlParams: unknown[] = [];

  if (filter.agentId) {
    conditions.push('agent_id = ?');
    sqlParams.push(filter.agentId);
  }
  if (filter.tool) {
    conditions.push('tool = ?');
    sqlParams.push(filter.tool);
  }
  if (filter.sessionId) {
    conditions.push('session_id = ?');
    sqlParams.push(filter.sessionId);
  }
  if (filter.from) {
    conditions.push('created_at >= ?');
    sqlParams.push(filter.from.toISOString());
  }
  if (filter.to) {
    conditions.push('created_at <= ?');
    sqlParams.push(filter.to.toISOString());
  }

  const whereSql = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
  return { whereSql, sqlParams };
}

// ── Deserialization helpers (restore Date objects from ISO strings) ─────────

function deserializeLog(json: string): OperationLog {
  const raw = JSON.parse(json);
  raw.createdAt = new Date(raw.createdAt);
  raw.operation.timestamp = new Date(raw.operation.timestamp);
  return raw as OperationLog;
}

function deserializeCheckpoint(json: string): Checkpoint {
  const raw = JSON.parse(json);
  raw.createdAt = new Date(raw.createdAt);
  return raw as Checkpoint;
}

function deserializeRiskAssessment(json: string): RiskAssessment {
  const raw = JSON.parse(json);
  raw.assessedAt = new Date(raw.assessedAt);
  return raw as RiskAssessment;
}

function deserializePendingApproval(json: string): PendingApprovalRecord {
  const raw = JSON.parse(json);
  raw.operation.timestamp = new Date(raw.operation.timestamp);
  raw.queuedAt = new Date(raw.queuedAt);
  return raw as PendingApprovalRecord;
}
