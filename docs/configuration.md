# Configuration

Every field AgentsGate reads from `~/.agentsgate/config.json`, with its
default and what it does. Pass `--config=path` to any command to use a
different file, and run `agentsgate config` to print what is actually in
effect.

Anything security-relevant is called out in the table. Read the
[Security model](../README.md#security-model--read-this-first) before changing
`proxy.host` or exposing the dashboard. For the commands themselves, see
[cli.md](cli.md).

---

## Every field, filled in

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

## Field reference

| Field | Default | Description |
|-------|---------|-------------|
| `proxy.port` | `4000` | Proxy listen port; dashboard runs on `port+1` |
| `proxy.host` | `127.0.0.1` | Bind address for proxy, dashboard, and WS gateway. **The proxy is unauthenticated — only set a routable address behind an authenticating reverse proxy.** See [Security model](../README.md#security-model--read-this-first) |
| `proxy.checkpointThreshold` | `0.3` | Minimum risk score to trigger a pre-op checkpoint |
| `intervention.allowBelow` | `0.3` | Risk scores below this are allowed |
| `intervention.blockAtOrAbove` | `0.7` | Risk scores at or above this are blocked |
| `webhook.url` | — | POST target for approval-required notifications |
| `webhook.secret` | — | HMAC-SHA256 secret. When set, every webhook POST carries `X-AgentsGate-Signature: sha256=<hex>` over the raw body — verify it before acting |
| `webhook.slackUrl` | — | Slack Incoming Webhook for block/approval events |
| `approvals.maxAgeMs` | `86400000` | Approval TTL in ms (default: 24h) |
| `approvals.waitTimeoutMs` | `60000` | How long `agentsgate proxy` holds a `require_approval` call waiting for an answer before denying it. The MCP client is blocked for this whole time and has a timeout of its own — waiting longer than the client does means it gives up, and a later approval would run the tool with nobody left to receive the result |
| `telemetry.exportEndpoint` | — | HTTP endpoint for periodic telemetry export |
| `telemetry.exportIntervalMs` | `300000` | Export interval in ms (default: 5 min) |
| `telemetry.anomalyWebhookUrl` | — | Webhook for z-score anomaly alerts |
| `telemetry.anomalyZScoreThreshold` | `2.0` | Z-score threshold for anomaly firing |
| `telemetry.otlpEndpoint` | — | OpenTelemetry OTLP/HTTP metrics endpoint |
| `telemetry.otlpExportIntervalMs` | `300000` | OTLP export interval in ms |
| `intelligence.communityEndpoint` | — | L3 community risk enrichment endpoint |
| `rateLimit.enabled` | `false` | Enable per-agent rate limiting |
| `rateLimit.maxOpsPerMinute` | `60` | Max operations per agent per minute |
| `logs.retentionDays` | — | Days to retain operation logs. Unset means startup does no auto-pruning at all; `agentsgate prune` still defaults to 30 days |
| `dashboard.apiKey` | — | `X-API-Key` required on all dashboard endpoints except `GET /health`. **Unset means no authentication** — required whenever the dashboard is reachable beyond loopback |
| `dashboard.roles` | — | Per-key roles: `viewer` / `approver` / `admin`. When set, every key must appear here or the request is rejected |
| `dashboard.allowedHosts` | loopback + `proxy.host` | Hostnames accepted in the `Host` header (DNS rebinding defence). Set when reaching the dashboard through a reverse proxy or another name |
| `audit.signingSecret` | — | HMAC-SHA256 secret for operation log signing |
| `team` | — | Namespace identifier — selects the database file (`data-{team}.db`) |
