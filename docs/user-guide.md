# AgentsGate — User Guide
# AgentsGate — ユーザーガイド

---

## Table of Contents / 目次

- [English User Guide](#english-user-guide)
- [日本語ユーザーガイド](#日本語ユーザーガイド)

---

# English User Guide

## Overview

AgentsGate acts as a transparent security proxy between your AI agent and the MCP tools it uses. Every tool call is intercepted, risk-scored, checkpointed, and—if dangerous—paused for your approval or blocked outright. If something goes wrong, you can roll back to any checkpoint in seconds.

This guide covers how to use AgentsGate after installation. If you haven't installed it yet, see [docs/installation-guide.md](installation-guide.md).

---

## 1. Core Concepts

### How AgentsGate intercepts tool calls

```
AI Agent (Claude, GPT, etc.)
        ↓  MCP Protocol
  ┌──────────────────────┐
  │  AgentsGate Proxy   │  ← Every tool call passes through here
  └──────┬───────────────┘
         │
    ┌────▼──────────┐   ┌────────────────────┐   ┌─────────────────┐
    │  Risk Scoring │   │  Policy Engine     │   │  Logger         │
    └────┬──────────┘   └────────┬───────────┘   └─────────────────┘
         │                       │
         └──────────┬────────────┘
                    ↓
              ┌─────▼──────┐
              │  Decision  │  allow / require_approval / block
              └─────┬──────┘
                    │
      ┌─────────────┼─────────────┐
      ↓             ↓             ↓
   allowed    needs approval   blocked
   (proceeds)  (waits for      (rejected,
                your OK)        reason logged)
```

### Risk score

Every operation receives a **risk score** from 0.0 (completely safe) to 1.0 (extremely dangerous). The score comes from three layers:

| Layer | What it is | When it activates |
|-------|-----------|-------------------|
| **L1** | Built-in static rules (e.g. "deleting files = 0.90") | Always |
| **L2** | Your personal agent history (Bayesian model) | After ≥ 10 outcomes per agent |
| **L3** | Community risk database | Opt-in only |

### Protection level

A score is not enough on its own to say what should happen. `DROP TABLE` scores
1.00 and `SELECT * FROM users` scores 0.60 — they differ in *kind*, not degree,
so moving the bar until the SELECT passes also clears `DELETE FROM orders`
(0.90). So every built-in rule carries a **category**, and the protection level
says what to do with each.

```bash
agentsgate level              # what is stopped right now, and why
agentsgate level strict       # change it
```

The dashboard has the same switch in its header; changing it there applies to
the running proxy immediately.

| | `minimal` | **`balanced`** (default) | `strict` |
|---|---|---|---|
| Wipe a table, delete every row | block | block | block |
| Multi-statement SQL | block | block | block |
| Keys and secrets (`.env`, `.pem`) | allow | **block** | block |
| Read personal data | allow | allow | **approval** |
| Send mail / messages | allow | allow | **approval** |
| Delete mail / messages | allow | **approval** | block |
| Delete a file or record | allow | allow | **approval** |
| Add or change a file or record | allow | allow | allow |
| Run a shell command | allow | allow | **approval** |
| Read anything | allow | allow | allow |

`balanced` is the default because the common case is one person keeping an agent
from wrecking their own project: stop what cannot be undone, stay out of the way
otherwise. Move to `strict` when the data is not only yours — that is the level
that treats reading personal data as something a human should see first.

**`balanced` is a convenience posture, not a data-protection one.** Shell
commands run and tables named `users` can be read.

### Default intervention thresholds

Where no built-in rule fires, the score falls through to these thresholds.

| Score | What happens |
|-------|-------------|
| `< 0.30` | **Allowed** — operation proceeds immediately |
| `0.30 – 0.69` | **Requires approval** — operation pauses, checkpoint saved, you are notified |
| `≥ 0.70` | **Blocked** — operation rejected, reason logged |

You can change these thresholds in your [policy file](#3-policy-system). A
policy rule is applied after the level and overrides it.

### Checkpoint

Before any operation that scores ≥ 0.30, AgentsGate automatically saves a **checkpoint** — a snapshot of the relevant files using a shadow git repository. If something goes wrong, you can restore to any checkpoint instantly.

---

## 2. Dashboard

Open the dashboard at `http://localhost:4001` (or your configured dashboard port).

### Operations tab

The **Operations** tab shows every tool call your AI agent has made, in real time.

| Column | Description |
|--------|-------------|
| Time | When the operation occurred |
| Agent | Which AI agent made the call |
| Tool | Which MCP tool was called |
| Method | The specific method/action |
| Risk | Risk score (0.0 – 1.0) |
| Decision | `allow`, `require_approval`, or `block` |

Click any row to see full details: parameters, risk reasons, and the complete audit trail.

#### Filtering operations

Use the filter bar to narrow results:
- **Agent** — filter by agent ID
- **Tool** — filter by tool name
- **Action** — show only `allow`, `block`, or `require_approval`
- **Date range** — limit to a time window

#### Exporting operations

Click **Export CSV** or use the CLI:

```bash
agentsgate ops export --format=csv --out=operations.csv
agentsgate ops export --format=json --out=operations.json
```

### Approvals tab

When an operation requires approval (risk score 0.30–0.69), it appears in the **Approvals** tab. The AI agent is paused until you act.

#### Approving an operation

1. Click the operation in the Approvals tab
2. Review the details: what tool, what method, what parameters
3. Click **Approve** to let it proceed, or **Deny** to reject it

#### Approval via CLI

```bash
# List pending approvals
agentsgate approvals list

# Approve by ID
agentsgate approvals approve <id>

# Deny by ID
agentsgate approvals deny <id>
```

#### Approval expiry

Approvals expire automatically after 24 hours by default (configurable with `approvals.maxAgeMs`). Expired operations are rejected.

### Agents tab

Shows per-agent statistics: total operations, block rate, average risk score, last seen time. Use this to identify which agents are most active or risky.

### Tools tab

Shows per-tool statistics across all agents.

### Rules tab

The **Rules** tab is your policy control centre. It has three sections:

#### Policy Rules

Shows all active custom rules with a **Hits** column — how many times each rule has matched a real operation. Rows with 0 hits (shown faded) may be candidates for review or removal.

| Column | Description |
|--------|-------------|
| Priority | Evaluation order (lower = checked first) |
| ID | Unique rule identifier |
| Description | Human-readable label |
| Tool | Tool pattern the rule targets |
| Method | Method pattern the rule targets |
| Action | `allow`, `block`, or `require_approval` |
| Score | Custom risk score override |
| **Hits** | Number of times this rule has fired |
| Actions | Edit / Delete |

Click **New Rule** to open the rule editor, or **Edit** on any row to modify an existing rule. Rules are saved immediately to `policy.json`.

#### Built-in L1 Rules

Displays all hardcoded L1 static rules — their IDs, default scores, and descriptions. These run automatically on every operation and cannot be deleted, but can be muted or overridden via `mutedRules` / `ruleOverrides` in your policy file.

#### Preset Templates

One-click buttons to create common protection rules without writing JSON:

| Preset | What it creates |
|--------|----------------|
| Block Filesystem Writes | Blocks all write/overwrite/create ops on the filesystem tool |
| Require Approval: Email | Requires approval for send/reply/forward on email/Gmail tools |
| Require Approval: Slack | Requires approval for Slack messages to public channels |
| Read-Only Agent | Allows all ops from a specified agent ID, scores them at 0.05 |
| Trust Internal Email | Auto-allows email ops to your internal domain |
| Block Calendar Changes | Blocks create/update/delete on Google Calendar |

Clicking a preset opens the rule editor pre-filled — review and click **Save**.

#### Quick-create rules from operation rows

In the **Operations** tab, click any row to expand its detail panel. At the bottom you will see a **Quick rule:** bar with three buttons:

- **Block _tool/method_** — creates a rule that blocks this exact tool+method combination
- **Require approval** — creates a rule that pauses this operation for your review
- **Trust agent _agentId_** — creates an allow rule that always trusts this specific agent

Each button opens the rule editor pre-filled with the operation's tool, method, and agent ID so you can adjust the rule before saving. This is the fastest path from "I saw something suspicious" to "I have a rule protecting against it."

**Example flow:**

1. You see an operation: `slack` → `send_message` — you didn't expect your agent to send Slack messages
2. Click the operation row to expand it
3. Click **Block slack/send_message**
4. The rule editor opens with ID `BLOCK_SLACK_SEND_MESSAGE`, action `block`, tool `slack`, method `send_message`
5. Adjust description if needed, click **Save**
6. The rule is immediately active — future `slack/send_message` calls are blocked

### Checkpoints tab

Lists all saved checkpoints. Each checkpoint shows:
- Which operation triggered it
- Which files were snapshotted
- The timestamp

Click **Preview** to see what would be restored. Click **Rollback** to restore files to that point.

---

## 3. Policy System

Policies let you customize risk scoring and intervention behaviour without touching code. The policy file lives at:

```
~/.agentsgate/policy.json     (macOS / Linux)
C:\Users\<name>\.agentsgate\policy.json   (Windows)
```

### Basic policy file

```json
{
  "rules": [],
  "thresholds": {
    "allowBelow": 0.30,
    "blockAtOrAbove": 0.70
  }
}
```

An empty `{}` file is valid — it means "use all defaults."

### Custom rules

Rules let you override risk scores or force a specific action for matched operations:

```json
{
  "rules": [
    {
      "id": "BLOCK_PROD_DB_DELETE",
      "description": "Always block deletes on production database",
      "match": { "tool": "database", "method": "/delete|drop/i" },
      "action": "block",
      "priority": 10
    },
    {
      "id": "TRUST_READONLY_AGENT",
      "description": "Treat all ops from readonly-agent as low risk",
      "match": { "agentId": "readonly-agent" },
      "score": 0.05
    },
    {
      "id": "ELEVATE_SECRET_WRITES",
      "description": "High risk for writes to /secrets/",
      "match": { "tool": "filesystem", "pathPattern": "/secrets/" },
      "score": 0.95
    },
    {
      "id": "REDACT_API_KEYS",
      "description": "Mask sensitive parameters in logs",
      "match": { "tool": "http" },
      "redact": ["apiKey", "authorization", "password"]
    }
  ]
}
```

### Rule match fields

| Field | What it matches |
|-------|----------------|
| `tool` | MCP tool name — exact or `/regex/flags` |
| `method` | Tool method — exact or `/regex/flags` |
| `agentId` | Agent identifier — exact or `/regex/flags` |
| `pathPattern` | Regex matched against `params.path` / `params.filePath` |
| `tags` | Operation must have ALL listed tags |
| `paramsMatch` | Map of param field → exact value or `/regex/` to match against operation parameters |

All fields in a `match` block use **AND** logic — every specified field must match. Within `paramsMatch`, all key/value pairs must also match (AND).

#### Filtering by operation parameters (`paramsMatch`)

Use `paramsMatch` to match on specific values inside an operation's parameters — for example, the Slack channel, email recipient, or file path:

```json
{
  "rules": [
    {
      "id": "APPROVE_SLACK_DM",
      "description": "Require approval for Slack direct messages",
      "match": {
        "tool": "slack",
        "method": "send_message",
        "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }
      },
      "action": "require_approval",
      "priority": 5
    },
    {
      "id": "BLOCK_EXTERNAL_EMAIL",
      "description": "Block emails to non-company recipients",
      "match": {
        "tool": "gmail",
        "method": "/send|reply/",
        "paramsMatch": { "to": "/^(?!.*@mycompany\\.com).*$/" }
      },
      "action": "block",
      "priority": 5
    },
    {
      "id": "BLOCK_PROD_CALENDAR_DELETE",
      "description": "Block calendar deletions on the production calendar",
      "match": {
        "tool": "google-calendar",
        "method": "delete_event",
        "paramsMatch": { "calendarId": "production@mycompany.com" }
      },
      "action": "block",
      "priority": 5
    }
  ]
}
```

The value in `paramsMatch` is an **exact string** or a **`/regex/flags`** pattern (same syntax as `tool`, `method`, `agentId`).

### Changing risk thresholds

```json
{
  "thresholds": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.80
  }
}
```

This makes AgentsGate more permissive (allows up to 0.20 without prompting, only blocks at 0.80+).

### Agent allowlist and denylist

```json
{
  "agents": {
    "allowlist": ["trusted-agent"],
    "denylist": ["untrusted-agent-*"],
    "toolRules": {
      "limited-agent": {
        "allowlist": ["filesystem", "search"]
      }
    }
  }
}
```

- **allowlist** — only agents in this list are allowed to use AgentsGate
- **denylist** — agents matching these patterns are rejected outright (supports `*` wildcards)
- **toolRules** — per-agent tool allowlists or denylists

### Muting built-in L1 rules

To disable a specific built-in rule:

```json
{
  "mutedRules": ["L1_OVERWRITE_FILE"]
}
```

### Overriding built-in rule scores

To change the default score for a built-in rule:

```json
{
  "ruleOverrides": {
    "L1_OVERWRITE_FILE": 0.40,
    "L1_DELETE_FILE": 0.95
  }
}
```

### Built-in L1 rules reference

#### Filesystem & System

| Rule ID | Triggered by | Default score |
|---------|-------------|---------------|
| `L1_DELETE_FILE` | `delete_file`, `unlink`, `rm` | 0.90 |
| `L1_SENSITIVE_PATH_WRITE` | Writes to `.env`, `.ssh/`, `.aws/`, `credentials` | 0.90 |
| `L1_DROP_TABLE` | `drop`, `truncate` on database tools | 0.95 |
| `L1_DELETE_RECORD` | `delete`, `remove` on non-filesystem tools | 0.75 |
| `L1_EXECUTE_COMMAND` | `execute`, `exec`, `shell`, `spawn` | 0.80 |
| `L1_GIT_FORCE_PUSH` | `force`, `reset`, `rebase` on git tools | 0.85 |
| `L1_OVERWRITE_FILE` | `write_file`, `overwrite`, `create` on filesystem | 0.65 |
| `L1_READ_ONLY` | `read_*`, `list_*`, `get_*`, `describe_*` | 0.05 |

#### Slack

| Rule ID | Triggered by | Default score |
|---------|-------------|---------------|
| `L1_SLACK_SEND` | `send_message`, `post_message`, `reply` on `slack` tool | 0.70 |
| `L1_SLACK_DELETE` | `delete_message`, `delete`, `remove` on `slack` tool | 0.80 |
| `L1_SLACK_READ` | `list_*`, `get_*`, `read_*`, `search_*`, `history` on `slack` tool | 0.05 |

#### Gmail

| Rule ID | Triggered by | Default score |
|---------|-------------|---------------|
| `L1_GMAIL_SEND` | `send`, `reply`, `forward` on `gmail` tool | 0.90 |
| `L1_GMAIL_DRAFT` | `draft`, `create`, `compose` (non-send) on `gmail` tool | 0.30 |
| `L1_GMAIL_DELETE` | `delete`, `trash`, `remove` on `gmail` tool | 0.85 |
| `L1_GMAIL_READ` | `list_*`, `get_*`, `read_*`, `search_*` on `gmail` tool | 0.05 |

#### Google Calendar

| Rule ID | Triggered by | Default score |
|---------|-------------|---------------|
| `L1_GCAL_CREATE` | `create_event`, `insert`, `add` on `google-calendar` tool | 0.40 |
| `L1_GCAL_UPDATE` | `update_event`, `patch`, `modify` on `google-calendar` tool | 0.50 |
| `L1_GCAL_DELETE` | `delete_event`, `remove` on `google-calendar` tool | 0.70 |
| `L1_GCAL_READ` | `list_*`, `get_*`, `read_*`, `search_*` on `google-calendar` tool | 0.05 |

> **Tip:** View all active L1 rule IDs and their current scores in the dashboard **Rules** tab → Built-in L1 Rules section, or via `agentsgate policy list`.

---

## 4. Rollback

AgentsGate automatically snapshots files before any risky operation. If something goes wrong, roll back instantly.

### View available checkpoints

```bash
agentsgate checkpoints
```

Or use the Checkpoints tab in the dashboard.

### Preview a rollback (safe — does not restore yet)

```bash
agentsgate rollback <checkpoint-id> --preview
```

This shows which files would be restored and from which state, without actually changing anything.

### Perform a rollback

```bash
agentsgate rollback <checkpoint-id>
```

This restores all snapshotted files to their state at the time of the checkpoint.

### Rollback via dashboard

1. Open the **Checkpoints** tab
2. Find the checkpoint you want
3. Click **Preview** to see what will be restored
4. Click **Rollback** to confirm

---

## 5. Audit Log

AgentsGate keeps a tamper-evident audit log of every operation.

### View the audit log

```bash
agentsgate audit
```

### Filter the audit log

```bash
agentsgate audit --action=block        # Only blocked operations
agentsgate audit --agentId=my-agent   # One agent's history
agentsgate audit --tool=filesystem    # One tool's history
```

### Export for compliance

```bash
# Structured JSON with HMAC verification field
agentsgate report --format=json --out=audit-report.json
```

The JSON report includes an HMAC-SHA256 signature over the operation count. If you set `audit.signingSecret` in your config, you can verify the log has not been tampered with:

```bash
agentsgate audit verify
```

---

## 6. Notifications

### Slack notifications

Add your Slack Incoming Webhook URL to get notified when operations are blocked or require approval:

```json
{
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/T.../B.../..."
  }
}
```

Every `block` or `require_approval` event will send a Slack message with the agent ID, tool, method, and risk score.

### Webhook notifications (generic HTTP)

```json
{
  "webhook": {
    "url": "https://your-endpoint.example.com/agentsgate"
  }
}
```

AgentsGate will POST a JSON payload to this URL for each approval-required event. Retries up to 3 times on failure.

### Escalation webhooks

If an approval sits pending for too long, AgentsGate can fire an escalation webhook:

```json
{
  "approvals": {
    "maxAgeMs": 86400000,
    "escalateAfterMs": 3600000
  },
  "webhook": {
    "escalationUrl": "https://your-endpoint.example.com/escalation"
  }
}
```

---

## 7. Multi-Tenant (Teams)

Run separate AgentsGate instances with isolated databases using the `--team` flag:

```bash
# Start a proxy for the "engineering" team
agentsgate start --team=engineering

# Start a proxy for the "research" team (different port)
agentsgate start --team=research --port=3200

# View engineering team's audit log
agentsgate audit --team=engineering
```

Each team gets its own database file: `~/.agentsgate/data-<team>.db`.

---

## 8. RBAC (Role-Based Access Control)

Restrict dashboard access with API keys mapped to roles.

### Roles

| Role | Permissions |
|------|------------|
| `viewer` | Read-only access to all dashboard data |
| `approver` | Can approve and deny pending operations |
| `admin` | Full access including rollback and circuit-breaker control |

### Configuring roles

In `config.json`:

```json
{
  "dashboard": {
    "apiKey": "admin-secret-key",
    "roles": {
      "viewer-key-abc123": "viewer",
      "approver-key-def456": "approver",
      "admin-key-ghi789": "admin"
    }
  }
}
```

Clients send their key via the `X-API-Key` header:

```bash
curl -H "X-API-Key: viewer-key-abc123" http://localhost:4001/operations
```

---

## 9. Rate Limiting, Circuit Breaker, and Quota

### Per-agent rate limiting

Limit how many operations an agent can make per minute:

```json
{
  "rateLimit": {
    "enabled": true,
    "maxOpsPerMinute": 30
  }
}
```

When an agent exceeds the limit, subsequent operations are blocked with a `rate_limit_exceeded` reason until the next minute window.

### Circuit breaker

Automatically pause an agent after too many consecutive high-risk events:

Manage via dashboard or CLI:

```bash
agentsgate circuit-breakers list          # Show all circuit states
agentsgate circuit-breakers reset <agentId>   # Re-enable a tripped circuit
```

### Daily quota

Limit total operations per agent per day:

```bash
agentsgate quota set <agentId> 500    # 500 ops/day max
agentsgate quota show <agentId>       # Check current usage
agentsgate quota reset <agentId>      # Reset usage counter
```

---

## 10. Telemetry and Anomaly Detection

AgentsGate collects anonymized aggregate statistics for anomaly detection. No individual operation content is included.

### Enabling telemetry export

```json
{
  "telemetry": {
    "exportEndpoint": "https://your-sink.example.com/telemetry",
    "exportIntervalMs": 300000
  }
}
```

### Anomaly alerts

When an agent's operation rate deviates significantly from its normal pattern (z-score above threshold), AgentsGate fires a webhook:

```json
{
  "telemetry": {
    "anomalyWebhookUrl": "https://alerts.example.com/anomaly",
    "anomalyZScoreThreshold": 2.5
  }
}
```

---

## 11. CLI Reference (complete)

### Startup

```bash
agentsgate start [port] [options]
  --config=<path>        Config file path
  --policy=<path>        Policy file path
  --dry-run              Score and log without blocking (safe mode)
  --log-ttl=<ms>         Operation log retention in milliseconds
  --team=<name>          Namespace isolation (separate database)
  --port=<n>             Proxy port (default: 3100)

agentsgate stop           # Stop a running proxy
agentsgate status         # Show status (PID, port, uptime)
agentsgate health         # Liveness check
agentsgate doctor         # Diagnose environment
agentsgate config         # Print effective config
agentsgate inject         # Configure Claude Desktop
agentsgate eject          # Remove Claude Desktop config

agentsgate inject-pg --connection-string=<url>   # Register PostgreSQL MCP server
agentsgate inject-pg remove [--name=X]           # Remove PostgreSQL MCP server
agentsgate inject-mysql --connection-string=<url>  # Register MySQL MCP server
agentsgate inject-mysql remove [--name=X]          # Remove MySQL MCP server
```

### Operations

```bash
agentsgate logs [limit]   # Recent operation logs
  --action=<allow|block|require_approval>
  --tool=<name>
  --agentId=<id>
  --sessionId=<id>

agentsgate ops watch           # Live-tail via SSE
agentsgate ops tail            # Tail in tabular format
agentsgate ops summary         # Aggregate statistics
agentsgate ops get <id>        # Fetch one operation by ID
agentsgate ops export          # Export to CSV or JSON
  --format=<csv|json>
  --out=<file>
```

### Approvals

```bash
agentsgate approvals list               # List pending approvals
agentsgate approvals approve <id>       # Approve
agentsgate approvals deny <id>          # Deny
agentsgate approvals expire <id>        # Manually expire
```

### Checkpoints and Rollback

```bash
agentsgate checkpoints              # List checkpoints
agentsgate rollback <id>                # Restore files
agentsgate rollback <id> --preview      # Preview without restoring
```

### Audit and Reports

```bash
agentsgate audit                        # View audit log
  --action=<block|allow|require_approval>
  --agentId=<id>
  --tool=<name>

agentsgate audit verify                 # Verify HMAC integrity
agentsgate report                       # Risk summary report
  --format=<json>
  --out=<file>
```

### Agent Management

```bash
agentsgate circuit-breakers list                 # Circuit breaker states
agentsgate circuit-breakers reset <agentId>      # Reset a tripped circuit
agentsgate quota set <agentId> <n>      # Set daily quota
agentsgate quota show <agentId>         # Current usage
agentsgate quota reset <agentId>        # Reset usage
```

---

## 12. Database MCP Servers

AgentsGate ships two built-in MCP servers that give your AI agent safe, audited access to relational databases. All queries are intercepted, risk-scored, and subject to your policy thresholds — DDL and destructive DML always require approval by default.

### PostgreSQL MCP Server

Register the PostgreSQL MCP server with Claude Desktop or Claude Code:

```bash
agentsgate inject-pg --connection-string=postgresql://user:pass@host:5432/mydb

# Use a custom server name (useful for multiple databases)
agentsgate inject-pg --connection-string=postgresql://... --name=my-prod-db

# Overwrite an existing registration
agentsgate inject-pg --connection-string=postgresql://... --force

# Remove
agentsgate inject-pg remove
agentsgate inject-pg remove --name=my-prod-db
```

Restart Claude Desktop / Claude Code after registering for the change to take effect.

The server exposes these MCP tools to your AI agent:

| Tool method | Description | Default risk score |
|-------------|-------------|-------------------|
| `execute` | Run a SQL query | 0.40–0.95 (varies by SQL) |
| `execute_ddl` | Run DDL statements (`CREATE`, `ALTER`, `DROP`) | 0.95 |
| `list_tables` | List tables in the database | 0.05 |
| `describe_table` | Show table schema | 0.05 |

### MySQL MCP Server

Register the MySQL MCP server:

```bash
agentsgate inject-mysql --connection-string=mysql://user:pass@host:3306/mydb

# Use a custom server name
agentsgate inject-mysql --connection-string=mysql://... --name=my-mysql-db

# Overwrite an existing registration
agentsgate inject-mysql --connection-string=mysql://... --force

# Remove
agentsgate inject-mysql remove
agentsgate inject-mysql remove --name=my-mysql-db
```

The MySQL server exposes the same tool interface as the PostgreSQL server above.

### Database rollback

Both database servers integrate with AgentsGate's rollback system. When an AI agent calls `execute` or `execute_ddl` and passes a `snapshot_table` parameter, AgentsGate automatically snapshots the affected table rows to `~/.agentsgate-snapshots/<host>_<db>/` before executing. If something goes wrong, roll back via the standard rollback command:

```bash
agentsgate rollback <checkpoint-id>
```

> **Note:** Only operations that include `snapshot_table` in their parameters can be rolled back. DDL operations (e.g. `DROP TABLE`) cannot be automatically reversed — AgentsGate will block them by default unless you explicitly approve.

### Policy examples for databases

```json
{
  "rules": [
    {
      "description": "Block all DROP/TRUNCATE on production database",
      "match": { "tool": "agentsgate-pg-database", "method": "/drop|truncate/i" },
      "action": "block"
    },
    {
      "description": "Auto-approve read-only queries",
      "match": { "tool": "agentsgate-mysql-database", "method": "/^(list_tables|describe_table)$/" },
      "action": "allow"
    }
  ]
}
```

---

## 13. Dry-Run Mode

Test AgentsGate without actually blocking or approving anything:

```bash
agentsgate start --dry-run
```

In dry-run mode:
- Every operation is scored and logged
- No operations are blocked or paused
- Checkpoints are still created
- The dashboard shows what *would* have been blocked

This is useful when you first deploy AgentsGate — run it in dry-run mode for a few days to tune your policy thresholds before turning enforcement on.

---

## 14. Security Best Practices

1. **Set an API key** for the dashboard — without one, anyone on your network can view all operations
2. **Set an audit signing secret** to enable log integrity verification
3. **Run on localhost only** — do not expose port 3000 or 3100 to the internet
4. **Use RBAC** if multiple people access the dashboard
5. **Review the Approvals tab daily** when running automated agents overnight
6. **Use dry-run mode** when onboarding a new agent to learn its normal behaviour

See [SECURITY.md](../SECURITY.md) for the full security policy.

---
---

# 日本語ユーザーガイド

## 概要

AgentsGateは、AIエージェントとそれが使用するMCPツールの間に透過的なセキュリティプロキシとして機能します。すべてのツール呼び出しは傍受され、リスクスコアが付けられ、チェックポイントが保存されます。危険な場合は、実行前に承認を求めるか、完全にブロックします。何かまずいことが起きた場合、任意のチェックポイントに数秒で復元できます。

このガイドはインストール後のAgentsGateの使い方を説明します。まだインストールしていない場合は [docs/installation-guide.md](installation-guide.md) をご覧ください。

---

## 1. 基本概念

### AgentsGateがツール呼び出しを傍受する仕組み

```
AIエージェント（Claude、GPTなど）
        ↓  MCPプロトコル
  ┌─────────────────────────┐
  │  AgentsGateプロキシ    │  ← すべてのツール呼び出しがここを通過
  └──────┬──────────────────┘
         │
    ┌────▼──────────┐   ┌────────────────┐   ┌──────────────┐
    │ リスクスコア  │   │ポリシーエンジン│   │ ロガー       │
    └────┬──────────┘   └────────┬───────┘   └──────────────┘
         │                       │
         └──────────┬────────────┘
                    ↓
              ┌─────▼──────┐
              │  決定       │  allow / require_approval / block
              └─────┬──────┘
                    │
      ┌─────────────┼─────────────┐
      ↓             ↓             ↓
   許可済み    承認が必要      ブロック済み
  （続行）  （あなたの承認   （拒否、理由を記録）
             を待機中）
```

### リスクスコア

すべての操作は 0.0（完全に安全）から 1.0（非常に危険）の **リスクスコア** を受け取ります。スコアは3つのレイヤーから算出されます：

| レイヤー | 内容 | 有効になるとき |
|---------|------|-------------|
| **L1** | 組み込みの静的ルール（例：「ファイル削除 = 0.90」） | 常時 |
| **L2** | あなた個人のエージェント履歴（ベイズモデル） | エージェントごとに10件以上の結果が蓄積された後 |
| **L3** | コミュニティリスクデータベース | オプトインのみ |

### 保護レベル

スコアだけでは「何をすべきか」を決められません。`DROP TABLE` は 1.00、
`SELECT * FROM users` は 0.60 ですが、この 2 つは程度ではなく**種類**が違います。
SELECT を通すためにしきい値を上げると、`DELETE FROM orders`（0.90）まで通ってしまいます。
そこで組み込みルールには**カテゴリ**が付いており、保護レベルがカテゴリごとの扱いを決めます。

```bash
agentsgate level              # 現在の設定と、その理由を表示
agentsgate level strict       # 変更
```

ダッシュボードのヘッダにも同じ切り替えがあり、そちらで変更すると実行中のプロキシに即座に反映されます。

| | `minimal` | **`balanced`**（既定） | `strict` |
|---|---|---|---|
| テーブル全消し・全行削除 | block | block | block |
| 多重文 SQL | block | block | block |
| 鍵・認証情報（`.env`、`.pem`） | allow | **block** | block |
| 個人情報の読み出し | allow | allow | **承認** |
| メール・メッセージの送信 | allow | allow | **承認** |
| メール・メッセージの削除 | allow | **承認** | block |
| ファイル・レコードの削除 | allow | allow | **承認** |
| ファイル・レコードの追加と更新 | allow | allow | allow |
| シェルコマンドの実行 | allow | allow | **承認** |
| 読み取り全般 | allow | allow | allow |

既定が `balanced` なのは、最も多い使い方が「個人が自分のプロジェクトをエージェントの
暴走から守る」ことだからです。取り返しがつかないものだけを止め、それ以外は邪魔をしません。
扱うデータが自分だけのものでないなら `strict` にしてください。個人情報の読み出しを
人間の確認対象にするのはこのレベルです。

**`balanced` は利便性のための設定であり、データ保護の姿勢ではありません。**
シェルコマンドは実行され、`users` という名前のテーブルも読み取れます。

### デフォルトの介入しきい値

組み込みルールが 1 つも発火しなかった操作は、スコアが以下のしきい値で判定されます。

| スコア | 動作 |
|-------|------|
| `< 0.30` | **許可** — 操作は即座に続行 |
| `0.30 – 0.69` | **承認が必要** — 操作を一時停止、チェックポイントを保存、あなたに通知 |
| `≥ 0.70` | **ブロック** — 操作を拒否、理由を記録 |

これらのしきい値は[ポリシーファイル](#3-ポリシーシステム)で変更できます。
ポリシールールはレベルの後に適用され、レベルより優先されます。

### チェックポイント

スコアが 0.30 以上の操作の前に、AgentsGateは自動的に **チェックポイント** を保存します。シャドウgitリポジトリを使用して、関連ファイルのスナップショットを取ります。何かまずいことが起きたら、任意のチェックポイントに即座に復元できます。

---

## 2. ダッシュボード

`http://localhost:4001`（または設定したダッシュボードポート）でダッシュボードを開きます。

### Operationsタブ（操作）

**Operations**タブは、AIエージェントが行ったすべてのツール呼び出しをリアルタイムで表示します。

| 列 | 説明 |
|----|------|
| Time | 操作が発生した時刻 |
| Agent | どのAIエージェントが呼び出しを行ったか |
| Tool | どのMCPツールが呼び出されたか |
| Method | 具体的なメソッド/アクション |
| Risk | リスクスコア（0.0 〜 1.0） |
| Decision | `allow`、`require_approval`、または `block` |

任意の行をクリックすると詳細が表示されます：パラメータ、リスクの理由、完全な監査証跡。

#### 操作のフィルタリング

フィルターバーを使用して結果を絞り込みます：
- **Agent** — エージェントIDでフィルタリング
- **Tool** — ツール名でフィルタリング
- **Action** — `allow`、`block`、または `require_approval` のみ表示
- **Date range** — 時間帯を限定

#### 操作のエクスポート

**Export CSV**をクリックするか、CLIを使用します：

```bash
agentsgate ops export --format=csv --out=operations.csv
agentsgate ops export --format=json --out=operations.json
```

### Approvalsタブ（承認）

操作が承認を必要とする場合（リスクスコア 0.30〜0.69）、**Approvals**タブに表示されます。AIエージェントはあなたが行動するまで一時停止します。

#### 操作の承認

1. Approvalsタブで操作をクリック
2. 詳細を確認：どのツール、どのメソッド、どのパラメータか
3. **Approve**をクリックして続行を許可、または**Deny**をクリックして拒否

#### CLIによる承認

```bash
# 承認待ちの操作を一覧表示
agentsgate approvals list

# IDで承認
agentsgate approvals approve <id>

# IDで拒否
agentsgate approvals deny <id>
```

#### 承認の有効期限

承認はデフォルトで24時間後に自動的に期限切れになります（`approvals.maxAgeMs`で設定可能）。期限切れの操作は拒否されます。

### Agentsタブ（エージェント）

エージェントごとの統計を表示します：総操作数、ブロック率、平均リスクスコア、最終確認時刻。最もアクティブまたはリスクの高いエージェントを特定するために使用します。

### Toolsタブ（ツール）

すべてのエージェントにわたるツールごとの統計を表示します。

### Rulesタブ（ルール）

**Rules**タブはポリシー管理の中心です。3つのセクションがあります：

#### ポリシールール

すべてのカスタムルールを**Hits（ヒット数）**列付きで表示します — 各ルールが実際の操作に一致した回数です。ヒット数が0（薄く表示）のルールは、見直しや削除の候補かもしれません。

| 列 | 説明 |
|----|------|
| Priority | 評価順序（低い数値ほど先に評価） |
| ID | 一意のルール識別子 |
| Description | 人間が読めるラベル |
| Tool | ルールが対象とするツールパターン |
| Method | ルールが対象とするメソッドパターン |
| Action | `allow`、`block`、または `require_approval` |
| Score | カスタムリスクスコアの上書き |
| **Hits** | このルールが発火した回数 |
| Actions | 編集 / 削除 |

**New Rule**をクリックしてルールエディタを開くか、任意の行の**Edit**をクリックして既存のルールを修正します。ルールはすぐに`policy.json`に保存されます。

#### 組み込みL1ルール

すべてのハードコードされたL1静的ルールを表示します — そのID、デフォルトスコア、説明。これらはすべての操作で自動的に実行され、削除はできませんが、ポリシーファイルの`mutedRules`/`ruleOverrides`でミュートまたは上書きできます。

#### プリセットテンプレート

JSONを書かずに一般的な保護ルールを作成するためのワンクリックボタン：

| プリセット | 作成されるルール |
|-----------|---------------|
| ファイルシステム書き込みをブロック | filesystemツールでのwrite/overwrite/create操作をすべてブロック |
| 承認必須：メール | メール/GmailツールのSend/Reply/Forward操作に承認を要求 |
| 承認必須：Slack | Slackの公開チャンネルへのメッセージ送信に承認を要求 |
| 読み取り専用エージェント | 指定エージェントIDからのすべての操作を許可し、スコアを0.05に設定 |
| 社内メールを信頼 | 社内ドメインへのメール操作を自動許可 |
| カレンダー変更をブロック | Google Calendarでの作成/更新/削除をブロック |

プリセットをクリックするとルールエディタが事前入力された状態で開きます — 内容を確認して**Save**をクリックします。

#### 操作行からのクイックルール作成

**Operations**タブで任意の行をクリックして詳細パネルを展開します。下部に**Quick rule:**バーと3つのボタンが表示されます：

- **Block _ツール/メソッド_** — この特定のツール+メソッドの組み合わせをブロックするルールを作成
- **Require approval** — この操作を承認待ちにするルールを作成
- **Trust agent _agentId_** — この特定エージェントを常に信頼するallowルールを作成

各ボタンをクリックすると、操作のツール、メソッド、エージェントIDが事前入力されたルールエディタが開きます。保存前に内容を調整できます。これは「疑わしい操作を発見した」から「保護ルールを設定した」までの最短経路です。

**操作例：**

1. `slack` → `send_message` という操作を発見 — エージェントがSlackメッセージを送信しているとは思っていなかった
2. 操作行をクリックして詳細を展開
3. **Block slack/send_message**をクリック
4. ルールエディタがID `BLOCK_SLACK_SEND_MESSAGE`、アクション `block`、ツール `slack`、メソッド `send_message` で事前入力された状態で開く
5. 必要に応じて説明を調整し、**Save**をクリック
6. ルールは即座に有効になります — 以降の `slack/send_message` 呼び出しはブロックされます

### Checkpointsタブ（チェックポイント）

保存されたすべてのチェックポイントを一覧表示します。各チェックポイントには以下が表示されます：
- どの操作がトリガーになったか
- どのファイルがスナップショットされたか
- タイムスタンプ

**Preview**をクリックして何が復元されるかを確認します。**Rollback**をクリックしてファイルをその時点に復元します。

---

## 3. ポリシーシステム

ポリシーを使用すると、コードを変更せずにリスクスコアリングと介入動作をカスタマイズできます。ポリシーファイルの場所：

```
~/.agentsgate/policy.json     （macOS / Linux）
C:\Users\<名前>\.agentsgate\policy.json   （Windows）
```

### 基本的なポリシーファイル

```json
{
  "rules": [],
  "thresholds": {
    "allowBelow": 0.30,
    "blockAtOrAbove": 0.70
  }
}
```

空の `{}` ファイルでも有効です — 「すべてデフォルトを使用する」という意味になります。

### カスタムルール

ルールを使用すると、一致した操作のリスクスコアを上書きしたり、特定のアクションを強制したりできます：

```json
{
  "rules": [
    {
      "id": "本番DB削除をブロック",
      "description": "本番データベースのDELETEを常にブロック",
      "match": { "tool": "database", "method": "/delete|drop/i" },
      "action": "block",
      "priority": 10
    },
    {
      "id": "読み取り専用エージェントを信頼",
      "description": "readonly-agentからの操作を低リスクとして扱う",
      "match": { "agentId": "readonly-agent" },
      "score": 0.05
    },
    {
      "id": "機密パスへの書き込みを高リスク化",
      "description": "/secrets/への書き込みを高リスク",
      "match": { "tool": "filesystem", "pathPattern": "/secrets/" },
      "score": 0.95
    },
    {
      "id": "APIキーを秘匿",
      "description": "ログ内の機密パラメータをマスク",
      "match": { "tool": "http" },
      "redact": ["apiKey", "authorization", "password"]
    }
  ]
}
```

### ルールのマッチフィールド

| フィールド | 何にマッチするか |
|-----------|---------------|
| `tool` | MCPツール名 — 完全一致または `/regex/flags` |
| `method` | ツールメソッド — 完全一致または `/regex/flags` |
| `agentId` | エージェント識別子 — 完全一致または `/regex/flags` |
| `pathPattern` | `params.path` / `params.filePath` に対してマッチする正規表現 |
| `tags` | 操作がリストにあるすべてのタグを持っている必要がある |
| `paramsMatch` | 操作パラメータのフィールド名 → 完全一致値または `/regex/` のマップ |

`match`ブロック内のすべてのフィールドは **AND** ロジックを使用します — 指定したすべてのフィールドが一致する必要があります。`paramsMatch`内のキーと値のペアも同様にすべて一致する必要があります（AND）。

#### 操作パラメータによるフィルタリング（`paramsMatch`）

`paramsMatch`を使用すると、Slackのチャンネル、メールの宛先、ファイルパスなど、操作パラメータ内の特定の値にマッチできます：

```json
{
  "rules": [
    {
      "id": "APPROVE_SLACK_DM",
      "description": "SlackダイレクトメッセージへはApprovalが必要",
      "match": {
        "tool": "slack",
        "method": "send_message",
        "paramsMatch": { "channel": "/^D[A-Z0-9]+/" }
      },
      "action": "require_approval",
      "priority": 5
    },
    {
      "id": "BLOCK_EXTERNAL_EMAIL",
      "description": "社外宛のメール送信をブロック",
      "match": {
        "tool": "gmail",
        "method": "/send|reply/",
        "paramsMatch": { "to": "/^(?!.*@mycompany\\.com).*$/" }
      },
      "action": "block",
      "priority": 5
    },
    {
      "id": "BLOCK_PROD_CALENDAR_DELETE",
      "description": "本番カレンダーのイベント削除をブロック",
      "match": {
        "tool": "google-calendar",
        "method": "delete_event",
        "paramsMatch": { "calendarId": "production@mycompany.com" }
      },
      "action": "block",
      "priority": 5
    }
  ]
}
```

`paramsMatch`の値は **完全一致文字列** または **`/regex/flags`** パターンです（`tool`、`method`、`agentId`と同じ構文）。

### リスクしきい値の変更

```json
{
  "thresholds": {
    "allowBelow": 0.20,
    "blockAtOrAbove": 0.80
  }
}
```

これによりAgentsGateがより許容的になります（0.20まではプロンプトなしで許可、0.80以上のみブロック）。

### エージェントの許可リストと拒否リスト

```json
{
  "agents": {
    "allowlist": ["trusted-agent"],
    "denylist": ["untrusted-agent-*"],
    "toolRules": {
      "limited-agent": {
        "allowlist": ["filesystem", "search"]
      }
    }
  }
}
```

- **allowlist** — このリストにあるエージェントのみAgentsGateを使用できる
- **denylist** — これらのパターンに一致するエージェントは完全に拒否（`*`ワイルドカードをサポート）
- **toolRules** — エージェントごとのツール許可リスト/拒否リスト

### 組み込みL1ルールのミュート

特定の組み込みルールを無効にするには：

```json
{
  "mutedRules": ["L1_OVERWRITE_FILE"]
}
```

### 組み込みルールスコアの上書き

組み込みルールのデフォルトスコアを変更するには：

```json
{
  "ruleOverrides": {
    "L1_OVERWRITE_FILE": 0.40,
    "L1_DELETE_FILE": 0.95
  }
}
```

### 組み込みL1ルール一覧

#### ファイルシステム＆システム

| ルールID | トリガー条件 | デフォルトスコア |
|---------|-----------|--------------|
| `L1_DELETE_FILE` | `delete_file`、`unlink`、`rm` | 0.90 |
| `L1_SENSITIVE_PATH_WRITE` | `.env`、`.ssh/`、`.aws/`、`credentials`への書き込み | 0.90 |
| `L1_DROP_TABLE` | データベースツールでの`drop`、`truncate` | 0.95 |
| `L1_DELETE_RECORD` | 非ファイルシステムツールでの`delete`、`remove` | 0.75 |
| `L1_EXECUTE_COMMAND` | `execute`、`exec`、`shell`、`spawn` | 0.80 |
| `L1_GIT_FORCE_PUSH` | gitツールでの`force`、`reset`、`rebase` | 0.85 |
| `L1_OVERWRITE_FILE` | ファイルシステムでの`write_file`、`overwrite`、`create` | 0.65 |
| `L1_READ_ONLY` | `read_*`、`list_*`、`get_*`、`describe_*` | 0.05 |

#### Slack

| ルールID | トリガー条件 | デフォルトスコア |
|---------|-----------|--------------|
| `L1_SLACK_SEND` | `slack`ツールでの`send_message`、`post_message`、`reply` | 0.70 |
| `L1_SLACK_DELETE` | `slack`ツールでの`delete_message`、`delete`、`remove` | 0.80 |
| `L1_SLACK_READ` | `slack`ツールでの`list_*`、`get_*`、`read_*`、`search_*`、`history` | 0.05 |

#### Gmail

| ルールID | トリガー条件 | デフォルトスコア |
|---------|-----------|--------------|
| `L1_GMAIL_SEND` | `gmail`ツールでの`send`、`reply`、`forward` | 0.90 |
| `L1_GMAIL_DRAFT` | `gmail`ツールでの`draft`、`create`、`compose`（送信以外） | 0.30 |
| `L1_GMAIL_DELETE` | `gmail`ツールでの`delete`、`trash`、`remove` | 0.85 |
| `L1_GMAIL_READ` | `gmail`ツールでの`list_*`、`get_*`、`read_*`、`search_*` | 0.05 |

#### Google Calendar

| ルールID | トリガー条件 | デフォルトスコア |
|---------|-----------|--------------|
| `L1_GCAL_CREATE` | `google-calendar`ツールでの`create_event`、`insert`、`add` | 0.40 |
| `L1_GCAL_UPDATE` | `google-calendar`ツールでの`update_event`、`patch`、`modify` | 0.50 |
| `L1_GCAL_DELETE` | `google-calendar`ツールでの`delete_event`、`remove` | 0.70 |
| `L1_GCAL_READ` | `google-calendar`ツールでの`list_*`、`get_*`、`read_*`、`search_*` | 0.05 |

> **ヒント：** ダッシュボードの**Rules**タブ →「組み込みL1ルール」セクション、または `agentsgate policy list` でアクティブなL1ルールIDと現在のスコアをすべて確認できます。

---

## 4. ロールバック

AgentsGateはリスクの高い操作の前に自動的にファイルをスナップショットします。何かまずいことが起きたら、即座に復元できます。

### 利用可能なチェックポイントの確認

```bash
agentsgate checkpoints
```

またはダッシュボードのCheckpointsタブを使用します。

### ロールバックのプレビュー（安全 — まだ復元しない）

```bash
agentsgate rollback <checkpoint-id> --preview
```

実際に何も変更せずに、どのファイルがどの状態に復元されるかを表示します。

### ロールバックの実行

```bash
agentsgate rollback <checkpoint-id>
```

チェックポイント時点の状態にすべてのスナップショットされたファイルを復元します。

### ダッシュボードからのロールバック

1. **Checkpoints**タブを開く
2. 必要なチェックポイントを見つける
3. **Preview**をクリックして何が復元されるか確認
4. **Rollback**をクリックして確定

---

## 5. 監査ログ

AgentsGateはすべての操作の改ざん防止監査ログを保持します。

### 監査ログの表示

```bash
agentsgate audit
```

### 監査ログのフィルタリング

```bash
agentsgate audit --action=block        # ブロックされた操作のみ
agentsgate audit --agentId=my-agent   # 1つのエージェントの履歴
agentsgate audit --tool=filesystem    # 1つのツールの履歴
```

### コンプライアンス用エクスポート

```bash
# HMAC検証フィールド付きの構造化JSON
agentsgate report --format=json --out=audit-report.json
```

JSONレポートには操作数のHMAC-SHA256署名が含まれます。`audit.signingSecret`を設定すると、ログが改ざんされていないことを確認できます：

```bash
agentsgate audit verify
```

---

## 6. 通知

### Slack通知

操作がブロックされたり承認が必要なときに通知を受けるには、Slack Incoming Webhook URLを追加します：

```json
{
  "webhook": {
    "slackUrl": "https://hooks.slack.com/services/T.../B.../..."
  }
}
```

`block`または`require_approval`イベントのたびに、エージェントID、ツール、メソッド、リスクスコアを含むSlackメッセージが送信されます。

### Webhook通知（汎用HTTP）

```json
{
  "webhook": {
    "url": "https://your-endpoint.example.com/agentsgate"
  }
}
```

AgentsGateは承認が必要な各イベントに対してこのURLにJSONペイロードをPOSTします。失敗した場合は最大3回リトライします。

### エスカレーションWebhook

承認が長時間保留されたままの場合、AgentsGateはエスカレーションWebhookを発火できます：

```json
{
  "approvals": {
    "maxAgeMs": 86400000,
    "escalateAfterMs": 3600000
  },
  "webhook": {
    "escalationUrl": "https://your-endpoint.example.com/escalation"
  }
}
```

---

## 7. マルチテナント（チーム）

`--team`フラグを使用して、独立したデータベースを持つ別々のAgentsGateインスタンスを実行します：

```bash
# "engineering"チーム用のプロキシを起動
agentsgate start --team=engineering

# "research"チーム用のプロキシを起動（別のポート）
agentsgate start --team=research --port=3200

# engineeringチームの監査ログを表示
agentsgate audit --team=engineering
```

各チームは独自のデータベースファイルを取得します：`~/.agentsgate/data-<team>.db`

---

## 8. RBAC（ロールベースアクセス制御）

APIキーをロールにマッピングしてダッシュボードアクセスを制限します。

### ロール

| ロール | 権限 |
|------|------|
| `viewer` | すべてのダッシュボードデータへの読み取り専用アクセス |
| `approver` | 保留中の操作を承認・拒否できる |
| `admin` | ロールバックやサーキットブレーカー制御を含む完全アクセス |

### ロールの設定

`config.json`内：

```json
{
  "dashboard": {
    "apiKey": "admin-secret-key",
    "roles": {
      "viewer-key-abc123": "viewer",
      "approver-key-def456": "approver",
      "admin-key-ghi789": "admin"
    }
  }
}
```

クライアントは`X-API-Key`ヘッダーでキーを送信します：

```bash
curl -H "X-API-Key: viewer-key-abc123" http://localhost:4001/operations
```

---

## 9. レート制限、サーキットブレーカー、クォータ

### エージェントごとのレート制限

エージェントが1分間に実行できる操作数を制限します：

```json
{
  "rateLimit": {
    "enabled": true,
    "maxOpsPerMinute": 30
  }
}
```

エージェントが制限を超えると、次の1分間のウィンドウまで後続の操作が`rate_limit_exceeded`の理由でブロックされます。

### サーキットブレーカー

連続した高リスクイベントが多すぎる場合、エージェントを自動的に一時停止します：

ダッシュボードまたはCLIで管理します：

```bash
agentsgate circuit-breakers list              # すべてのサーキット状態を表示
agentsgate circuit-breakers reset <agentId>   # トリップしたサーキットを再有効化
```

### 1日のクォータ

エージェントごとの1日の総操作数を制限します：

```bash
agentsgate quota set <agentId> 500    # 最大500操作/日
agentsgate quota show <agentId>       # 現在の使用量を確認
agentsgate quota reset <agentId>      # 使用量カウンターをリセット
```

---

## 10. テレメトリと異常検知

AgentsGateは異常検知のための匿名化された集計統計を収集します。個々の操作内容は含まれません。

### テレメトリエクスポートの有効化

```json
{
  "telemetry": {
    "exportEndpoint": "https://your-sink.example.com/telemetry",
    "exportIntervalMs": 300000
  }
}
```

### 異常アラート

エージェントの操作レートが通常のパターンから大きく逸脱した場合（しきい値を超えるzスコア）、AgentsGateはWebhookを発火します：

```json
{
  "telemetry": {
    "anomalyWebhookUrl": "https://alerts.example.com/anomaly",
    "anomalyZScoreThreshold": 2.5
  }
}
```

---

## 11. CLIリファレンス（完全版）

### 起動

```bash
agentsgate start [port] [options]
  --config=<path>        設定ファイルのパス
  --policy=<path>        ポリシーファイルのパス
  --dry-run              ブロックなしでスコアリングとログのみ（安全モード）
  --log-ttl=<ms>         操作ログの保持期間（ミリ秒）
  --team=<name>          名前空間の分離（別データベース）
  --port=<n>             プロキシポート（デフォルト：3100）

agentsgate stop           # 実行中のプロキシを停止
agentsgate status         # ステータスを表示（PID、ポート、稼働時間）
agentsgate health         # 生存確認
agentsgate doctor         # 環境の診断
agentsgate config         # 有効な設定を出力
agentsgate inject         # Claude Desktopを設定
agentsgate eject          # Claude Desktopの設定を削除

agentsgate inject-pg --connection-string=<url>   # PostgreSQL MCPサーバーを登録
agentsgate inject-pg remove [--name=X]           # PostgreSQL MCPサーバーを削除
agentsgate inject-mysql --connection-string=<url>  # MySQL MCPサーバーを登録
agentsgate inject-mysql remove [--name=X]          # MySQL MCPサーバーを削除
```

### 操作

```bash
agentsgate logs [limit]   # 最近の操作ログ
  --action=<allow|block|require_approval>
  --tool=<name>
  --agentId=<id>
  --sessionId=<id>

agentsgate ops watch           # SSEでライブ追跡
agentsgate ops tail            # 表形式で追跡
agentsgate ops summary         # 集計統計
agentsgate ops get <id>        # IDで1件の操作を取得
agentsgate ops export          # CSVまたはJSONにエクスポート
  --format=<csv|json>
  --out=<file>
```

### 承認

```bash
agentsgate approvals list               # 承認待ちの一覧
agentsgate approvals approve <id>       # 承認
agentsgate approvals deny <id>          # 拒否
agentsgate approvals expire <id>        # 手動で期限切れに
```

### チェックポイントとロールバック

```bash
agentsgate checkpoints              # チェックポイントの一覧
agentsgate rollback <id>                # ファイルを復元
agentsgate rollback <id> --preview      # 復元せずにプレビュー
```

### 監査とレポート

```bash
agentsgate audit                        # 監査ログを表示
  --action=<block|allow|require_approval>
  --agentId=<id>
  --tool=<name>

agentsgate audit verify                 # HMAC整合性を確認
agentsgate report                       # リスクサマリーレポート
  --format=<json>
  --out=<file>
```

### エージェント管理

```bash
agentsgate circuit-breakers list                 # サーキットブレーカーの状態
agentsgate circuit-breakers reset <agentId>      # トリップしたサーキットをリセット
agentsgate quota set <agentId> <n>      # 1日のクォータを設定
agentsgate quota show <agentId>         # 現在の使用量
agentsgate quota reset <agentId>        # 使用量をリセット
```

---

## 12. データベースMCPサーバー

AgentsGateには、AIエージェントがリレーショナルデータベースに安全かつ監査付きでアクセスするための2つの組み込みMCPサーバーが含まれています。すべてのクエリはAgentsGateによって傍受され、リスクスコアが付けられ、ポリシーのしきい値に従って処理されます。DDLや破壊的なDMLはデフォルトで常に承認が必要です。

### PostgreSQL MCPサーバー

PostgreSQL MCPサーバーをClaude DesktopまたはClaude Codeに登録します：

```bash
agentsgate inject-pg --connection-string=postgresql://user:pass@host:5432/mydb

# カスタムサーバー名（複数データベースの場合に便利）
agentsgate inject-pg --connection-string=postgresql://... --name=my-prod-db

# 既存の登録を上書き
agentsgate inject-pg --connection-string=postgresql://... --force

# 削除
agentsgate inject-pg remove
agentsgate inject-pg remove --name=my-prod-db
```

登録後はClaude Desktop / Claude Codeを再起動してください。

サーバーがAIエージェントに公開するMCPツール：

| ツールメソッド | 説明 | デフォルトリスクスコア |
|-------------|------|-------------------|
| `execute` | SQLクエリを実行 | 0.40–0.95（SQLの種類による） |
| `execute_ddl` | DDL文を実行（`CREATE`、`ALTER`、`DROP`） | 0.95 |
| `list_tables` | データベースのテーブル一覧 | 0.05 |
| `describe_table` | テーブルのスキーマを表示 | 0.05 |

### MySQL MCPサーバー

MySQL MCPサーバーを登録します：

```bash
agentsgate inject-mysql --connection-string=mysql://user:pass@host:3306/mydb

# カスタムサーバー名
agentsgate inject-mysql --connection-string=mysql://... --name=my-mysql-db

# 既存の登録を上書き
agentsgate inject-mysql --connection-string=mysql://... --force

# 削除
agentsgate inject-mysql remove
agentsgate inject-mysql remove --name=my-mysql-db
```

MySQLサーバーはPostgreSQLサーバーと同じツールインターフェースを公開します。

### データベースロールバック

両方のデータベースサーバーはAgentsGateのロールバックシステムと統合されています。AIエージェントが`execute`または`execute_ddl`を呼び出す際に`snapshot_table`パラメータを渡すと、AgentsGateは実行前に対象テーブルの行を`~/.agentsgate-snapshots/<host>_<db>/`に自動的にスナップショットします。問題が発生した場合は、標準のロールバックコマンドで復元できます：

```bash
agentsgate rollback <checkpoint-id>
```

> **注意：** `snapshot_table`パラメータを含む操作のみロールバック可能です。DDL操作（例：`DROP TABLE`）は自動的に復元できません — AgentsGateはデフォルトでこれらをブロックし、明示的に承認した場合のみ実行されます。

### データベース用ポリシー例

```json
{
  "rules": [
    {
      "description": "本番データベースのDROP/TRUNCATEをすべてブロック",
      "match": { "tool": "agentsgate-pg-database", "method": "/drop|truncate/i" },
      "action": "block"
    },
    {
      "description": "読み取り専用クエリを自動承認",
      "match": { "tool": "agentsgate-mysql-database", "method": "/^(list_tables|describe_table)$/" },
      "action": "allow"
    }
  ]
}
```

---

## 13. ドライランモード

実際にブロックや承認なしにAgentsGateをテストします：

```bash
agentsgate start --dry-run
```

ドライランモードでは：
- すべての操作がスコアリングされ、ログに記録される
- 操作はブロックも一時停止もされない
- チェックポイントは引き続き作成される
- ダッシュボードには何が*ブロックされるはずだったか*が表示される

これはAgentsGateを最初に導入するときに便利です — 数日間ドライランモードで実行してポリシーのしきい値を調整してから、強制をオンにしてください。

---

## 14. セキュリティのベストプラクティス

1. **APIキーを設定する** — 設定しないと、ネットワーク上の誰でもすべての操作を閲覧できます
2. **監査署名シークレットを設定する** — ログの整合性検証を有効にします
3. **localhostのみで実行する** — ポート3000または3100をインターネットに公開しないでください
4. **複数の人がダッシュボードにアクセスする場合はRBACを使用する**
5. **夜間に自動化エージェントを実行するときは毎日Approvalsタブを確認する**
6. **新しいエージェントをオンボーディングするときはドライランモードを使用する** — 正常な動作を学習するため

詳細なセキュリティポリシーは [SECURITY.md](../SECURITY.md) をご覧ください。
