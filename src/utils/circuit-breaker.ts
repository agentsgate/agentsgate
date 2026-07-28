/**
 * T172 — Agent circuit breaker.
 *
 * Tracks consecutive blocked operations per agent. When the count exceeds
 * `threshold`, the circuit trips and the agent is auto-blocked until
 * `resetAfterMs` milliseconds have elapsed since the trip (or until manually
 * reset via `reset()`).
 *
 * Usage in createPipeline: pass an instance as `circuitBreaker`. When an
 * operation is blocked for ANY reason, call `record(agentId)`. Before scoring,
 * call `isOpen(agentId)` — if true, block immediately with a circuit-open reason.
 */

export interface CircuitBreakerOptions {
  /**
   * Number of consecutive blocks that trip the circuit for an agent.
   * Default: 5.
   */
  threshold?: number;
  /**
   * Milliseconds after which a tripped circuit resets automatically.
   * Default: 60_000 (1 minute). Set to 0 to disable auto-reset.
   */
  resetAfterMs?: number;
}

interface AgentState {
  consecutiveBlocks: number;
  trippedAt?: number; // epoch ms when circuit was tripped
}

export class AgentCircuitBreaker {
  private readonly threshold: number;
  private readonly resetAfterMs: number;
  private readonly state = new Map<string, AgentState>();

  constructor(options: CircuitBreakerOptions = {}) {
    this.threshold = options.threshold ?? 5;
    this.resetAfterMs = options.resetAfterMs ?? 60_000;
  }

  /**
   * Returns true when the agent's circuit is open (agent is auto-blocked).
   * Auto-resets the circuit if `resetAfterMs` has elapsed since it tripped.
   */
  isOpen(agentId: string): boolean {
    const s = this.state.get(agentId);
    if (!s || s.trippedAt === undefined) return false;

    if (this.resetAfterMs > 0 && Date.now() - s.trippedAt >= this.resetAfterMs) {
      // Auto-reset
      this.state.set(agentId, { consecutiveBlocks: 0 });
      return false;
    }

    return true;
  }

  /**
   * Record a blocked operation for an agent.
   * Increments the consecutive-block counter; trips the circuit when threshold is reached.
   */
  recordBlock(agentId: string): void {
    const s = this.state.get(agentId) ?? { consecutiveBlocks: 0 };
    if (s.trippedAt !== undefined) return; // already open, no-op

    s.consecutiveBlocks++;
    if (s.consecutiveBlocks >= this.threshold) {
      s.trippedAt = Date.now();
    }
    this.state.set(agentId, s);
  }

  /**
   * Record a successful (allowed) operation — resets the consecutive-block counter.
   */
  recordAllow(agentId: string): void {
    const s = this.state.get(agentId);
    if (!s || s.trippedAt !== undefined) return; // tripped circuit stays tripped until timeout
    s.consecutiveBlocks = 0;
    this.state.set(agentId, s);
  }

  /**
   * Manually reset the circuit for an agent (or all agents when called with no argument).
   */
  reset(agentId?: string): void {
    if (agentId !== undefined) {
      this.state.delete(agentId);
    } else {
      this.state.clear();
    }
  }

  /** Return the current consecutive-block count for an agent. */
  getConsecutiveBlocks(agentId: string): number {
    return this.state.get(agentId)?.consecutiveBlocks ?? 0;
  }

  /** Return the epoch ms when the circuit tripped, or undefined if closed. */
  getTrippedAt(agentId: string): number | undefined {
    return this.state.get(agentId)?.trippedAt;
  }

  /**
   * Return a snapshot of all tracked agent states.
   * Each entry reflects the current open/closed status after auto-reset checks.
   */
  getAll(): Array<{ agentId: string; isOpen: boolean; consecutiveBlocks: number; trippedAt?: number }> {
    const result: Array<{ agentId: string; isOpen: boolean; consecutiveBlocks: number; trippedAt?: number }> = [];
    for (const [agentId] of this.state) {
      result.push({
        agentId,
        isOpen: this.isOpen(agentId),
        consecutiveBlocks: this.getConsecutiveBlocks(agentId),
        trippedAt: this.getTrippedAt(agentId),
      });
    }
    return result;
  }
}
