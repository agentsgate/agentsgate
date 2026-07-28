import type {
  RollbackAdapter,
  MCPOperation,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
} from '../../types/interfaces.js';

export type { RollbackAdapter };

/**
 * M9: Plugin Adapter SDK
 *
 * PluginAdapterRegistry — in-process registry for RollbackAdapter instances.
 * BaseRollbackAdapter   — abstract base class adapter authors extend.
 * FilesystemRollbackAdapter — built-in adapter for filesystem tool rollback.
 */
export class PluginAdapterRegistry {
  private readonly adapters = new Map<string, RollbackAdapter>();

  /** Register a new adapter. Throws if the adapterId is already registered. */
  register(adapter: RollbackAdapter): void {
    if (this.adapters.has(adapter.adapterId)) {
      throw new Error(
        `Adapter "${adapter.adapterId}" is already registered. Unregister it first.`
      );
    }
    this.adapters.set(adapter.adapterId, adapter);
  }

  /** Remove an adapter by ID. Silently ignores unknown IDs. */
  unregister(adapterId: string): void {
    this.adapters.delete(adapterId);
  }

  /** Return all registered adapters that declare support for the given tool name. */
  getAdaptersForTool(tool: string): RollbackAdapter[] {
    return [...this.adapters.values()].filter(a => a.supportedTools.includes(tool));
  }

  /** Return all registered adapters. */
  listAll(): RollbackAdapter[] {
    return [...this.adapters.values()];
  }
}

/**
 * Abstract base class for adapter authors.
 * Extend this and implement the four abstract methods.
 */
export abstract class BaseRollbackAdapter implements RollbackAdapter {
  abstract readonly adapterId: string;
  abstract readonly version: string;
  abstract readonly supportedTools: string[];

  abstract canRollback(operation: MCPOperation): Promise<RollbackCapability>;
  abstract captureState(context: MCPOperation): Promise<StateSnapshot>;
  abstract rollback(snapshot: StateSnapshot): Promise<RollbackResult>;
  abstract previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview>;
}

/**
 * Built-in filesystem adapter.
 * Captures file content before an operation and restores it on rollback.
 * Uses Node.js fs directly — no dependency on FileShadowSystem.
 */
export class FilesystemRollbackAdapter extends BaseRollbackAdapter {
  readonly adapterId = 'filesystem';
  readonly version = '1.0.0';
  readonly supportedTools = ['filesystem', 'fs'];

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    const path = extractPath(operation.params);
    if (!path) {
      return { canRollback: false, confidence: 0, limitations: ['No file path in params'] };
    }
    return { canRollback: true, confidence: 0.95 };
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    const { readFile } = await import('node:fs/promises');
    const filePath = extractPath(context.params);
    let content: string | null = null;
    if (filePath) {
      try {
        const buf = await readFile(filePath);
        content = buf.toString('base64');
      } catch {
        content = null; // file doesn't exist yet
      }
    }
    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: { filePath, content },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const { writeFile, unlink, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const filePath = snapshot.data['filePath'] as string | null;
    const content = snapshot.data['content'] as string | null;

    if (!filePath) {
      return { success: false, restoredFiles: [], failedFiles: [], error: 'No file path in snapshot' };
    }

    try {
      if (content === null) {
        // File didn't exist before — delete it
        await unlink(filePath).catch(() => {});
      } else {
        await mkdir(dirname(filePath), { recursive: true });
        await writeFile(filePath, Buffer.from(content, 'base64'));
      }
      return { success: true, restoredFiles: [filePath], failedFiles: [] };
    } catch (err) {
      return { success: false, restoredFiles: [], failedFiles: [filePath], error: (err as Error).message };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    const filePath = snapshot.data['filePath'] as string | null;
    const content = snapshot.data['content'] as string | null;

    if (!filePath) {
      return { willRestore: [], cannotRestore: [], warnings: ['No file path in snapshot'] };
    }

    const action = content === null ? `delete ${filePath}` : `restore ${filePath}`;
    return { willRestore: [action], cannotRestore: [], warnings: [] };
  }
}

// ── DatabaseTableRollbackAdapter ─────────────────────────────────────────────

/** Quote a SQL identifier (table name or column name) to prevent SQL injection. */
function ident(name: string): string {
  return '"' + name.replace(/"/g, '""') + '"';
}

export interface DatabaseRollbackAdapterOptions {
  /**
   * Function that executes a SQL string and returns the rows.
   * The adapter uses this for state capture (SELECT) and rollback (DML).
   * Must be provided by the consumer — no specific DB client is assumed.
   */
  execSQL: (sql: string) => Promise<Array<Record<string, unknown>>>;
}

/**
 * Plugin adapter that rolls back database operations by re-running the
 * inverse SQL statement derived from the original operation params.
 *
 * Supported operation methods:
 *   insert_row / insert      → DELETE WHERE primary key(s)
 *   delete_row / delete_rows → INSERT with captured row data
 *   update_row / update      → UPDATE back to captured values
 *
 * Snapshot data shape:
 *   {
 *     table: string,
 *     operation: 'insert' | 'delete' | 'update',
 *     primaryKeys: string[],
 *     primaryKeyValues: Record<string, unknown>,
 *     capturedRows: Array<Record<string, unknown>>,  // for delete/update rollback
 *   }
 *
 * The `execSQL` function must be provided by the consumer (no specific DB
 * client is bundled). Use a SQLite runner, pg Pool.query wrapper, etc.
 */
export class DatabaseTableRollbackAdapter extends BaseRollbackAdapter {
  readonly adapterId = 'database-table';
  readonly version   = '1.0.0';
  readonly supportedTools = ['database', 'db', 'sql'];

  private readonly execSQL: (sql: string) => Promise<Array<Record<string, unknown>>>;

  constructor(options: DatabaseRollbackAdapterOptions) {
    super();
    this.execSQL = options.execSQL;
  }

  /** Validate and return the table name, throwing on invalid input. */
  private static validateTable(table: string): string {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(table)) {
      throw new Error(`Invalid table name: ${table}`);
    }
    return table;
  }

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    const p = operation.params as Record<string, unknown>;
    const table = String(p['table'] ?? '');
    if (!table) {
      return { canRollback: false, confidence: 0, limitations: ['No table in operation params'] };
    }

    const method = operation.method.toLowerCase();
    if (!this.isSupported(method)) {
      return {
        canRollback: false,
        confidence: 0,
        limitations: [`Method '${operation.method}' is not rollback-supported (insert/delete/update only)`],
      };
    }

    return {
      canRollback: true,
      confidence: 0.8,
      limitations: ['Requires primary key(s) in params; DDL (DROP TABLE etc.) is not reversible'],
    };
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    const p = context.params as Record<string, unknown>;
    const table = String(p['table'] ?? '');
    const method = context.method.toLowerCase();
    const primaryKeys = Array.isArray(p['primaryKeys'])
      ? (p['primaryKeys'] as string[])
      : (typeof p['primaryKey'] === 'string' ? [p['primaryKey']] : ['id']);
    const primaryKeyValues = (p['where'] ?? p['keys'] ?? {}) as Record<string, unknown>;

    let capturedRows: Array<Record<string, unknown>> = [];
    let truncated = false;

    // For delete/update: capture current rows before the operation
    if ((method.includes('delete') || method.includes('update')) && table) {
      // Validate table name before using in SQL
      DatabaseTableRollbackAdapter.validateTable(table);
      const whereClauses = Object.entries(primaryKeyValues)
        .map(([k, v]) => `${ident(k)} = ${sqlLiteral(v)}`);
      if (whereClauses.length > 0) {
        try {
          const allRows = await this.execSQL(
            `SELECT * FROM ${ident(table)} WHERE ${whereClauses.join(' AND ')}`
          );
          // Cap at 1000 rows to prevent OOM on large snapshots (T429)
          if (allRows.length > 1000) {
            capturedRows = allRows.slice(0, 1000);
            truncated = true;
          } else {
            capturedRows = allRows;
          }
        } catch {
          capturedRows = [];
        }
      }
    }

    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: { table, operation: normaliseMethod(method), primaryKeys, primaryKeyValues, capturedRows, truncated },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const { table, operation, primaryKeys, primaryKeyValues, capturedRows } =
      snapshot.data as {
        table: string;
        operation: string;
        primaryKeys: string[];
        primaryKeyValues: Record<string, unknown>;
        capturedRows: Array<Record<string, unknown>>;
      };

    if (!table) {
      return { success: false, restoredFiles: [], failedFiles: [], error: 'No table in snapshot' };
    }

    // Validate table name before using in SQL
    try {
      DatabaseTableRollbackAdapter.validateTable(table);
    } catch (e) {
      return { success: false, restoredFiles: [], failedFiles: [table], error: (e as Error).message };
    }

    try {
      if (operation === 'insert') {
        // Rollback an insert → delete the inserted row(s)
        const where = Object.entries(primaryKeyValues)
          .map(([k, v]) => `${ident(k)} = ${sqlLiteral(v)}`).join(' AND ');
        if (!where) {
          return { success: false, restoredFiles: [], failedFiles: [table], error: 'No primary key values to DELETE by' };
        }
        await this.execSQL(`DELETE FROM ${ident(table)} WHERE ${where}`);
      } else if (operation === 'delete') {
        // Rollback a delete → re-insert the captured rows
        if (!capturedRows.length) {
          return { success: false, restoredFiles: [], failedFiles: [table], error: 'No captured rows to restore' };
        }
        for (const row of capturedRows) {
          const cols = Object.keys(row).map(ident).join(', ');
          const vals = Object.values(row).map(sqlLiteral).join(', ');
          await this.execSQL(`INSERT INTO ${ident(table)} (${cols}) VALUES (${vals})`);
        }
      } else if (operation === 'update') {
        // Rollback an update → restore captured column values
        if (!capturedRows.length) {
          return { success: false, restoredFiles: [], failedFiles: [table], error: 'No captured rows to restore' };
        }
        for (const row of capturedRows) {
          const pkWhere = primaryKeys
            .map(k => `${ident(k)} = ${sqlLiteral(row[k])}`)
            .join(' AND ');
          const setClauses = Object.entries(row)
            .filter(([k]) => !primaryKeys.includes(k))
            .map(([k, v]) => `${ident(k)} = ${sqlLiteral(v)}`)
            .join(', ');
          if (setClauses && pkWhere) {
            await this.execSQL(`UPDATE ${ident(table)} SET ${setClauses} WHERE ${pkWhere}`);
          }
        }
      } else {
        return { success: false, restoredFiles: [], failedFiles: [table], error: `Unsupported operation: ${operation}` };
      }

      return { success: true, restoredFiles: [table], failedFiles: [] };
    } catch (err) {
      return { success: false, restoredFiles: [], failedFiles: [table], error: (err as Error).message };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    const { table, operation, primaryKeyValues, capturedRows, truncated } =
      snapshot.data as { table: string; operation: string; primaryKeyValues: Record<string, unknown>; capturedRows: unknown[]; truncated?: boolean };

    if (!table) {
      return { willRestore: [], cannotRestore: [], warnings: ['Incomplete snapshot — no table'] };
    }

    let action: string;
    if (operation === 'insert') {
      const where = Object.entries(primaryKeyValues).map(([k, v]) => `${ident(k)}=${sqlLiteral(v)}`).join(', ');
      action = `DELETE FROM ${ident(table)} WHERE ${where || '(no key)'}`;
    } else if (operation === 'delete') {
      action = `INSERT ${capturedRows.length} row(s) back into ${ident(table)}`;
    } else if (operation === 'update') {
      action = `UPDATE ${ident(table)}: restore ${capturedRows.length} row(s) to captured values`;
    } else {
      return { willRestore: [], cannotRestore: [table], warnings: [`Unknown operation: ${operation}`] };
    }

    const warnings: string[] = [];
    if (capturedRows.length === 0 && operation !== 'insert') {
      warnings.push('No rows were captured — rollback may be a no-op');
    }
    if (truncated) {
      warnings.push('Snapshot was truncated to 1000 rows — rollback will only restore captured rows');
    }

    return {
      willRestore: [action],
      cannotRestore: [],
      warnings,
    };
  }

  private isSupported(method: string): boolean {
    return method.includes('insert') || method.includes('delete') || method.includes('update');
  }
}

/** Normalise method string to 'insert' | 'delete' | 'update'. */
function normaliseMethod(method: string): string {
  if (method.includes('insert')) return 'insert';
  if (method.includes('delete')) return 'delete';
  if (method.includes('update')) return 'update';
  return method;
}

/** Render a value as a SQL literal (very simple — for test/preview use only). */
function sqlLiteral(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? '1' : '0';
  return `'${String(v).replace(/'/g, "''")}'`;
}

function extractPath(params: Record<string, unknown>): string | null {
  for (const key of ['path', 'filePath', 'file']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

// ── GitHubPRRollbackAdapter ───────────────────────────────────────────────────

export interface GitHubPRAdapterOptions {
  /**
   * GitHub personal access token (or fine-grained token) with `repo` scope.
   * Required for close operations.
   */
  token: string;
  /**
   * GitHub API base URL.  Defaults to 'https://api.github.com'.
   * Override for GitHub Enterprise or for tests.
   */
  baseUrl?: string;
}

/**
 * Plugin adapter that rolls back PR creation by closing the opened pull request.
 *
 * Snapshot data shape:
 *   { owner: string, repo: string, pullNumber: number | null, prExistedBefore: boolean }
 *
 * Supports operations on the `github` tool whose params contain
 * `owner`, `repo`, and optionally `pullNumber`.
 * `canRollback` returns true when the snapshot has a valid pullNumber.
 */
export class GitHubPRRollbackAdapter extends BaseRollbackAdapter {
  readonly adapterId = 'github-pr';
  readonly version   = '1.0.0';
  readonly supportedTools = ['github'];

  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: GitHubPRAdapterOptions) {
    super();
    this.token   = options.token;
    this.baseUrl = (options.baseUrl ?? 'https://api.github.com').replace(/\/$/, '');
  }

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    const { owner, repo, pullNumber, pull_number } = operation.params as Record<string, unknown>;
    const num = (pullNumber ?? pull_number) as number | undefined;

    if (!owner || !repo) {
      return { canRollback: false, confidence: 0, limitations: ['Missing owner or repo in params'] };
    }
    if (!num) {
      return {
        canRollback: false,
        confidence: 0,
        limitations: ['pullNumber not present — cannot determine which PR to close'],
      };
    }
    return { canRollback: true, confidence: 0.85, limitations: ['PR must be open to be closed'] };
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    const p = context.params as Record<string, unknown>;
    const owner      = String(p['owner'] ?? '');
    const repo       = String(p['repo']  ?? '');
    const pullNumber = Number(p['pullNumber'] ?? p['pull_number'] ?? 0) || null;

    // Try to determine if the PR already existed before this operation
    let prExistedBefore = false;
    if (owner && repo && pullNumber) {
      try {
        const res = await this.ghFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}`);
        prExistedBefore = res.ok;
      } catch {
        prExistedBefore = false;
      }
    }

    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: { owner, repo, pullNumber, prExistedBefore },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const { owner, repo, pullNumber, prExistedBefore } = snapshot.data as {
      owner: string; repo: string; pullNumber: number | null; prExistedBefore: boolean;
    };

    if (!owner || !repo || !pullNumber) {
      return { success: false, restoredFiles: [], failedFiles: [], error: 'Snapshot missing owner/repo/pullNumber' };
    }
    if (prExistedBefore) {
      // PR existed before the operation — we should not close it (we didn't open it)
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: `PR #${pullNumber} existed before this operation; refusing to close it`,
      };
    }

    try {
      const res = await this.ghFetch(`/repos/${owner}/${repo}/pulls/${pullNumber}`, {
        method: 'PATCH',
        body: JSON.stringify({ state: 'closed' }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { success: false, restoredFiles: [], failedFiles: [`${owner}/${repo}#${pullNumber}`], error: body };
      }
      return { success: true, restoredFiles: [`${owner}/${repo}#${pullNumber}`], failedFiles: [] };
    } catch (err) {
      return { success: false, restoredFiles: [], failedFiles: [`${owner}/${repo}#${pullNumber}`], error: (err as Error).message };
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    const { owner, repo, pullNumber, prExistedBefore } = snapshot.data as {
      owner: string; repo: string; pullNumber: number | null; prExistedBefore: boolean;
    };

    if (!owner || !repo || !pullNumber) {
      return { willRestore: [], cannotRestore: [], warnings: ['Incomplete snapshot — cannot preview'] };
    }
    if (prExistedBefore) {
      return {
        willRestore: [],
        cannotRestore: [`${owner}/${repo}#${pullNumber}`],
        warnings: [`PR #${pullNumber} existed before the operation; rollback would be skipped`],
      };
    }
    return {
      willRestore: [`close PR ${owner}/${repo}#${pullNumber}`],
      cannotRestore: [],
      warnings: ['PR must still be open for the close to succeed'],
    };
  }

  private ghFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(this.baseUrl + path, {
      ...init,
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(init?.headers as Record<string, string> | undefined),
      },
    });
  }
}
