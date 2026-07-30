# AgentsGate

[![CI](https://github.com/agentsgate/agentsgate/actions/workflows/ci.yml/badge.svg)](https://github.com/agentsgate/agentsgate/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/agentsgate.svg)](https://www.npmjs.com/package/agentsgate)
[![Node](https://img.shields.io/node/v/agentsgate.svg)](https://nodejs.org)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**AI Agent I/O Tracking & Rollback System — MCP Proxy Gateway**

> **Status: 0.1.0, first public release.** The proxy, risk scoring, checkpoints
> and rollback are covered by 7,200 tests, but the API surface should be treated
> as unstable until 1.0 — command flags and config keys may still change. Read
> [SECURITY.md](SECURITY.md) before exposing anything beyond loopback.

AgentsGate sits between AI agents (Claude, GPT, etc.) and the MCP tools they call. Every tool call is intercepted, risk-scored, checkpointed, and optionally paused for human approval before execution. If an agent does something destructive, you can roll back in seconds.

```
AI Agent (Claude, GPT, etc.)
        ↓ MCP Protocol
  ┌──────────────────────────┐
  │   AgentsGate Proxy      │  ← All traffic passes here
  └────────┬─────────────────┘
           │
    ┌──────▼──────┐    ┌──────────────────────┐    ┌────────────────────┐
    │   Logger    │    │  Risk Engine (L1/L2) │    │  Policy Engine     │
    └──────┬──────┘    └──────┬───────────────┘    └────────┬───────────┘
           │                  │                             │
    ┌──────▼──────────────────▼─────────────────────────────▼───────────┐
    │                     SQLite State Store                             │
    └──────────────────────────────┬─────────────────────────────────────┘
                                   │
                          ┌────────▼────────┐
                          │  Intervention   │  ← Block / Allow / Require-approval
                          └────────┬────────┘
                                   │
               allowed ────────────┤──────────── blocked / pending
                                   ↓
                          ┌────────▼────────┐
                          │  Actual MCP Tool│
                          └─────────────────┘

   Dashboard REST API  ←→  SQLite  (read-only visibility, real-time SSE)
```

---

## Security model — read this first

AgentsGate is a **local, single-operator tool**. It records everything your agent
does, including tool arguments and results that routinely contain file contents,
database rows, and credentials.

**The proxy transport has no authentication, and the dashboard's is opt-in.**
That is safe only because AgentsGate binds to loopback by default:

| Surface | Default port | Default bind | Built-in auth |
|---------|--------------|--------------|---------------|
| MCP proxy | `4000` | `127.0.0.1` | **None** |
| Dashboard REST/SSE | `4001` | `127.0.0.1` | Opt-in (`dashboard.apiKey`) |

`proxy.host` controls the bind address for the proxy, dashboard, and WebSocket
gateway. Leave it at `127.0.0.1` unless you know exactly what you are doing.

> **If you set `proxy.host` to a routable address, you must put an
> authenticating reverse proxy in front of it.** No AgentsGate setting alone
> makes a non-loopback bind safe — exposing it without a reverse proxy means
> unauthenticated operation forwarding plus full read access to your agent's
> history. AgentsGate prints a startup warning when you do this; treat it as an
> error in production.

For the full threat model, residual risks, and a deployment checklist, see
[SECURITY.md](SECURITY.md).

---

## Features

**Proxy & Interception**
- Zero-trust MCP proxy — every tool call intercepted regardless of agent cooperation
- Stdio transport support (`MCPStdioProxy`) for pipe-based MCP clients
- Dry-run mode (`--dry-run`) — scores and logs without blocking any operations
- Per-operation session tracking, agent identification, and tag propagation

**Risk Scoring**
- L1 static rules — 8 built-in rules covering destructive file ops, sensitive path writes, database drops, command execution, git force-push
- L2 user history — per-agent Bayesian model (requires ≥10 outcomes)
- L3 community enrichment — configurable HTTP endpoint (opt-in)

**Checkpoints & Rollback**
- Pre-operation file snapshots into a shadow git repository
- One-command rollback to any checkpoint
- Checkpoint diff view before restoring
- Rollback preview (dry-run before committing restore)

**Policy System**
- Custom policy rules loaded from `~/.agentsgate/policy.json`
- Per-rule match on tool, method, agentId, pathPattern, and tags
- Rule actions: `allow`, `block`, `require_approval`, or score override
- Agent allowlist / denylist
- Per-agent tool allowlist / denylist
- L1 rule muting and score overrides
- Live policy stats via the dashboard

**Approval Queue**
- Pending operations pause at the proxy until approved or denied
- Webhook notifications (with retry) on enqueue
- Slack Incoming Webhook integration
- Escalation webhooks for stale approvals
- Approvals persist across restarts (SQLite-backed)
- Auto-expiry with configurable TTL (default 24h)
- Real-time SSE push when approvals expire

**Dashboard API** (see [docs/api-reference.md](docs/api-reference.md))
- Full REST API: operations, agents, tools, sessions, risk, checkpoints, rollback, approvals, policy, telemetry, circuit breakers, rate limits, quota, audit
- Server-Sent Events (`GET /events`) for live operation feed
- Prometheus metrics (`GET /metrics`)
- RBAC via `X-API-Key` header
- Audit log HMAC-SHA256 verification (`GET /audit/verify`)
- CSV export for operations

**Telemetry & Analytics**
- Anonymized aggregate stats — zero PII stored
- Anomaly detection with z-score alerting (configurable threshold)
- Periodic export to a configurable HTTP endpoint
- Per-agent, per-tool, per-session telemetry breakdowns

**Plugin Adapters**
- `BaseRollbackAdapter` base class for extending rollback to SaaS tools
- Community adapter registry — load adapters from a directory

**Operations Management**
- Per-agent and per-tool operation history
- Full-text and filter-based search across operations
- Rate limiting per agent (ops/minute)
- Circuit breaker per agent
- Daily quota management per agent
- Log retention and pruning

**Developer / Ops Tools**
- `agentsgate doctor` — environment health check
- `agentsgate benchmark` — throughput benchmark
- `agentsgate inject` / `eject` — auto-configure Claude Desktop
- `agentsgate completion` — shell autocomplete

---

## Installation

```bash
npm install -g agentsgate
```

Or run directly without installing:

```bash
npx agentsgate start
```

For local development from a fresh clone:

```bash
git clone https://github.com/agentsgate/agentsgate.git
cd agentsgate
npm run bootstrap
```

---

## Quick Start

```bash
# Start the proxy (default port 4000, dashboard on port 4001)
agentsgate start

# Start on a custom port
agentsgate start 8080

# Check that the proxy is running
agentsgate status

# Show effective config
agentsgate config

# Show dashboard health
agentsgate health
```

### Configure Claude Desktop

```bash
# Auto-inject AgentsGate into Claude Desktop's MCP config
agentsgate inject

# Verify injection
agentsgate status

# Remove injection
agentsgate eject
```

Restart Claude Desktop after injection. All Claude tool calls now flow through AgentsGate.

---

## CLI Reference

See **[docs/cli.md](docs/cli.md)** for every command and flag, grouped by
category. The most common ones:

| Command | Description |
|---------|-------------|
| `agentsgate start [port]` | Start the proxy and dashboard |
| `agentsgate stop` | Stop the running proxy |
| `agentsgate status` | Show proxy PID, port, dashboard URL, and start time |
| `agentsgate doctor` | Self-check config, database, shadow repo, and injection |
| `agentsgate inject` | Register AgentsGate in Claude Desktop's MCP config |
| `agentsgate ops tail [--limit=N]` | Tail recent operations |
| `agentsgate approvals` | List operations waiting for approval |
| `agentsgate rollback <checkpointId>` | Roll back to a checkpoint |
| `agentsgate --version` | Print the version |

---

## Dashboard API

While the proxy is running, a REST server on `port+1` (default: 4001) provides full visibility and control. See **[docs/api-reference.md](docs/api-reference.md)** for the complete endpoint reference.

Key features:
- All endpoints (except `GET /health`) require `X-API-Key` header when `dashboard.apiKey` is set
- Real-time events via `GET /events` (Server-Sent Events)
- Prometheus metrics via `GET /metrics`
- CSV export via `GET /operations/export`
- Rollback via `POST /rollback/:checkpointId`
- Approval management via `POST /approvals/:id/approve` and `POST /approvals/:id/deny`

---

## Risk Scoring

Operations are scored 0.0 (safe) → 1.0 (extremely risky) using three layers:

| Layer | Source | Status |
|-------|--------|--------|
| L1 Static rules | Built-in rule set | Always active |
| L2 User history | Per-agent Bayesian model | Active (requires ≥10 outcomes) |
| L3 Community | Configurable HTTP enrichment | Opt-in via `intelligence.communityEndpoint` |

### L1 Rules

| Rule ID | Trigger | Default Score |
|---------|---------|---------------|
| `L1_DELETE_FILE` | `delete_file`, `unlink`, `rm` on filesystem tools | 0.90 |
| `L1_SENSITIVE_PATH_WRITE` | Write to `.env`, `.ssh/`, `.aws/`, `credentials`, etc. | 0.90 |
| `L1_DROP_TABLE` | `drop`/`truncate` on non-filesystem tools | 0.95 |
| `L1_DELETE_RECORD` | `delete`/`remove` on non-filesystem tools | 0.75 |
| `L1_EXECUTE_COMMAND` | `execute`, `exec`, `shell`, `spawn` | 0.80 |
| `L1_GIT_FORCE_PUSH` | `force`/`reset`/`rebase` on github/git tools | 0.85 |
| `L1_OVERWRITE_FILE` | `write_file`, `overwrite`, `create` on filesystem | 0.65 |
| `L1_READ_ONLY` | `read_*`, `list_*`, `get_*`, `describe_*`, etc. | 0.05 |

### Intervention thresholds (default)

| Score range | Action |
|-------------|--------|
| < 0.3 | `allow` — proceed immediately |
| 0.3 – 0.69 | `require_approval` — pause, create checkpoint, wait for user |
| ≥ 0.7 | `block` — reject outright |

Override thresholds in `policy.json` or `config.json`.

---

## Policy System

Create `~/.agentsgate/policy.json` to define custom rules:

```json
{
  "rules": [
    {
      "id": "BLOCK_PROD_DB_DELETE",
      "description": "Always block deletes on the production database tool",
      "match": { "tool": "database", "method": "/delete|drop/i" },
      "action": "block"
    },
    {
      "id": "TRUST_READONLY_AGENT",
      "description": "Treat all ops from the readonly-agent as low risk",
      "match": { "agentId": "readonly-agent" },
      "score": 0.05
    },
    {
      "id": "ELEVATE_SECRET_WRITES",
      "description": "Treat writes to /secrets/ as very high risk",
      "match": { "pathPattern": "/secrets/" },
      "score": 0.95
    }
  ],
  "thresholds": { "allowBelow": 0.2, "blockAtOrAbove": 0.8 },
  "agents": {
    "denylist": ["untrusted-agent-*"],
    "allowlist": [],
    "toolRules": {
      "limited-agent": {
        "allowlist": ["filesystem", "search"]
      }
    }
  },
  "mutedRules": [],
  "ruleOverrides": {
    "L1_OVERWRITE_FILE": 0.4
  }
}
```

### Policy rule fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique rule identifier |
| `description` | string | Human-readable description (optional) |
| `match.tool` | string | Exact or `/regex/` match on tool name |
| `match.method` | string | Exact or `/regex/` match on method name |
| `match.agentId` | string | Exact or `/regex/` match on agent ID |
| `match.pathPattern` | string | Regex matched against params.path / params.filePath |
| `match.tags` | string[] | Operation must have ALL of these tags |
| `score` | number | Override L1 risk score (0–1) |
| `action` | string | Force `allow`, `block`, or `require_approval` |
| `priority` | number | Evaluation order — lower wins (default: 100) |
| `max` | number | Maximum score this rule can produce |
| `redact` | string[] | Parameter keys to redact in the audit log |

---

## Plugin Adapters

Extend rollback to external services by implementing `RollbackAdapter`. See **docs/plugin-authoring.md** for the full authoring guide.

Quick example:

```typescript
import { BaseRollbackAdapter } from 'agentsgate';
import type { MCPOperation, RollbackCapability, StateSnapshot, RollbackResult, RollbackPreview } from 'agentsgate';

export default class GitHubIssueAdapter extends BaseRollbackAdapter {
  readonly adapterId = 'github-issues';
  readonly version = '1.0.0';
  readonly supportedTools = ['github', 'github-mcp'];

  async canRollback(operation: MCPOperation): Promise<RollbackCapability> {
    const isDestructive = ['close_issue', 'delete_comment'].includes(operation.method);
    return { canRollback: isDestructive, confidence: 0.9 };
  }

  async captureState(context: MCPOperation): Promise<StateSnapshot> {
    // Snapshot current state before the operation
    return { adapterId: this.adapterId, operationId: context.id, data: {}, capturedAt: new Date() };
  }

  async rollback(snapshot: StateSnapshot): Promise<RollbackResult> {
    // Restore via external API
    return { success: true, restoredFiles: ['github:issue'], failedFiles: [] };
  }

  async previewRollback(snapshot: StateSnapshot): Promise<RollbackPreview> {
    return { willRestore: ['github:issue#1'], cannotRestore: [], warnings: [] };
  }
}
```

Load adapters at startup:

```typescript
import { CommunityAdapterRegistry } from 'agentsgate';

const registry = new CommunityAdapterRegistry();
await registry.load('./plugins');   // scans ./plugins/*.js
```

---

## Configuration

Config file: `~/.agentsgate/config.json`

```json
{
  "proxy": {
    "port": 4000,
    "host": "127.0.0.1",
    "checkpointThreshold": 0.3
  },
  "intervention": {
    "allowBelow": 0.3,
    "blockAtOrAbove": 0.7
  },
  "webhook": {
    "url": "https://your-webhook-endpoint.example.com",
    "secret": "your-hmac-signing-secret",
    "slackUrl": "https://hooks.slack.com/services/..."
  },
  "approvals": {
    "maxAgeMs": 86400000
  },
  "telemetry": {
    "exportEndpoint": "https://your-telemetry-sink.example.com",
    "exportIntervalMs": 300000,
    "anomalyWebhookUrl": "https://alerts.example.com",
    "anomalyZScoreThreshold": 2.0,
    "otlpEndpoint": "http://collector:4318/v1/metrics",
    "otlpExportIntervalMs": 300000
  },
  "intelligence": {
    "communityEndpoint": "https://community-risk.example.com"
  },
  "rateLimit": {
    "enabled": false,
    "maxOpsPerMinute": 60
  },
  "logs": {
    "retentionDays": 30
  },
  "dashboard": {
    "apiKey": "your-secret-api-key"
  },
  "audit": {
    "signingSecret": "your-hmac-secret"
  }
}
```

### Configuration fields

| Field | Default | Description |
|-------|---------|-------------|
| `proxy.port` | `4000` | Proxy listen port; dashboard runs on `port+1` |
| `proxy.host` | `127.0.0.1` | Bind address for proxy, dashboard, and WS gateway. **The proxy is unauthenticated — only set a routable address behind an authenticating reverse proxy.** See [Security model](#security-model--read-this-first) |
| `proxy.checkpointThreshold` | `0.3` | Minimum risk score to trigger a pre-op checkpoint |
| `intervention.allowBelow` | `0.3` | Risk scores below this are allowed |
| `intervention.blockAtOrAbove` | `0.7` | Risk scores at or above this are blocked |
| `webhook.url` | — | POST target for approval-required notifications |
| `webhook.secret` | — | HMAC-SHA256 secret. When set, every webhook POST carries `X-AgentsGate-Signature: sha256=<hex>` over the raw body — verify it before acting |
| `webhook.slackUrl` | — | Slack Incoming Webhook for block/approval events |
| `approvals.maxAgeMs` | `86400000` | Approval TTL in ms (default: 24h) |
| `telemetry.exportEndpoint` | — | HTTP endpoint for periodic telemetry export |
| `telemetry.exportIntervalMs` | `300000` | Export interval in ms (default: 5 min) |
| `telemetry.anomalyWebhookUrl` | — | Webhook for z-score anomaly alerts |
| `telemetry.anomalyZScoreThreshold` | `2.0` | Z-score threshold for anomaly firing |
| `telemetry.otlpEndpoint` | — | OpenTelemetry OTLP/HTTP metrics endpoint |
| `telemetry.otlpExportIntervalMs` | `300000` | OTLP export interval in ms |
| `intelligence.communityEndpoint` | — | L3 community risk enrichment endpoint |
| `rateLimit.enabled` | `false` | Enable per-agent rate limiting |
| `rateLimit.maxOpsPerMinute` | `60` | Max operations per agent per minute |
| `logs.retentionDays` | — | Days to retain operation logs before auto-pruning |
| `dashboard.apiKey` | — | `X-API-Key` required on all dashboard endpoints except `GET /health`. **Unset means no authentication** — required whenever the dashboard is reachable beyond loopback |
| `dashboard.roles` | — | Per-key roles: `viewer` / `approver` / `admin`. When set, every key must appear here or the request is rejected |
| `dashboard.allowedHosts` | loopback + `proxy.host` | Hostnames accepted in the `Host` header (DNS rebinding defence). Set when reaching the dashboard through a reverse proxy or another name |
| `audit.signingSecret` | — | HMAC-SHA256 secret for operation log signing |
| `team` | — | Namespace identifier — selects the database file (`data-{team}.db`) |

---

## Architecture

| Module | Responsibility |
|--------|----------------|
| M1 MCP Proxy Core | HTTP/stdio server + pipeline orchestration |
| M2 State Store | SQLite persistence (WAL mode) |
| M3 Operation Logger | Audit trail for every intercepted event |
| M4 Checkpoint Engine | Pre-operation file state capture |
| M5 File Shadow System | Shadow git repo for file snapshots |
| M6 Risk Scoring Engine | L1 static rules |
| M7 Intervention Controller | allow / require_approval / block gate |
| M8 Rollback Engine | File restore from checkpoint |
| M9 Plugin Adapter SDK | Registry + base class for community adapters |
| M10 Dashboard API | REST API + SSE + Prometheus metrics |
| M11 Risk Intelligence | L2 Bayesian user-history + L3 community scoring |
| M12 Community Registry | Plugin discovery and validation |
| M13 Telemetry | Anonymized aggregate stats + anomaly detection |

### Project structure

```
src/
  cli.ts                  ← agentsgate CLI entry point
  index.ts                ← library exports
  config.ts               ← configuration loader
  policy.ts               ← policy engine
  types/
    interfaces.ts         ← all shared types (Architect-owned)
    errors.ts             ← typed error classes
  modules/
    m1-proxy/             ← MCP proxy + createPipeline factory
    m2-store/             ← SQLite state store
    m3-logger/            ← operation logger
    m4-checkpoint/        ← checkpoint engine
    m5-shadow/            ← file shadow system
    m6-risk/              ← risk scoring engine (L1)
    m7-intervention/      ← intervention controller
    m8-rollback/          ← rollback engine
    m9-plugin-sdk/        ← plugin adapter SDK
    m10-dashboard/        ← dashboard REST API + SSE
    m11-intelligence/     ← risk intelligence (L2/L3)
    m12-registry/         ← community adapter registry
    m13-telemetry/        ← anonymized telemetry
  utils/
    rate-limiter.ts       ← per-agent rate limiting
    circuit-breaker.ts    ← per-agent circuit breaker
    agent-quota.ts        ← per-agent daily quota
    graceful-shutdown.ts  ← signal handling + drain
    slack-notifier.ts     ← Slack webhook notifications
    claude-desktop-injector.ts ← Claude Desktop config management
    mcp-server-registry.ts ← MCP server discovery
tests/
  modules/                ← unit tests (one file per module)
  e2e/                    ← end-to-end pipeline tests
```

---

## Development

```bash
git clone https://github.com/agentsgate/agentsgate.git
cd agentsgate
npm install
npm run build      # compile TypeScript
npm test           # run full test suite
npm run typecheck  # type-check without building
```

Recommended first run:

```bash
npm run bootstrap
npm run smoke:start
node dist/cli.js start
```

---

## Contributing

Contributions are welcome. Please open an issue to discuss proposed changes before submitting a pull request.

## License

MIT — see [LICENSE](LICENSE)
