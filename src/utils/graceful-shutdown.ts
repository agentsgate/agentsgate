/**
 * GracefulShutdown — registers SIGINT / SIGTERM handlers and coordinates an
 * ordered teardown of AgentsGate's long-lived resources.
 *
 * Shutdown order:
 *   1. Stop accepting new requests (proxy HTTP server)
 *   2. Stop the dashboard HTTP server
 *   3. Flush any pending telemetry
 *   4. Persist in-memory approval queue to the DB (if configured)
 *   5. Close the SQLite database
 *   6. Remove the PID state file
 *   7. Exit(0)
 *
 * A configurable timeout (default 8 s) force-exits if any step hangs.
 */

export interface GracefulShutdownOptions {
  /** Stops the proxy HTTP server. */
  stopProxy: () => Promise<void>;
  /** Stops the dashboard HTTP server. */
  stopDashboard: () => Promise<void>;
  /** Flushes in-memory telemetry (noop if no telemetry). */
  flushTelemetry?: () => Promise<void>;
  /**
   * Called to log the count of pending approvals before shutdown.
   * Purely informational — the actual approval records are already in the DB.
   */
  getPendingApprovalCount?: () => Promise<number>;
  /** Closes the SQLite database. */
  closeStore: () => Promise<void>;
  /** Removes the PID/state file on clean exit. */
  removeStateFile?: () => Promise<void>;
  /** Clear any running timers (telemetry export intervals, etc.). */
  clearTimers?: () => void;
  /**
   * Milliseconds to wait before force-exiting.
   * Default: 8 000 ms.
   */
  timeoutMs?: number;
  /** Write progress messages (default: console.error). */
  log?: (msg: string) => void;
}

export class GracefulShutdown {
  private readonly opts: Required<GracefulShutdownOptions>;
  private triggered = false;

  constructor(options: GracefulShutdownOptions) {
    this.opts = {
      flushTelemetry: async () => { /* noop */ },
      getPendingApprovalCount: async () => 0,
      removeStateFile: async () => { /* noop */ },
      clearTimers: () => { /* noop */ },
      timeoutMs: 8_000,
      log: (msg: string) => { process.stderr.write(msg + '\n'); },
      ...options,
    };
  }

  /** Register SIGINT and SIGTERM handlers. Call once at startup. */
  register(): void {
    const handler = () => { void this.shutdown(); };
    process.once('SIGINT',  handler);
    process.once('SIGTERM', handler);
  }

  /** Perform graceful shutdown. Safe to call multiple times (idempotent). */
  async shutdown(): Promise<void> {
    if (this.triggered) return;
    this.triggered = true;

    const { log, timeoutMs } = this.opts;
    log('\nShutting down AgentsGate…');

    // Force-exit watchdog
    const watchdog = setTimeout(() => {
      log(`Shutdown timed out after ${timeoutMs}ms — forcing exit`);
      process.exit(1);
    }, timeoutMs);
    watchdog.unref(); // don't keep the event loop alive just for this

    try {
      this.opts.clearTimers();

      // Inform operator of in-flight approvals
      const pendingCount = await this.opts.getPendingApprovalCount().catch(() => 0);
      if (pendingCount > 0) {
        log(`  ${pendingCount} pending approval(s) are persisted to the database and will resume on restart`);
      }

      log('  Stopping proxy…');
      await this.opts.stopProxy().catch(() => {});

      log('  Stopping dashboard…');
      await this.opts.stopDashboard().catch(() => {});

      log('  Flushing telemetry…');
      await this.opts.flushTelemetry().catch(() => {});

      log('  Closing database…');
      await this.opts.closeStore().catch(() => {});

      await this.opts.removeStateFile().catch(() => {});

      clearTimeout(watchdog);
      log('Stopped.');
      process.exit(0);
    } catch (err) {
      log(`Shutdown error: ${(err as Error).message}`);
      clearTimeout(watchdog);
      process.exit(1);
    }
  }
}
