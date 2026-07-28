import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import type { MCPOperation, Checkpoint } from '../../types/interfaces.js';
import type { StateStore } from '../m2-store/index.js';
import type { FileShadowSystem } from '../m5-shadow/index.js';

/**
 * M4: Checkpoint Engine
 * Creates pre-operation system state snapshots by:
 *   1. Extracting file paths from the operation's params
 *   2. Snapshotting them via FileShadowSystem
 *   3. Persisting the Checkpoint to StateStore
 */
export class CheckpointEngine {
  constructor(
    private readonly store: StateStore,
    private readonly shadow: FileShadowSystem
  ) {}

  /**
   * Capture state before an operation executes.
   * File paths are extracted from common param keys (path, filePath, file, paths).
   */
  async create(operation: MCPOperation): Promise<Checkpoint> {
    const filePaths = extractFilePaths(operation.params);

    // Only snapshot files that currently exist on disk — new files have nothing to restore
    const existingPaths = await filterExisting(filePaths);
    const fileSnapshots =
      existingPaths.length > 0 ? await this.shadow.snapshotMany(existingPaths) : [];

    const checkpoint: Checkpoint = {
      id: randomUUID(),
      operationId: operation.id,
      type: 'pre_operation',
      fileSnapshots,
      createdAt: new Date(),
    };

    await this.store.saveCheckpoint(checkpoint);
    return checkpoint;
  }

  /** Retrieve a checkpoint by its ID. */
  async get(checkpointId: string): Promise<Checkpoint | null> {
    return this.store.getCheckpoint(checkpointId);
  }

  /**
   * List checkpoints, optionally filtered by operationId.
   * Ordered most-recent first.
   */
  async list(operationId?: string): Promise<Checkpoint[]> {
    return this.store.listCheckpoints(operationId);
  }

  /** Remove a checkpoint from the store (shadow git history is retained). */
  async delete(checkpointId: string): Promise<void> {
    return this.store.deleteCheckpoint(checkpointId);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Extract candidate file paths from operation params.
 * Handles single-path keys and array-of-paths keys.
 */
function extractFilePaths(params: Record<string, unknown>): string[] {
  const paths: string[] = [];

  for (const key of ['path', 'filePath', 'file', 'source', 'destination', 'dest']) {
    const v = params[key];
    if (typeof v === 'string' && v.length > 0) paths.push(v);
  }

  for (const key of ['paths', 'files', 'filePaths']) {
    const v = params[key];
    if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === 'string' && item.length > 0) paths.push(item);
      }
    }
  }

  // Deduplicate
  return [...new Set(paths)];
}

/** Return only paths that exist on disk. */
async function filterExisting(paths: string[]): Promise<string[]> {
  const results = await Promise.all(
    paths.map(p => fs.access(p).then(() => p).catch(() => null))
  );
  return results.filter((p): p is string => p !== null);
}
