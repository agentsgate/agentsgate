import path from 'node:path';
import fs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import type {
  MCPOperation,
  RollbackAdapter,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
} from '../../types/interfaces.js';
import { quoteIdentifier } from '../../utils/sql.js';
import {
  buildSnapshotCapability,
  buildSnapshotPreview,
  loadSnapshotFile,
  isSafeSnapshotRef,
  loadSnapshotFiles,
  rollbackWithRedoCapture,
} from './rollback-adapter-utils.js';

export class DatabaseRollbackAdapter implements RollbackAdapter {
  readonly adapterId = 'agentsgate-database';
  readonly version = '1.0.0';
  readonly supportedTools: string[] = ['database', 'agentsgate-database'];

  constructor(private readonly dbPath: string) {}

  private resolveSnapshotDir(): string {
    return path.join(path.dirname(this.dbPath), '.agentsgate-snapshots');
  }

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    return buildSnapshotCapability(operation, this.supportedTools, 0.95, [
      'Only operations that passed snapshot_table parameter can be rolled back',
    ]);
  }

  /**
   * captureState is called BEFORE the operation executes.
   * For database ops, the MCP server already handles snapshot capture internally.
   * We store the intent here; the actual snapshot_id is read from executionResult later.
   */
  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: {
        dbPath: this.dbPath,
        snapshotTable: context.params['snapshot_table'] ?? null,
      },
      capturedAt: new Date(),
    };
  }

  /**
   * Restore a table from a snapshot file.
   * snapshot.data must contain { snapshotId: string, snapshotTable: string, dbPath?: string }.
   */
  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const data = snapshot.data as {
      snapshotId?: string;
      snapshotTable?: string;
      dbPath?: string;
    };
    const snapshotId = data.snapshotId;
    const snapshotTable = data.snapshotTable;
    const dbPath = data.dbPath ?? this.dbPath;

    if (!snapshotId || !snapshotTable) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: 'Missing snapshotId or snapshotTable in snapshot data',
      };
    }
    if (!isSafeSnapshotRef(snapshotId, snapshotTable)) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: 'Invalid snapshotId or snapshotTable in snapshot data',
      };
    }

    const dbDir = path.dirname(dbPath);
    const snapshotFile = path.join(
      dbDir,
      '.agentsgate-snapshots',
      `${snapshotId}_${snapshotTable}.json`,
    );

    const load = await loadSnapshotFile(snapshotFile, snapshotTable);
    if (!load.ok) return load.result;

    const { rows, columns } = load;
    const quoted = quoteIdentifier(snapshotTable);

    try {
      const db = new Database(dbPath);
      db.pragma('journal_mode = WAL');
      db.transaction(() => {
        db.prepare(`DELETE FROM ${quoted}`).run();
        if (rows.length > 0 && columns.length > 0) {
          const colList = columns.map(quoteIdentifier).join(', ');
          const placeholders = columns.map(() => '?').join(', ');
          const stmt = db.prepare(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`);
          for (const row of rows) {
            stmt.run(...columns.map(c => row[c] ?? null));
          }
        }
      })();
      db.close();
      return { success: true, restoredFiles: [snapshotTable], failedFiles: [] };
    } catch (err) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [snapshotTable],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async rollbackMultiple(
    snapshots: Array<{ snapshotId: string; snapshotTable: string }>,
  ): Promise<RollbackResult> {
    if (snapshots.length === 0) {
      return { success: true, restoredFiles: [], failedFiles: [] };
    }

    const snapDir = this.resolveSnapshotDir();
    const connStr = this.dbPath;

    const load = await loadSnapshotFiles(snapDir, snapshots);
    if (!load.ok) return load.result;
    const { loaded } = load;

    const db = new Database(connStr);
    try {
      const restoreAll = db.transaction(() => {
        for (const { table, rows, columns } of loaded) {
          const quoted = quoteIdentifier(table);
          db.prepare(`DELETE FROM ${quoted}`).run();
          if (rows.length > 0 && columns.length > 0) {
            const colList = columns.map(quoteIdentifier).join(', ');
            const placeholders = columns.map(() => '?').join(', ');
            const stmt = db.prepare(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`);
            for (const row of rows) {
              stmt.run(columns.map(c => row[c] ?? null));
            }
          }
        }
      });
      restoreAll();
      return { success: true, restoredFiles: snapshots.map(s => s.snapshotTable), failedFiles: [] };
    } catch (err) {
      return { success: false, restoredFiles: [], failedFiles: snapshots.map(s => s.snapshotTable), error: err instanceof Error ? err.message : String(err) };
    } finally {
      db.close();
    }
  }

  async rollbackWithUndo(snapshot: StateSnapshot): Promise<RollbackResult & { redoSnapshotId?: string }> {
    return rollbackWithRedoCapture(
      snapshot,
      (s) => this.rollback(s),
      (tableName) => this.captureCurrentState(tableName),
    );
  }

  private async captureCurrentState(tableName: string): Promise<string> {
    const db = new Database(this.dbPath, { readonly: true });
    try {
      const quoted = quoteIdentifier(tableName);
      const rows = db.prepare(`SELECT * FROM ${quoted}`).all() as Record<string, unknown>[];
      const columns = rows.length > 0 ? Object.keys(rows[0]!) : [];
      const snapshotId = randomUUID();
      const snapDir = this.resolveSnapshotDir();
      await fs.mkdir(snapDir, { recursive: true });
      const payload = JSON.stringify({ version: 1, tableName, capturedAt: new Date().toISOString(), rows, columns });
      await fs.writeFile(path.join(snapDir, `${snapshotId}_${tableName}.json`), payload, 'utf8');
      return snapshotId;
    } finally {
      db.close();
    }
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    return buildSnapshotPreview(snapshot);
  }
}
