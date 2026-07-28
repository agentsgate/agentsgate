import type {
  RollbackRequest,
  RollbackResult,
  RollbackAdapter,
  StateSnapshot,
} from '../../types/interfaces.js';
import type { CheckpointEngine } from '../m4-checkpoint/index.js';
import type { FileShadowSystem } from '../m5-shadow/index.js';

/**
 * M8: Rollback Engine
 * Restores system state to a previous checkpoint by:
 *   1. Looking up the Checkpoint via CheckpointEngine
 *   2. Restoring all FileSnapshots via FileShadowSystem
 *   3. Delegating to registered RollbackAdapters for external services
 */
export class RollbackEngine {
  private readonly adapters: RollbackAdapter[] = [];

  constructor(
    private readonly checkpoints: CheckpointEngine,
    private readonly shadow: FileShadowSystem
  ) {}

  /** Register a plugin adapter for external service rollback. */
  registerAdapter(adapter: RollbackAdapter): void {
    this.adapters.push(adapter);
  }

  /**
   * Execute rollback to the given checkpoint.
   * Returns a RollbackResult listing which files were restored or failed.
   */
  async rollback(request: RollbackRequest): Promise<RollbackResult> {
    const checkpoint = await this.checkpoints.get(request.checkpointId);
    if (!checkpoint) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: `Checkpoint ${request.checkpointId} not found`,
      };
    }

    const restoredFiles: string[] = [];
    const failedFiles: string[] = [];

    // Restore file snapshots
    for (const snap of checkpoint.fileSnapshots) {
      try {
        await this.shadow.restore(snap);
        restoredFiles.push(snap.path);
      } catch (err) {
        failedFiles.push(snap.path);
      }
    }

    // Dispatch to registered adapters if checkpoint has a DB snapshot
    if (checkpoint.dbSnapshot) {
      const { type, reference, tables } = checkpoint.dbSnapshot;
      const adapter = this.adapters.find(a =>
        a.adapterId.includes(type) ||
        (type === 'sqlite' && a.adapterId === 'agentsgate-database') ||
        (type === 'postgres' && a.adapterId === 'agentsgate-pg-database') ||
        (type === 'mysql' && a.adapterId === 'agentsgate-mysql-database')
      );
      if (adapter) {
        const stateSnap: StateSnapshot = {
          adapterId: adapter.adapterId,
          operationId: checkpoint.operationId,
          data: {
            snapshotId: reference,
            snapshotTable: tables[0] ?? '',
            connectionString: undefined,
          },
          capturedAt: checkpoint.createdAt,
        };
        const adapterResult = await adapter.rollback(stateSnap);
        if (adapterResult.restoredFiles.length > 0) {
          restoredFiles.push(...adapterResult.restoredFiles);
        }
        if (adapterResult.failedFiles.length > 0) {
          failedFiles.push(...adapterResult.failedFiles);
        }
      }
    }

    return {
      success: failedFiles.length === 0,
      restoredFiles,
      failedFiles,
      error: failedFiles.length > 0
        ? `Failed to restore ${failedFiles.length} file(s): ${failedFiles.join(', ')}`
        : undefined,
    };
  }

  /**
   * Preview what a rollback would do without making any changes.
   * Returns the same shape as rollback() but does not write anything.
   */
  async preview(request: RollbackRequest): Promise<RollbackResult> {
    const checkpoint = await this.checkpoints.get(request.checkpointId);
    if (!checkpoint) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: `Checkpoint ${request.checkpointId} not found`,
      };
    }

    // In preview mode, all known snapshots are reported as "would restore"
    const wouldRestore: string[] = checkpoint.fileSnapshots.map(s => s.path);

    if (checkpoint.dbSnapshot) {
      const { type, reference, tables } = checkpoint.dbSnapshot;
      const adapter = this.adapters.find(a =>
        a.adapterId.includes(type) ||
        (type === 'sqlite' && a.adapterId === 'agentsgate-database') ||
        (type === 'postgres' && a.adapterId === 'agentsgate-pg-database') ||
        (type === 'mysql' && a.adapterId === 'agentsgate-mysql-database')
      );
      if (adapter) {
        const stateSnap: StateSnapshot = {
          adapterId: adapter.adapterId,
          operationId: checkpoint.operationId,
          data: { snapshotId: reference, snapshotTable: tables[0] ?? '' },
          capturedAt: checkpoint.createdAt,
        };
        const preview = await adapter.previewRollback(stateSnap);
        wouldRestore.push(...preview.willRestore);
      }
    }

    return { success: true, restoredFiles: wouldRestore, failedFiles: [] };
  }

  /**
   * Rollback using a directly-supplied StateSnapshot (no checkpoint lookup).
   * Finds the first registered adapter whose adapterId matches snapshot.adapterId,
   * then calls adapter.rollback(snapshot).
   */
  async rollbackFromState(snapshot: StateSnapshot): Promise<RollbackResult> {
    const adapter = this.adapters.find(a => a.adapterId === snapshot.adapterId);
    if (!adapter) {
      return {
        success: false,
        restoredFiles: [],
        failedFiles: [],
        error: `No adapter registered for adapterId: ${snapshot.adapterId}`,
      };
    }
    return adapter.rollback(snapshot);
  }
}
