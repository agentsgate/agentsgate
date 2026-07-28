# AgentsGate Dashboard API Reference

The Dashboard REST API runs on the proxy port + 1 (default: **4001**) while AgentsGate is running.

## Authentication

When `dashboard.apiKey` is set in `config.json`, all requests except `GET /health` must include:

```
X-API-Key: <your-key>
```

Keys must be sent via header only. Query-parameter auth is not supported (keys in URLs leak into logs and browser history).

## Base URL

```
http://localhost:4001
```

---

## System

### GET /health

Liveness check. Always public (no API key required).

**Response**
```json
{
  "status": "ok",
  "uptime": 3600,
  "version": "0.1.0"
}
```

---

### GET /config

Returns the sanitized effective configuration (secrets redacted).

**Response**
```json
{
  "proxy": { "port": 4000, "checkpointThreshold": 0.3 },
  "intervention": { "allowBelow": 0.3, "blockAtOrAbove": 0.7 },
  "approvals": { "maxAgeMs": 86400000 }
}
```

Returns `503` if config was not exposed at startup.

---

### GET /metrics

Prometheus text exposition format. Returns counters for total operations, blocked operations, approvals, and checkpoints.

**Response** — `text/plain; version=0.0.4; charset=utf-8`

---

### GET /events

Server-Sent Events stream. Connect to receive real-time push notifications.

**Events**
| Event name | Payload | Description |
|------------|---------|-------------|
| `connected` | `{}` | Sent immediately on connect |
| `operation` | `{ id, agentId, tool, method, action, riskScore, sessionId, timestamp, tags }` | Fired on every intercepted operation |
| `approval_expired` | `{ id, operationId }` | Fired when a queued approval TTL expires |
| `refresh` | varies | Generic refresh hint |

Clients should handle disconnection and reconnect.

---

## Operations

### GET /operations

Paginated list of operation logs, newest first.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Page size (default: 50, max: 500) |
| `offset` | int | Pagination offset (default: 0) |
| `action` | string | Filter by decision: `allow`, `block`, `require_approval` |
| `tool` | string | Filter by tool name |
| `agentId` | string | Filter by agent ID |
| `sessionId` | string | Filter by session ID |
| `method` | string | Filter by method name (exact) |
| `parentId` | string | Filter by parent operation ID |
| `from` | ISO 8601 | Start of time range (alias: `createdFrom`) |
| `to` | ISO 8601 | End of time range (alias: `createdTo`) |
| `tags` | string | Comma-separated tags; operation must have ALL tags |
| `q` | string | Full-text search across agentId, tool, method |
| `minRisk` | float | Minimum risk score (0–1) |
| `maxRisk` | float | Maximum risk score (0–1) |
| `sort` | string | `riskScore` or `timestamp` (default: `timestamp`) |
| `order` | string | `asc` or `desc` (default: `desc`) |

**Response**
```json
{
  "data": [
    {
      "operationId": "uuid",
      "operation": {
        "id": "uuid",
        "agentId": "claude",
        "tool": "filesystem",
        "method": "write_file",
        "params": { "path": "/tmp/file.txt" },
        "timestamp": "2026-03-21T00:00:00Z",
        "sessionId": "sess-uuid",
        "tags": []
      },
      "decision": {
        "action": "allow",
        "riskScore": 0.65,
        "reasons": ["L1_OVERWRITE_FILE"],
        "firedRules": []
      }
    }
  ],
  "count": 1
}
```

---

### GET /operations/summary

Aggregate statistics across all operations in the database.

**Response** (key fields — many additional statistical fields are included)
```json
{
  "totalOps": 1234,
  "byAction": { "allow": 1000, "block": 100, "require_approval": 134 },
  "avgRiskScore": 0.42,
  "minRiskScore": 0.05,
  "maxRiskScore": 0.95,
  "blockRate": 0.081,
  "totalSessions": 12,
  "uniqueAgents": 3,
  "uniqueTools": 8,
  "topAgents": [{ "agentId": "claude", "count": 800 }],
  "topTools": [{ "tool": "filesystem", "count": 400 }]
}
```

---

### GET /operations/export

Export all operations (subject to filters) as CSV.

**Query params** — same filters as `GET /operations` (without pagination)

**Response** — `text/csv`

---

### GET /operations/count

Count operations matching filters.

**Query params** — same filters as `GET /operations`

**Response**
```json
{ "count": 42 }
```

---

### GET /operations/:id

Get a single operation log by ID.

**Response** — single operation log object (same shape as items in `GET /operations`)

Returns `404` if not found.

---

## Agents

### GET /agents

List all known agents with aggregate statistics.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max agents to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "agents": [
    {
      "agentId": "claude",
      "totalOps": 800,
      "allowCount": 650,
      "blockCount": 50,
      "requireApprovalCount": 100,
      "avgRiskScore": 0.38
    }
  ]
}
```

---

### GET /agents/:agentId

Detail view for a single agent, including per-tool breakdown.

**Response**
```json
{
  "agentId": "claude",
  "totalOps": 800,
  "allowCount": 650,
  "blockCount": 50,
  "requireApprovalCount": 100,
  "avgRiskScore": 0.38,
  "tools": [{ "tool": "filesystem", "count": 400 }]
}
```

---

### GET /agents/:agentId/tools

Tools used by a specific agent with per-tool operation counts and risk scores.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max tools to return |

**Response**
```json
{
  "agentId": "claude",
  "tools": [
    { "tool": "filesystem", "count": 400, "avgRisk": 0.45 }
  ]
}
```

---

### GET /agents/:agentId/sessions

Sessions for a specific agent. Equivalent to `GET /sessions?agentId=X`.

**Response** — same shape as `GET /sessions`

---

### GET /agents/:agentId/ops

Operations for a specific agent. Equivalent to `GET /operations?agentId=X`.

**Response** — same shape as `GET /operations`

---

### GET /agents/:agentId/risk

Risk profile for a specific agent: L2 Bayesian model state, recent scores, and top patterns.

**Response**
```json
{
  "agentId": "claude",
  "sampleCount": 45,
  "bayesianPrior": 0.38,
  "recentAvgRisk": 0.41,
  "topRiskPatterns": []
}
```

---

### GET /agents/:agentId/quota

Daily operation quota usage for a specific agent.

**Response**
```json
{
  "agentId": "claude",
  "used": 120,
  "limit": 1000,
  "remaining": 880,
  "resetsAt": "2026-03-22T00:00:00Z"
}
```

---

## Tools

### GET /tools

List all known tools with aggregate statistics.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max tools to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "tools": [
    { "tool": "filesystem", "count": 400, "avgRisk": 0.45, "blockCount": 30 }
  ]
}
```

---

### GET /tools/:toolName

Detail view for a specific tool. Tool name must be URL-encoded.

**Response**
```json
{
  "tool": "filesystem",
  "count": 400,
  "avgRisk": 0.45,
  "blockCount": 30,
  "methods": [{ "method": "write_file", "count": 200 }]
}
```

---

## Sessions

### GET /sessions

List sessions with per-session operation counts and risk statistics.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `agentId` | string | Filter sessions for a specific agent |
| `limit` | int | Max sessions to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "sessions": [
    {
      "sessionId": "sess-uuid",
      "agentId": "claude",
      "opCount": 42,
      "avgRisk": 0.35,
      "blockCount": 3,
      "firstSeen": "2026-03-21T00:00:00Z",
      "lastSeen": "2026-03-21T01:00:00Z"
    }
  ]
}
```

---

### GET /sessions/:sessionId

Detail view for a single session.

**Response** — single session object with full statistics

---

### POST /sessions/:sessionId/expire

Immediately expire (invalidate) a session. The proxy will block any subsequent operations from this session ID.

**Response**
```json
{ "ok": true, "sessionId": "sess-uuid" }
```

---

## Policy

### GET /policy/stats

Rule hit counts since the proxy started. Counts are tracked in-memory and reset on restart.

**Response**
```json
{
  "hitCounts": {
    "L1_DELETE_FILE": 12,
    "BLOCK_PROD_DB_DELETE": 3
  }
}
```

---

### GET /policy/rules

All currently loaded policy rules (custom rules from `policy.json`).

Returns `503` if no policy was loaded at startup.

**Response**
```json
{
  "rules": [
    {
      "id": "BLOCK_PROD_DB_DELETE",
      "description": "Always block deletes on the production database tool",
      "match": { "tool": "database", "method": "/delete|drop/i" },
      "action": "block",
      "priority": 100
    }
  ]
}
```

---

### GET /policy/rules/:ruleId

A single policy rule by ID.

**Response** — single rule object

Returns `404` if not found.

---

### POST /policy/evaluate

Dry-evaluate an operation payload against the loaded policy without actually executing it.

**Request body**
```json
{
  "id": "test-op",
  "agentId": "claude",
  "tool": "database",
  "method": "delete_record",
  "params": {},
  "timestamp": "2026-03-21T00:00:00Z"
}
```

**Response**
```json
{
  "action": "block",
  "riskScore": 0.95,
  "firedRules": [{ "id": "BLOCK_PROD_DB_DELETE" }],
  "reasons": ["BLOCK_PROD_DB_DELETE", "L1_DELETE_RECORD"]
}
```

---

## Approvals

### GET /approvals/pending

List all operations currently waiting for human approval.

**Response**
```json
{
  "pending": [
    {
      "id": "op-uuid",
      "operation": { "agentId": "claude", "tool": "filesystem", "method": "delete_file" },
      "riskScore": 0.90,
      "checkpointId": "cp-uuid",
      "queuedAt": "2026-03-21T00:00:00Z"
    }
  ]
}
```

---

### POST /approvals/:id/approve

Approve a pending operation. The proxy will unblock and forward the operation.

**Response**
```json
{ "ok": true, "id": "op-uuid", "action": "approved" }
```

Returns `404` if the approval is not found or already resolved.

---

### POST /approvals/:id/deny

Deny a pending operation. The proxy will reject the operation and return an error to the agent.

**Response**
```json
{ "ok": true, "id": "op-uuid", "action": "denied" }
```

Returns `404` if the approval is not found or already resolved.

---

## Checkpoints

### GET /checkpoints

List recent checkpoints.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max checkpoints to return (default: 20) |
| `operationId` | string | Filter to checkpoints for a specific operation |

**Response**
```json
{
  "checkpoints": [
    {
      "id": "cp-uuid",
      "operationId": "op-uuid",
      "createdAt": "2026-03-21T00:00:00Z",
      "files": ["/path/to/file.txt"]
    }
  ]
}
```

---

### GET /checkpoints/:id

Get a single checkpoint by ID.

**Response** — single checkpoint object with full file list

Returns `404` if not found.

---

### GET /checkpoints/:id/diff

Show the diff of files that changed at this checkpoint (before vs after).

**Response**
```json
{
  "checkpointId": "cp-uuid",
  "diffs": [
    {
      "path": "/path/to/file.txt",
      "before": "old content",
      "after": "new content"
    }
  ]
}
```

---

### POST /rollback/:checkpointId

Restore files to their state captured in the checkpoint.

**Response**
```json
{
  "success": true,
  "checkpointId": "cp-uuid",
  "restoredFiles": ["/path/to/file.txt"],
  "failedFiles": []
}
```

---

### GET /rollback/:checkpointId/preview

Preview what a rollback would restore without making any changes.

**Response**
```json
{
  "checkpointId": "cp-uuid",
  "willRestore": ["/path/to/file.txt"],
  "cannotRestore": [],
  "warnings": []
}
```

---

## Risk

### GET /risk

List risk assessments, optionally filtered.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max assessments to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "data": [
    {
      "operationId": "op-uuid",
      "score": 0.90,
      "reasons": ["L1_DELETE_FILE"],
      "l1Score": 0.90,
      "l2Score": null,
      "l3Score": null
    }
  ]
}
```

---

### GET /risk/:operationId

Risk assessment for a specific operation.

**Response** — single risk assessment object

Returns `404` if not found.

---

## Telemetry

### GET /telemetry

Current in-memory telemetry snapshot with aggregate stats.

**Response**
```json
{
  "totalOps": 1234,
  "allowCount": 1000,
  "blockCount": 100,
  "requireApprovalCount": 134,
  "avgRiskScore": 0.42,
  "anomalyScore": null,
  "sessionCount": 12
}
```

---

### GET /telemetry/sessions

Per-session telemetry breakdown.

**Response**
```json
{
  "sessions": [
    { "sessionId": "sess-uuid", "opCount": 42, "avgRisk": 0.35 }
  ]
}
```

---

### GET /telemetry/sessions/:sessionId

Telemetry for a specific session.

**Response** — single session telemetry object

---

### GET /telemetry/agents

Per-agent telemetry breakdown.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max agents to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "agents": [
    { "agentId": "claude", "opCount": 800, "avgRisk": 0.38 }
  ]
}
```

---

### GET /telemetry/agents/:agentId

Telemetry for a specific agent.

**Response** — single agent telemetry object

---

### GET /telemetry/tools

Per-tool telemetry breakdown.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Max tools to return |
| `offset` | int | Pagination offset |

**Response**
```json
{
  "tools": [
    { "tool": "filesystem", "opCount": 400, "avgRisk": 0.45 }
  ]
}
```

---

### GET /telemetry/tools/:toolName

Telemetry for a specific tool. Tool name must be URL-encoded.

**Response** — single tool telemetry object

---

## Circuit Breakers

### GET /circuit-breakers

List per-agent circuit breaker states.

Returns `503` if circuit breaker is not configured.

**Response**
```json
{
  "breakers": [
    {
      "agentId": "claude",
      "state": "closed",
      "failureCount": 0,
      "lastFailure": null
    }
  ]
}
```

Circuit states: `closed` (normal), `open` (tripped — all ops blocked), `half-open` (testing recovery).

---

### POST /circuit-breakers/:agentId/reset

Manually reset a tripped circuit breaker for an agent.

Returns `503` if circuit breaker is not configured.

**Response**
```json
{ "ok": true, "agentId": "claude", "message": "Circuit reset" }
```

---

## Rate Limits

### GET /rate-limits

Per-agent rate limiter stats (current count, limit, and window).

Returns `503` if rate limiting is not enabled.

**Response**
```json
{
  "limits": [
    {
      "agentId": "claude",
      "current": 12,
      "limit": 60,
      "windowMs": 60000,
      "resetsAt": "2026-03-21T00:01:00Z"
    }
  ]
}
```

---

## Quota

### GET /quota

Per-agent daily quota usage.

Returns `503` if quota management is not configured.

**Response**
```json
{
  "quotas": [
    {
      "agentId": "claude",
      "used": 120,
      "limit": 1000,
      "remaining": 880,
      "resetsAt": "2026-03-22T00:00:00Z"
    }
  ]
}
```

---

## Audit

### GET /audit/verify

HMAC-SHA256 verify the integrity of recent operation logs. Requires `audit.signingSecret` to be configured.

Returns `503` if signing is not configured.

**Query params**

| Param | Type | Description |
|-------|------|-------------|
| `limit` | int | Number of recent logs to verify (default: 100) |

**Response**
```json
{
  "verified": 98,
  "failed": 2,
  "total": 100,
  "failedIds": ["op-uuid-1", "op-uuid-2"]
}
```

---

## Stats (alias)

### GET /stats

Alias for `GET /operations/summary`. Returns the same aggregate statistics.

---

## Error Responses

All endpoints return JSON error objects:

```json
{ "error": "Not Found" }
{ "error": "Unauthorized" }
{ "error": "Internal server error" }
```

| Status | Meaning |
|--------|---------|
| `200` | Success |
| `401` | Missing or invalid API key |
| `404` | Resource not found |
| `503` | Feature not configured |
| `500` | Internal server error |
