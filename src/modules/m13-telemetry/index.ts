import type { MCPOperation, ProxyDecision } from '../../types/interfaces.js';
import { assertSafeOutboundUrl } from '../../utils/url-safety.js';
import { AGENTSGATE_VERSION } from '../../version.js';

/**
 * Telemetry sinks — stats collectors, OTLP receivers, alert routers — routinely
 * live on a private network or on loopback next to the proxy, so the strict
 * denylist used for external webhooks would reject legitimate deployments.
 * These paths block only the link-local/metadata range, which is the address
 * an SSRF is actually worth aiming at (169.254.169.254 and friends).
 */
const TELEMETRY_URL_CHECK = { mode: 'metadata-only' } as const;

/** Anonymized record of a single proxy event — no file paths, no agent IDs. */
interface TelemetryEvent {
  tool: string;
  method: string;
  action: ProxyDecision['action'];
  riskScore: number;
  triggeredRuleCount: number;
  timestamp: number; // epoch ms
  /** Anonymized session identifier — retained for per-session rollup. */
  sessionId: string;
  /** Execution duration in ms (from executionResult.durationMs). */
  durationMs?: number;
}

/** Per-session aggregate statistics returned by getSessionStats(). */
export interface SessionTelemetryStats {
  sessionId: string;
  totalEvents: number;
  byAction: Record<ProxyDecision['action'], number>;
  avgRiskScore: number;
  maxRiskScore: number;
  byTool: Record<string, number>;
  firstEvent: number; // epoch ms
  lastEvent: number;  // epoch ms
}

/** Result of exportTo(). */
export interface TelemetryExportResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
}

/** Anomaly alert emitted by detectAnomalies(). */
export interface AnomalyAlert {
  /** Tool name the spike was detected for. */
  tool: string;
  /** Which metric spiked (e.g. "avg_risk_score"). */
  metric: string;
  /** Observed value of the metric in the recent sub-window. */
  value: number;
  /** z-score relative to the historical window distribution. */
  zScore: number;
  /** The threshold that was exceeded. */
  threshold: number;
  detectedAt: Date;
}

/** Summary returned by getStats(). */
export interface TelemetryStats {
  /** Total events recorded since last flush. */
  totalEvents: number;
  /** Event count per tool name. */
  byTool: Record<string, number>;
  /** Event count per action. */
  byAction: Record<ProxyDecision['action'], number>;
  /** Risk score histogram (buckets: 0–0.2, 0.2–0.4, 0.4–0.6, 0.6–0.8, 0.8–1.0). */
  riskHistogram: Record<string, number>;
  /** Average risk score. */
  avgRiskScore: number;
  /** Total cost units accumulated (based on configured per-tool weights). */
  totalCost: number;
  /** Cost units broken down by tool. */
  costByTool: Record<string, number>;
  /** Current number of events in the buffer (may be less than totalEvents if ring-buffer eviction occurred). */
  bufferSize: number;
  /**
   * Average operation execution duration (ms) per tool.
   * Only includes events where executionResult.durationMs is present.
   */
  avgDurationByTool: Record<string, number>;
}

/**
 * M13: Telemetry & Analytics
 * Buffers anonymized operation events in memory and exposes aggregate stats.
 * Privacy: agent IDs and file paths are never stored.
 */
export class TelemetryService {
  private readonly buffer: TelemetryEvent[] = [];
  /**
   * Per-tool cost weights. Key = tool name (exact or /regex/).
   * Default cost for unmatched tools is 1.0.
   */
  private readonly costWeights: Array<[string, number]>;
  /**
   * Maximum number of events to retain. When exceeded, the oldest event is
   * evicted before adding the new one (ring-buffer semantics).
   * Undefined = unlimited.
   */
  private readonly maxEvents?: number;

  /**
   * @param costWeights - optional per-tool cost weights.
   * @param maxEvents - optional cap on in-memory event count (ring-buffer).
   */
  constructor(costWeights: Record<string, number> = {}, maxEvents?: number) {
    this.costWeights = Object.entries(costWeights);
    this.maxEvents = maxEvents;
  }

  private resolveCost(tool: string): number {
    for (const [pattern, cost] of this.costWeights) {
      if (pattern.startsWith('/') && pattern.endsWith('/') && pattern.length > 2) {
        try {
          if (new RegExp(pattern.slice(1, -1), 'i').test(tool)) return cost;
        } catch { /* invalid regex */ }
      } else if (pattern === tool) {
        return cost;
      }
    }
    return 1.0;
  }

  /**
   * Return total cost units accumulated since service start.
   * Each recorded operation costs `resolveCost(tool)` units.
   */
  getTotalCost(): number {
    return this.buffer.reduce((sum, e) => sum + this.resolveCost(e.tool), 0);
  }

  /**
   * Return cost breakdown by tool name.
   */
  getCostByTool(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const e of this.buffer) {
      result[e.tool] = (result[e.tool] ?? 0) + this.resolveCost(e.tool);
    }
    return result;
  }

  /**
   * Return aggregate statistics for a single session.
   * Returns null when no events for that session are in the buffer.
   */
  getSessionStats(sessionId: string): SessionTelemetryStats | null {
    const events = this.buffer.filter(e => e.sessionId === sessionId);
    if (events.length === 0) return null;

    const byAction: Record<string, number> = { allow: 0, block: 0, require_approval: 0 };
    const byTool: Record<string, number> = {};
    let riskSum = 0;
    let maxRisk = 0;
    let firstEvent = Infinity;
    let lastEvent = 0;

    for (const e of events) {
      byAction[e.action] = (byAction[e.action] ?? 0) + 1;
      byTool[e.tool] = (byTool[e.tool] ?? 0) + 1;
      riskSum += e.riskScore;
      if (e.riskScore > maxRisk) maxRisk = e.riskScore;
      if (e.timestamp < firstEvent) firstEvent = e.timestamp;
      if (e.timestamp > lastEvent) lastEvent = e.timestamp;
    }

    return {
      sessionId,
      totalEvents: events.length,
      byAction: byAction as SessionTelemetryStats['byAction'],
      avgRiskScore: riskSum / events.length,
      maxRiskScore: maxRisk,
      byTool,
      firstEvent,
      lastEvent,
    };
  }

  /**
   * Return a list of all session IDs that have events in the buffer.
   */
  listSessions(): string[] {
    return [...new Set(this.buffer.map(e => e.sessionId))];
  }

  /**
   * Record one proxy event. Strips PII — only tool, method, action, and risk score
   * are retained. Agent IDs, session IDs, and params (which may contain file paths)
   * are discarded.
   */
  async record(operation: MCPOperation, decision: ProxyDecision, result?: { durationMs?: number }): Promise<void> {
    const triggeredRuleCount =
      (decision.reasons?.filter(r => r.startsWith('Triggered rule:')) ?? []).length;

    if (this.maxEvents !== undefined && this.buffer.length >= this.maxEvents) {
      this.buffer.shift(); // evict oldest
    }
    this.buffer.push({
      tool: operation.tool,
      method: operation.method,
      action: decision.action,
      riskScore: decision.riskScore,
      triggeredRuleCount,
      timestamp: Date.now(),
      sessionId: operation.sessionId,
      durationMs: result?.durationMs,
    });
  }

  /** Return aggregate statistics over all buffered events. */
  async getStats(): Promise<TelemetryStats> {
    const byTool: Record<string, number> = {};
    const byAction: Record<string, number> = { allow: 0, block: 0, require_approval: 0 };
    const riskHistogram: Record<string, number> = {
      '0.0-0.2': 0, '0.2-0.4': 0, '0.4-0.6': 0, '0.6-0.8': 0, '0.8-1.0': 0,
    };
    let riskSum = 0;

    // Duration tracking for avgDurationByTool
    const durationSums = new Map<string, number>();
    const durationCounts = new Map<string, number>();

    for (const ev of this.buffer) {
      byTool[ev.tool] = (byTool[ev.tool] ?? 0) + 1;
      byAction[ev.action] = (byAction[ev.action] ?? 0) + 1;
      riskSum += ev.riskScore;
      const bucket = riskBucket(ev.riskScore);
      riskHistogram[bucket] = (riskHistogram[bucket] ?? 0) + 1;

      if (ev.durationMs !== undefined && ev.durationMs >= 0) {
        const prev = durationSums.get(ev.tool) ?? 0;
        const prevCount = durationCounts.get(ev.tool) ?? 0;
        durationSums.set(ev.tool, prev + ev.durationMs);
        durationCounts.set(ev.tool, prevCount + 1);
      }
    }

    const avgDurationByTool: Record<string, number> = {};
    for (const [tool, sum] of durationSums) {
      avgDurationByTool[tool] = sum / (durationCounts.get(tool) ?? 1);
    }

    return {
      totalEvents: this.buffer.length,
      byTool,
      byAction: byAction as TelemetryStats['byAction'],
      riskHistogram,
      avgRiskScore: this.buffer.length > 0 ? riskSum / this.buffer.length : 0,
      totalCost: this.getTotalCost(),
      costByTool: this.getCostByTool(),
      bufferSize: this.buffer.length,
      avgDurationByTool,
    };
  }

  /**
   * Export anonymized stats to a remote HTTP endpoint via POST.
   * The payload is `{ stats, exportedAt }` as JSON.
   * On success, flushes the local buffer.
   */
  async exportTo(endpoint: string): Promise<TelemetryExportResult> {
    try {
      await assertSafeOutboundUrl(endpoint, TELEMETRY_URL_CHECK);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    const stats = await this.getStats();
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ stats, exportedAt: new Date().toISOString() }),
      });
      if (res.ok) await this.flush();
      return { ok: res.ok, statusCode: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Detect per-tool risk score anomalies using a z-score test.
   *
   * Events within `windowMs` are grouped by tool. For each tool the mean and
   * stddev of risk scores are computed across the full window. The most recent
   * 20 % of the window is treated as the "current" sub-window; if its average
   * risk score deviates more than `zScoreThreshold` standard deviations above
   * the historical mean an alert is emitted.
   *
   * Returns an empty array when fewer than 5 events are in the window (not
   * enough data to compute a reliable baseline).
   *
   * @param windowMs       Look-back window in milliseconds (default 1 hour).
   * @param zScoreThreshold  Minimum z-score to emit an alert (default 2.0).
   */
  async detectAnomalies(windowMs = 3_600_000, zScoreThreshold = 2.0): Promise<AnomalyAlert[]> {
    const now = Date.now();
    const cutoff = now - windowMs;
    const events = this.buffer.filter(e => e.timestamp >= cutoff);
    if (events.length < 5) return [];

    // Collect unique tool names seen in the window
    const tools = [...new Set(events.map(e => e.tool))];

    const alerts: AnomalyAlert[] = [];
    // Recent sub-window = last 20 % of the look-back period
    const recentCutoff = now - windowMs * 0.2;

    for (const tool of tools) {
      // Baseline: events BEFORE the recent sub-window (historical only)
      const historicalScores = events
        .filter(e => e.tool === tool && e.timestamp < recentCutoff)
        .map(e => e.riskScore);
      if (historicalScores.length < 3) continue;

      const mean = historicalScores.reduce((s, v) => s + v, 0) / historicalScores.length;
      const variance = historicalScores.reduce((s, v) => s + (v - mean) ** 2, 0) / historicalScores.length;
      const stddev = Math.sqrt(variance);
      if (stddev === 0) continue;

      // Current: events inside the recent sub-window
      const recentScores = events
        .filter(e => e.tool === tool && e.timestamp >= recentCutoff)
        .map(e => e.riskScore);
      if (recentScores.length === 0) continue;

      const recentAvg = recentScores.reduce((s, v) => s + v, 0) / recentScores.length;
      const zScore = (recentAvg - mean) / stddev;

      if (zScore > zScoreThreshold) {
        alerts.push({ tool, metric: 'avg_risk_score', value: recentAvg, zScore, threshold: zScoreThreshold, detectedAt: new Date() });
      }
    }

    return alerts;
  }

  /**
   * Run anomaly detection and POST any alerts to `webhookUrl` as JSON.
   *
   * Payload: `{ alerts: AnomalyAlert[], detectedAt: string }`
   * Each `AnomalyAlert.detectedAt` is serialized to an ISO string in the payload.
   *
   * Returns the fired alerts (empty array if none, or if the webhook POST fails —
   * the error is silently swallowed so callers need not handle network failures).
   *
   * @param webhookUrl       HTTP(S) endpoint to POST to.
   * @param windowMs         Look-back window passed to detectAnomalies().
   * @param zScoreThreshold  z-score threshold passed to detectAnomalies().
   * @param webhookSecret    Optional HMAC-SHA256 secret. When set, adds an
   *                         `X-AgentsGate-Signature: sha256=<hex>` header.
   */
  async checkAndNotify(
    webhookUrl: string,
    windowMs?: number,
    zScoreThreshold?: number,
    webhookSecret?: string
  ): Promise<AnomalyAlert[]> {
    const alerts = await this.detectAnomalies(windowMs, zScoreThreshold);
    if (alerts.length === 0) return alerts;

    try {
      const body = JSON.stringify({
        alerts: alerts.map(a => ({ ...a, detectedAt: a.detectedAt.toISOString() })),
        detectedAt: new Date().toISOString(),
      });
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (webhookSecret) {
        const { createHmac } = await import('node:crypto');
        const sig = createHmac('sha256', webhookSecret).update(body).digest('hex');
        headers['X-AgentsGate-Signature'] = `sha256=${sig}`;
      }
      await assertSafeOutboundUrl(webhookUrl, TELEMETRY_URL_CHECK);
      await fetch(webhookUrl, {
        method: 'POST',
        headers,
        body,
      });
    } catch {
      // Rejected URL or network failure — do not rethrow; anomaly detection
      // continues regardless
    }

    return alerts;
  }

  /**
   * Flush the in-memory buffer.
   */
  async flush(): Promise<void> {
    this.buffer.length = 0;
  }

  /**
   * Export buffered telemetry as OTLP Metrics JSON to an OpenTelemetry collector.
   *
   * Sends a POST to `${endpoint}/v1/metrics` using the OTLP/HTTP JSON encoding.
   * Each metric is a Sum (monotonic, cumulative) data point derived from the
   * current buffered stats. On success, flushes the local buffer.
   *
   * @param endpoint Base URL of the OTLP collector (e.g. "http://localhost:4318")
   */
  async exportOTLP(endpoint: string): Promise<TelemetryExportResult> {
    const stats = await this.getStats();
    const nowNs = String(BigInt(Date.now()) * 1_000_000n);
    const startNs = String(0n); // monotonic from process start

    /** Build a single integer Sum metric data point. */
    const intSum = (name: string, description: string, value: number, attrs: Record<string, string> = {}) => ({
      name,
      description,
      unit: '{operations}',
      sum: {
        dataPoints: [{
          attributes: Object.entries(attrs).map(([k, v]) => ({
            key: k, value: { stringValue: v },
          })),
          startTimeUnixNano: startNs,
          timeUnixNano: nowNs,
          asInt: String(value),
        }],
        aggregationTemporality: 2, // CUMULATIVE
        isMonotonic: true,
      },
    });

    /** Build a double Gauge metric. */
    const doubleGauge = (name: string, description: string, value: number) => ({
      name,
      description,
      unit: '1',
      gauge: {
        dataPoints: [{
          attributes: [],
          timeUnixNano: nowNs,
          asDouble: value,
        }],
      },
    });

    const metrics = [
      intSum('agentsgate.operations.total', 'Total intercepted MCP operations', stats.totalEvents),
      intSum('agentsgate.operations.allow', 'Operations allowed', stats.byAction.allow),
      intSum('agentsgate.operations.block', 'Operations blocked', stats.byAction.block),
      intSum('agentsgate.operations.require_approval', 'Operations requiring approval', stats.byAction.require_approval),
      doubleGauge('agentsgate.risk.avg', 'Average risk score', stats.avgRiskScore),
      // Per-tool counts
      ...Object.entries(stats.byTool).map(([tool, count]) =>
        intSum('agentsgate.operations.by_tool', `Operations by tool`, count, { tool })
      ),
      // Risk histogram buckets
      ...Object.entries(stats.riskHistogram).map(([bucket, count]) =>
        intSum('agentsgate.risk.histogram', 'Risk score histogram', count, { bucket })
      ),
    ];

    const payload = {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'agentsgate' } },
            { key: 'service.version', value: { stringValue: AGENTSGATE_VERSION } },
          ],
        },
        scopeMetrics: [{
          scope: { name: 'agentsgate.telemetry', version: AGENTSGATE_VERSION },
          metrics,
        }],
      }],
    };

    const url = endpoint.replace(/\/$/, '') + '/v1/metrics';
    try {
      await assertSafeOutboundUrl(url, TELEMETRY_URL_CHECK);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (res.ok) await this.flush();
      return { ok: res.ok, statusCode: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

function riskBucket(score: number): string {
  if (score < 0.2) return '0.0-0.2';
  if (score < 0.4) return '0.2-0.4';
  if (score < 0.6) return '0.4-0.6';
  if (score < 0.8) return '0.6-0.8';
  return '0.8-1.0';
}
