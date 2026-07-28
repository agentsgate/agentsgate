/**
 * Per-agent sliding-window rate limiter with burst allowance support.
 *
 * Each agent is checked against:
 *   1. A main sliding window  — maxOpsPerWindow ops per windowMs (default: 60s)
 *   2. An optional burst window — burstAllowance extra ops per burstWindowMs (default: 5s)
 *
 * An operation is allowed if it passes EITHER the main window check OR the burst check.
 * Per-agent limits override the global default.
 */

export interface RateLimitConfig {
  /** Maximum operations allowed in the main window. */
  maxOpsPerWindow: number;
  /** Duration of the main window in milliseconds (default: 60_000). */
  windowMs?: number;
  /**
   * Extra operations allowed in a short burst window above the sustained rate.
   * When unset (or 0), bursting is disabled.
   */
  burstAllowance?: number;
  /** Duration of the burst window in milliseconds (default: 5_000). */
  burstWindowMs?: number;
}

export class AgentRateLimiter {
  private readonly globalConfig: Required<RateLimitConfig>;
  private readonly agentConfigs: Map<string, Required<RateLimitConfig>>;
  private readonly timestamps = new Map<string, number[]>();

  /**
   * @param globalLimit  Global default: either ops-per-minute (legacy number) or a full config.
   * @param windowMs     Window duration in ms (only used when globalLimit is a number).
   * @param agentLimits  Per-agent config overrides keyed by agentId.
   */
  constructor(
    globalLimit: number | RateLimitConfig,
    windowMs = 60_000,
    agentLimits: Record<string, RateLimitConfig> = {}
  ) {
    this.globalConfig = normalizeConfig(
      typeof globalLimit === 'number'
        ? { maxOpsPerWindow: globalLimit, windowMs }
        : globalLimit
    );
    this.agentConfigs = new Map(
      Object.entries(agentLimits).map(([id, cfg]) => [id, normalizeConfig(cfg)])
    );
  }

  /**
   * Record an operation for agentId and return whether it is within the rate limit.
   *
   * Returns true (allowed) or false (limit exceeded).
   */
  check(agentId: string): boolean {
    const cfg = this.agentConfigs.get(agentId) ?? this.globalConfig;
    const now = Date.now();

    // Prune timestamps outside the main window, then push current
    const allStamps = this.timestamps.get(agentId) ?? [];
    const recent = allStamps.filter(t => now - t < cfg.windowMs);
    recent.push(now);
    this.timestamps.set(agentId, recent);

    // Main window: allow if under the sustained rate limit
    if (recent.length <= cfg.maxOpsPerWindow) return true;

    // Burst window: allow up to (maxOpsPerWindow + burstAllowance) ops in the short window
    if (cfg.burstAllowance > 0) {
      const burstCount = recent.filter(t => now - t < cfg.burstWindowMs).length;
      if (burstCount <= cfg.maxOpsPerWindow + cfg.burstAllowance) return true;
    }

    return false;
  }

  /** Return the current operation count for an agent within the main window. */
  getCount(agentId: string): number {
    const cfg = this.agentConfigs.get(agentId) ?? this.globalConfig;
    const now = Date.now();
    return (this.timestamps.get(agentId) ?? []).filter(t => now - t < cfg.windowMs).length;
  }

  /** Return the current burst-window count for an agent. */
  getBurstCount(agentId: string): number {
    const cfg = this.agentConfigs.get(agentId) ?? this.globalConfig;
    const now = Date.now();
    return (this.timestamps.get(agentId) ?? []).filter(t => now - t < cfg.burstWindowMs).length;
  }

  /** Return the resolved config for an agent (own config or global default). */
  getConfig(agentId: string): Required<RateLimitConfig> {
    return this.agentConfigs.get(agentId) ?? this.globalConfig;
  }

  /**
   * Return current stats for all tracked agents.
   * Useful for the dashboard /rate-limits endpoint.
   */
  getAll(): Array<{ agentId: string; count: number; limit: number; windowMs: number; limited: boolean }> {
    const now = Date.now();
    const result: Array<{ agentId: string; count: number; limit: number; windowMs: number; limited: boolean }> = [];
    for (const [agentId, stamps] of this.timestamps.entries()) {
      const cfg = this.agentConfigs.get(agentId) ?? this.globalConfig;
      const count = stamps.filter(t => now - t < cfg.windowMs).length;
      result.push({ agentId, count, limit: cfg.maxOpsPerWindow, windowMs: cfg.windowMs, limited: count >= cfg.maxOpsPerWindow });
    }
    return result;
  }

  /** Clear all recorded timestamps (useful for testing). */
  reset(): void {
    this.timestamps.clear();
  }
}

/**
 * T146 — Per-tool sliding-window rate limiter keyed by (agentId, tool).
 *
 * Allows you to set tighter limits on specific tools (e.g. allow only 5 shell
 * calls per agent per minute) independently of the per-agent global limit.
 */
export interface ToolRateLimitConfig {
  /** Maximum operations per (agent, tool) pair in the window. */
  maxOpsPerWindow: number;
  /** Window duration in milliseconds (default: 60_000). */
  windowMs?: number;
}

export class ToolRateLimiter {
  private readonly globalConfig: Required<ToolRateLimitConfig>;
  /** Per-tool default configs (key = tool name, exact or /regex/). */
  private readonly toolConfigs: Array<[string, Required<ToolRateLimitConfig>]>;
  /** Per-(agentId, tool) timestamp buckets. */
  private readonly timestamps = new Map<string, number[]>();

  /**
   * @param global       Global per-tool default (ops per window for any tool).
   * @param toolLimits   Per-tool overrides keyed by tool name (exact match first, then /regex/).
   */
  constructor(
    global: number | ToolRateLimitConfig,
    toolLimits: Record<string, ToolRateLimitConfig> = {}
  ) {
    this.globalConfig = normalizeToolConfig(
      typeof global === 'number' ? { maxOpsPerWindow: global } : global
    );
    this.toolConfigs = Object.entries(toolLimits).map(
      ([k, v]) => [k, normalizeToolConfig(v)]
    );
  }

  /**
   * Record an operation for (agentId, tool) and return true if within limit.
   */
  check(agentId: string, tool: string): boolean {
    const cfg = this.resolveConfig(tool);
    const key = `${agentId}:${tool}`;
    const now = Date.now();
    const recent = (this.timestamps.get(key) ?? []).filter(t => now - t < cfg.windowMs);
    recent.push(now);
    this.timestamps.set(key, recent);
    return recent.length <= cfg.maxOpsPerWindow;
  }

  /** Return the current call count for (agentId, tool) within the window. */
  getCount(agentId: string, tool: string): number {
    const cfg = this.resolveConfig(tool);
    const key = `${agentId}:${tool}`;
    const now = Date.now();
    return (this.timestamps.get(key) ?? []).filter(t => now - t < cfg.windowMs).length;
  }

  /** Clear all recorded timestamps. */
  reset(): void { this.timestamps.clear(); }

  private resolveConfig(tool: string): Required<ToolRateLimitConfig> {
    for (const [pattern, cfg] of this.toolConfigs) {
      if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
        try {
          if (new RegExp(pattern.slice(1, -1), 'i').test(tool)) return cfg;
        } catch { /* invalid regex — skip */ }
      } else if (pattern === tool) {
        return cfg;
      }
    }
    return this.globalConfig;
  }
}

function normalizeToolConfig(cfg: ToolRateLimitConfig): Required<ToolRateLimitConfig> {
  return { maxOpsPerWindow: cfg.maxOpsPerWindow, windowMs: cfg.windowMs ?? 60_000 };
}

function normalizeConfig(cfg: RateLimitConfig): Required<RateLimitConfig> {
  return {
    maxOpsPerWindow: cfg.maxOpsPerWindow,
    windowMs:        cfg.windowMs        ?? 60_000,
    burstAllowance:  cfg.burstAllowance  ?? 0,
    burstWindowMs:   cfg.burstWindowMs   ?? 5_000,
  };
}
