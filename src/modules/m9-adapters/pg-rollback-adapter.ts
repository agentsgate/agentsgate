import path from 'node:path';
import pg from 'pg';
import type {
  MCPOperation,
  RollbackAdapter,
  RollbackCapability,
  StateSnapshot,
  RollbackResult,
  RollbackPreview,
} from '../../types/interfaces.js';
import { quoteIdentifier } from '../../utils/sql.js';
import { resolveDefaultSnapshotDir } from '../../mcp-servers/shared/db-server-utils.js';
import {
  buildSnapshotCapability,
  buildSnapshotPreview,
  loadSnapshotFile,
  isSafeSnapshotRef,
  loadSnapshotFiles,
  rollbackWithRedoCapture,
} from './rollback-adapter-utils.js';

const { Pool } = pg;

export class PostgreSQLRollbackAdapter implements RollbackAdapter {
  readonly adapterId = 'agentsgate-pg-database';
  readonly version = '1.0.0';
  readonly supportedTools: string[] = ['pg-database', 'agentsgate-pg-database'];

  constructor(
    private readonly connectionString: string,
    private readonly snapshotDir?: string,
  ) {}

  private resolveSnapshotDir(): string {
    if (this.snapshotDir) return this.snapshotDir;
    return resolveDefaultSnapshotDir(this.connectionString, 'pg-unknown');
  }

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    return buildSnapshotCapability(operation, this.supportedTools, 0.9, [
      'Only operations with snapshot_table parameter can be rolled back',
    ]);
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    return {
      adapterId: this.adapterId,
      operationId: context.id,
      data: {
        connectionString: this.connectionString,
        snapshotTable: context.params['snapshot_table'] ?? null,
      },
      capturedAt: new Date(),
    };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    const data = snapshot.data as {
      snapshotId?: string;
      snapshotTable?: string;
      connectionString?: string;
    };
    const snapshotId = data.snapshotId;
    const snapshotTable = data.snapshotTable;
    const connStr = data.connectionString ?? this.connectionString;

    if (!snapshotId || !snapshotTable) {
      return { success: false, restoredFiles: [], failedFiles: [], error: 'Missing snapshotId or snapshotTable' };
    }
    if (!isSafeSnapshotRef(snapshotId, snapshotTable)) {
      return { success: false, restoredFiles: [], failedFiles: [], error: 'Invalid snapshotId or snapshotTable' };
    }

    const snapDir = this.resolveSnapshotDir();
    const snapshotFile = path.join(snapDir, `${snapshotId}_${snapshotTable}.json`);

    const load = await loadSnapshotFile(snapshotFile, snapshotTable);
    if (!load.ok) return load.result;

    const { rows, columns } = load;
    const quoted = quoteIdentifier(snapshotTable);

    const pool = new Pool({ connectionString: connStr });
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query(`DELETE FROM ${quoted}`);
      if (rows.length > 0 && columns.length > 0) {
        const colList = columns.map(c => quoteIdentifier(c)).join(', ');
        for (const row of rows) {
          const values = columns.map(c => row[c] ?? null);
          const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`, values);
        }
      }
      await client.query('COMMIT');
      return { success: true, restoredFiles: [snapshotTable], failedFiles: [] };
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return { success: false, restoredFiles: [], failedFiles: [snapshotTable], error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (client) client.release();
      await pool.end();
    }
  }

  async rollbackMultiple(
    snapshots: Array<{ snapshotId: string; snapshotTable: string }>,
  ): Promise<RollbackResult> {
    if (snapshots.length === 0) return { success: true, restoredFiles: [], failedFiles: [] };

    const snapDir = this.resolveSnapshotDir();
    const connStr = this.connectionString;

    const load = await loadSnapshotFiles(snapDir, snapshots);
    if (!load.ok) return load.result;
    const { loaded } = load;

    const pool = new Pool({ connectionString: connStr });
    let client: pg.PoolClient | undefined;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      for (const { table, rows, columns } of loaded) {
        const quoted = quoteIdentifier(table);
        await client.query(`DELETE FROM ${quoted}`);
        if (rows.length > 0 && columns.length > 0) {
          const colList = columns.map(c => quoteIdentifier(c)).join(', ');
          for (const row of rows) {
            const values = columns.map(c => row[c] ?? null);
            const placeholders = values.map((_, i) => `$${i + 1}`).join(', ');
            await client.query(`INSERT INTO ${quoted} (${colList}) VALUES (${placeholders})`, values);
          }
        }
      }
      await client.query('COMMIT');
      return { success: true, restoredFiles: snapshots.map(s => s.snapshotTable), failedFiles: [] };
    } catch (err) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      return { success: false, restoredFiles: [], failedFiles: snapshots.map(s => s.snapshotTable), error: err instanceof Error ? err.message : String(err) };
    } finally {
      if (client) client.release();
      await pool.end();
    }
  }

  async rollbackWithUndo(snapshot: StateSnapshot): Promise<RollbackResult & { redoSnapshotId?: string }> {
    return rollbackWithRedoCapture(
      snapshot,
      (s) => this.rollback(s),
      (tableName) => this.captureCurrentState(tableName),
    );
  }

  private async captureCurrentState(_tableName: string): Promise<string> {
    throw new Error('captureCurrentState not implemented for this adapter — use MCP server save_snapshot instead');
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    return buildSnapshotPreview(snapshot);
  }
}
