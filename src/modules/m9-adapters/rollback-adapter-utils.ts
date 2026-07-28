/**
 * Shared helpers for the M9 database rollback adapters
 * (SQLite, PostgreSQL, MySQL).
 *
 * Only dialect-independent logic lives here: capability checks, snapshot
 * file loading, rollback-with-redo orchestration, and preview building.
 * The dialect-specific restore SQL stays in each adapter.
 */

import path from 'node:path';
import fs from 'node:fs/promises';
import { SNAPSHOT_ID_RE, TABLE_NAME_RE } from '../../mcp-servers/shared/db-server-utils.js';
import type {
  MCPOperation,
  RollbackCapability,
  RollbackPreview,
  RollbackResult,
  StateSnapshot,
} from '../../types/interfaces.js';

/**
 * Defense-in-depth: reject snapshot references that could escape the snapshot
 * directory or break out of an identifier before they reach `path.join` /
 * `quoteIdentifier`. The MCP servers already validate these when producing a
 * snapshot, but the adapters must not trust a StateSnapshot blindly — a future
 * producer of less-trusted snapshot data would otherwise inherit a path-traversal
 * primitive (`snapshotTable: "../../etc/passwd"`).
 */
export function isSafeSnapshotRef(snapshotId: string, snapshotTable: string): boolean {
  return SNAPSHOT_ID_RE.test(snapshotId) && TABLE_NAME_RE.test(snapshotTable);
}

export function assertSafeSnapshotRef(snapshotId: string, snapshotTable: string): void {
  if (!isSafeSnapshotRef(snapshotId, snapshotTable)) {
    throw new Error(`Invalid snapshot reference: ${JSON.stringify(snapshotId)} / ${JSON.stringify(snapshotTable)}`);
  }
}

/**
 * Capability check shared by all snapshot-file based database adapters:
 * only execute / execute_ddl operations that carried a snapshot_table
 * parameter can be rolled back.
 */
export function buildSnapshotCapability(
  operation: MCPOperation,
  supportedTools: string[],
  confidence: number,
  limitations: string[],
): RollbackCapability {
  const toolMatch = supportedTools.includes(operation.tool);
  const methodMatch = ['execute', 'execute_ddl'].includes(operation.method);
  const hasTable = typeof operation.params['snapshot_table'] === 'string' && operation.params['snapshot_table'] !== '';
  return {
    canRollback: toolMatch && methodMatch && hasTable,
    confidence,
    limitations,
  };
}

export type SnapshotFileLoad =
  | { ok: true; rows: Record<string, unknown>[]; columns: string[] }
  | { ok: false; result: RollbackResult };

/**
 * Read and parse a single snapshot file, mapping read/parse failures to the
 * standard RollbackResult error shapes used by all database adapters.
 */
export async function loadSnapshotFile(
  snapshotFile: string,
  snapshotTable: string,
): Promise<SnapshotFileLoad> {
  let rawContent: string;
  try {
    rawContent = await fs.readFile(snapshotFile, 'utf8');
  } catch {
    return {
      ok: false,
      result: {
        success: false,
        restoredFiles: [],
        failedFiles: [snapshotTable],
        error: `Snapshot file not found: ${snapshotFile}`,
      },
    };
  }

  let parsed: { version?: number; rows: Record<string, unknown>[]; columns: string[] };
  try {
    parsed = JSON.parse(rawContent) as typeof parsed;
  } catch {
    return {
      ok: false,
      result: {
        success: false,
        restoredFiles: [],
        failedFiles: [snapshotTable],
        error: 'Snapshot file is not valid JSON',
      },
    };
  }

  return { ok: true, rows: parsed.rows, columns: parsed.columns };
}

export interface LoadedSnapshot {
  table: string;
  rows: Record<string, unknown>[];
  columns: string[];
}

export type SnapshotFilesLoad =
  | { ok: true; loaded: LoadedSnapshot[] }
  | { ok: false; result: RollbackResult };

/**
 * Load all snapshot files for a multi-table rollback. A missing file aborts
 * with an error result; invalid JSON propagates as an exception (matching
 * the pre-refactor behavior of every adapter's rollbackMultiple).
 */
export async function loadSnapshotFiles(
  snapshotDir: string,
  snapshots: Array<{ snapshotId: string; snapshotTable: string }>,
): Promise<SnapshotFilesLoad> {
  const loaded: LoadedSnapshot[] = [];
  for (const { snapshotId, snapshotTable } of snapshots) {
    // Reject traversal-prone refs with the same graceful failure shape used for
    // a missing file, rather than throwing — the guard must not change the
    // adapter's "return a failure result" contract.
    if (!isSafeSnapshotRef(snapshotId, snapshotTable)) {
      return {
        ok: false,
        result: {
          success: false,
          restoredFiles: [],
          failedFiles: [snapshotTable],
          error: `Snapshot file not found: ${snapshotId}_${snapshotTable}.json`,
        },
      };
    }
    const snapshotFile = path.join(snapshotDir, `${snapshotId}_${snapshotTable}.json`);
    let rawContent: string;
    try {
      rawContent = await fs.readFile(snapshotFile, 'utf8');
    } catch {
      return {
        ok: false,
        result: {
          success: false,
          restoredFiles: [],
          failedFiles: [snapshotTable],
          error: `Snapshot file not found: ${snapshotFile}`,
        },
      };
    }
    const parsed = JSON.parse(rawContent) as { version?: number; rows: Record<string, unknown>[]; columns: string[] };
    loaded.push({ table: snapshotTable, rows: parsed.rows, columns: parsed.columns });
  }
  return { ok: true, loaded };
}

/**
 * Shared rollbackWithUndo orchestration: capture a redo snapshot of the
 * current table state (best-effort), then perform the rollback.
 */
export async function rollbackWithRedoCapture(
  snapshot: StateSnapshot,
  rollback: (snapshot: StateSnapshot) => Promise<RollbackResult>,
  captureCurrentState: (tableName: string) => Promise<string>,
): Promise<RollbackResult & { redoSnapshotId?: string }> {
  const data = snapshot.data as { snapshotTable?: string };
  const snapshotTable = data.snapshotTable;
  if (!snapshotTable) {
    return { ...(await rollback(snapshot)), redoSnapshotId: undefined };
  }

  let redoSnapshotId: string | undefined;
  try {
    redoSnapshotId = await captureCurrentState(snapshotTable);
  } catch {
    // redo capture failure should not block the rollback
  }

  const result = await rollback(snapshot);
  return { ...result, redoSnapshotId };
}

/** Shared previewRollback body for the snapshot-file based database adapters. */
export function buildSnapshotPreview(snapshot: StateSnapshot): RollbackPreview {
  const data = snapshot.data as { snapshotTable?: string };
  return {
    willRestore: data.snapshotTable ? [`table: ${data.snapshotTable}`] : [],
    cannotRestore: [],
    warnings: ['Restoring from snapshot will delete all current rows in the table and replace them with snapshot data'],
  };
}
