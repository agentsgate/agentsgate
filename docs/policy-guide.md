# AgentsGate Policy Guide

AgentsGate's policy system lets you customize risk scoring and intervention behavior without modifying code.
Policies are loaded from `~/.agentsgate/policy.json` (or a path specified via `--policy` / `agentsgate.config.json`).

---

## Policy File Structure

```json
{
  "rules": [ ... ],
  "thresholds": {
    "allowBelow": 0.3,
    "blockAtOrAbove": 0.75
  },
  "agents": {
    "allowlist": [],
    "denylist": [],
    "toolRules": {}
  },
  "mutedRules": [],
  "ruleOverrides": {}
}
```

All fields are optional. An empty `{}` file is valid and means "use all defaults."

---

## Rules

Rules let you override the L1 risk score or force a specific action for matched operations.

```json
{
  "rules": [
    {
      "id": "BLOCK_PROD_DB_DELETE",
      "description": "Always block deletes on the production database",
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
      "score": 0.95,
      "max": 1.0
    },
    {
      "id": "REDACT_API_KEYS",
      "description": "Mask apiKey param before logging",
      "match": { "tool": "http" },
      "redact": ["apiKey", "authorization", "password"]
    }
  ]
}
```

### Rule Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Unique identifier (required). Surfaced in ProxyDecision.reasons. |
| `description` | string | Human-readable label (optional). |
| `match` | object | All specified fields must match (AND logic). |
| `score` | number | Override L1 risk score (0–1). First matching rule wins. |
| `action` | string | Force action: `allow`, `block`, or `require_approval`. |
| `priority` | number | Evaluation order — lower = evaluated first (default: 100). |
| `max` | number | Cap on the score this rule can produce (0–1). |
| `redact` | string[] | Param keys to replace with `[REDACTED]` in the operation log. |

### Match Criteria

| Field | Matches |
|-------|---------|
| `tool` | MCP tool name — exact string or `/regex/flags` |
| `method` | Tool method name — exact or `/regex/flags` |
| `agentId` | Agent identifier — exact or `/regex/flags` |
| `pathPattern` | Regex matched against `params.path`, `params.filePath`, or `params.file` |
| `tags` | Operation must have ALL listed tags |

**All fields in a `match` object use AND logic** — all specified fields must match.

String values are exact matches. Wrap in `/…/` for regex: `"/delete|drop/i"`.

### Rule Priority

Rules are evaluated in ascending priority order (lower number = checked first). For equal priority, declaration order is preserved. The **first matching rule** wins for `score` and `action`.

```json
{
  "rules": [
    { "id": "EMERGENCY_BLOCK", "match": { "agentId": "compromised-agent" }, "action": "block", "priority": 1 },
    { "id": "GENERAL_HIGH_RISK", "match": { "tool": "filesystem" }, "score": 0.8, "priority": 100 }
  ]
}
```

---

## Thresholds

Override the global intervention thresholds:

```json
{
  "thresholds": {
    "allowBelow": 0.3,
    "blockAtOrAbove": 0.75
  }
}
```

- Operations with `finalScore < allowBelow` are **allowed** without intervention.
- Operations with `finalScore >= blockAtOrAbove` are **blocked**.
- Operations in between go to `require_approval`.

Default values (from `agentsgate.config.json`): `allowBelow: 0.3`, `blockAtOrAbove: 0.8`.

---

## Agent Access Control

```json
{
  "agents": {
    "denylist": ["malicious-agent", "/^test-/"],
    "allowlist": [],
    "toolRules": {
      "data-analyst": {
        "allowlist": ["database", "filesystem"],
        "denylist": ["shell"]
      },
      "/^prod-.*/": {
        "denylist": ["shell", "http"]
      }
    }
  }
}
```

- **`denylist`**: Agent IDs matching any pattern are always blocked (takes priority over allowlist).
- **`allowlist`**: When non-empty, only matching agent IDs are allowed; all others are blocked.
- **`toolRules`**: Per-agent tool restrictions. Key is an agentId pattern. Within each entry:
  - `denylist` takes priority over `allowlist`.
  - `allowlist` restricts to only those tools when non-empty.

---

## Muted Rules

Silence specific L1 built-in rule IDs to suppress false positives:

```json
{
  "mutedRules": ["L1_SENSITIVE_FILE_TYPE", "L1_LARGE_WRITE"]
}
```

Muted rules still evaluate but their score contribution is discarded. To see available L1 rule IDs, run:

```bash
agentsgate policy list
```

---

## Rule Score Overrides

Change the score of specific built-in L1 rules without muting them:

```json
{
  "ruleOverrides": {
    "L1_DELETE_FILE": 0.5,
    "L1_EXEC_COMMAND": 0.9
  }
}
```

The rule still fires and contributes — it just uses your score instead of the built-in value.

---

## CLI: Policy Management

```bash
# List all policy rules (custom + built-in L1)
agentsgate policy list

# Add a custom rule
agentsgate policy add --id=MY_RULE --match-tool=filesystem --match-method=write_file --score=0.7

# Remove a rule
agentsgate policy remove MY_RULE

# Set intervention thresholds
agentsgate policy set-threshold --allow-below=0.3 --block-at=0.75

# Export current policy
agentsgate policy export policy-backup.json

# Import a policy file
agentsgate policy import policy-backup.json

# Test a simulated operation against the current policy
agentsgate policy test --tool=filesystem --method=delete_file --agentId=my-agent

# Evaluate a synthetic operation (dry run, no proxy needed)
agentsgate policy evaluate --tool=filesystem --method=delete_file --agentId=my-agent
```

---

## Built-in Presets

Apply a named preset as a starting point:

```bash
agentsgate policy preset strict     # Block everything above 0.5
agentsgate policy preset permissive # Only block above 0.95
agentsgate policy preset readonly   # Block all write/delete/execute operations
```

---

## Hot Reload

The policy file is watched for changes. Edit `~/.agentsgate/policy.json` and save — changes take effect within 1 second without restarting the proxy.

---

## Multi-Policy Files

Load and merge multiple policy files by placing them in a directory, ordered alphabetically:

```bash
agentsgate start --policy-dir=./policies/
# Loads: 00-base.json, 10-team.json, 20-project.json (merged in order)
```

Later files override earlier ones for conflicting rule IDs and threshold settings.
