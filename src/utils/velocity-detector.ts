/**
 * VelocityDetector — tracks operation timestamps per agent and computes a
 * velocity-based risk boost when an agent fires an unusually high number of
 * operations in a short window.
 *
 * The boost is additive (clamped to [0, 1]) so it stacks on top of the
 * static L1 score without overriding it.
 *
 * Configuration:
 *   windowMs      — sliding window length in ms (default: 60 000 = 1 min)
 *   threshold     — operations in window before boost kicks in (default: 20)
 *   maxBoost      — maximum additive boost to final risk score (default: 0.4)
 *   decayFactor   — fraction of maxBoost applied per step above threshold (default: 0.05)
 *
 * Boost formula:
 *   excess = opsInWindow - threshold          (0 if below threshold)
 *   boost  = min(excess * decayFactor, maxBoost)
 */

export interface VelocityDetectorOptions {
  /** Sliding window in ms. Default: 60 000. */
  windowMs?: number;
  /** Minimum ops in window before any boost. Default: 20. */
  threshold?: number;
  /** Maximum additive boost. Default: 0.4. */
  maxBoost?: number;
  /** Boost per operation above threshold. Default: 0.05. */
  decayFactor?: number;
}

export class VelocityDetector {
  private readonly windowMs: number;
  private readonly threshold: number;
  private readonly maxBoost: number;
  private readonly decayFactor: number;

  /** Per-agent circular timestamp buffer (milliseconds). */
  private readonly timestamps = new Map<string, number[]>();

  constructor(options: VelocityDetectorOptions = {}) {
    this.windowMs    = options.windowMs    ?? 60_000;
    this.threshold   = options.threshold   ?? 20;
    this.maxBoost    = options.maxBoost    ?? 0.4;
    this.decayFactor = options.decayFactor ?? 0.05;
  }

  /**
   * Record an operation for `agentId` at the current timestamp and return the
   * velocity-based risk boost [0, maxBoost].
   *
   * Call this once per operation, in order; the method both records and scores.
   */
  record(agentId: string, nowMs: number = Date.now()): number {
    const ts = this.timestamps.get(agentId) ?? [];

    // Prune entries outside the window
    const cutoff = nowMs - this.windowMs;
    const pruned = ts.filter(t => t >= cutoff);
    pruned.push(nowMs);
    this.timestamps.set(agentId, pruned);

    const opsInWindow = pruned.length;
    if (opsInWindow <= this.threshold) return 0;

    const excess = opsInWindow - this.threshold;
    return Math.min(excess * this.decayFactor, this.maxBoost);
  }

  /**
   * Return the velocity boost for `agentId` without recording a new operation.
   * Useful for inspection / testing.
   */
  peek(agentId: string, nowMs: number = Date.now()): number {
    const ts = this.timestamps.get(agentId) ?? [];
    const cutoff = nowMs - this.windowMs;
    const active = ts.filter(t => t >= cutoff);
    const opsInWindow = active.length;
    if (opsInWindow <= this.threshold) return 0;
    const excess = opsInWindow - this.threshold;
    return Math.min(excess * this.decayFactor, this.maxBoost);
  }

  /** Return the number of operations recorded for `agentId` in the current window. */
  getCount(agentId: string, nowMs: number = Date.now()): number {
    const ts = this.timestamps.get(agentId) ?? [];
    const cutoff = nowMs - this.windowMs;
    return ts.filter(t => t >= cutoff).length;
  }

  /** Clear all recorded timestamps (e.g. after a reset). */
  reset(agentId?: string): void {
    if (agentId) {
      this.timestamps.delete(agentId);
    } else {
      this.timestamps.clear();
    }
  }

  /** Expose the configured options for introspection. */
  get config(): Required<VelocityDetectorOptions> {
    return {
      windowMs:    this.windowMs,
      threshold:   this.threshold,
      maxBoost:    this.maxBoost,
      decayFactor: this.decayFactor,
    };
  }
}
