# CLI Reference

Every `agentsgate` command, grouped by category. `agentsgate --help` prints
the same list from the binary itself, and `agentsgate --version` prints the
version. There is no per-command help — flags are documented here.

For the REST API the dashboard exposes, see [api-reference.md](api-reference.md).

---

## Startup

| Command | Description |
|---------|-------------|
| `agentsgate start [port] [--config=path] [--policy=path] [--dry-run] [--log-ttl=ms]` | Start the proxy and dashboard |
| `agentsgate stop` | Send stop signal to the running proxy |
| `agentsgate status` | Show proxy PID, port, dashboard URL, and start time |
| `agentsgate health` | Liveness check against the running dashboard |
| `agentsgate doctor` | Diagnose environment (Node version, build, config, DB) |
| `agentsgate inject` | Auto-configure Claude Desktop to route through AgentsGate |
| `agentsgate inject status [--config=path]` | Show current injection status |
| `agentsgate eject` | Remove AgentsGate from Claude Desktop config |
| `agentsgate proxy [subcommand]` | Stdio proxy mode |
| `agentsgate --version` (`-v`, `version`) | Print the version and exit |
| `agentsgate --help` (`-h`, `help`) | Print this command list and exit |

## Database MCP servers

Register a guarded database server in the Claude config, so the SQL an agent
issues is risk-scored and checkpointed like any other tool call. Restart Claude
Desktop / Claude Code after registering.

| Command | Description |
|---------|-------------|
| `agentsgate inject-db --db=<path> [--name=X] [--force] [--config=path]` | Register the SQLite MCP server |
| `agentsgate inject-sqlite --db=<path>` | Alias for `inject-db` |
| `agentsgate inject-pg --connection-string=<url> [--name=X] [--force]` | Register the PostgreSQL MCP server |
| `agentsgate inject-mysql --connection-string=<url> [--name=X] [--force]` | Register the MySQL MCP server |
| `agentsgate inject-db\|inject-pg\|inject-mysql remove [--name=X]` | Remove that server from the Claude config |
| `agentsgate db snapshot prune --db=<path> [--older-than=<Nd\|Nh>]` | Delete rollback snapshots older than the cutoff (default 7d) |

```bash
# PostgreSQL — the connection string is redacted in all output and logs
agentsgate inject-pg --connection-string=postgresql://user:pass@localhost:5432/mydb

# Several databases at once — distinguish them with --name
agentsgate inject-pg    --connection-string=postgresql://... --name=production-db
agentsgate inject-mysql --connection-string=mysql://...      --name=staging-db
```

## Configuration

| Command | Description |
|---------|-------------|
| `agentsgate config` | Print effective config (merged defaults + file) |
| `agentsgate config show` | Fetch live sanitized config from running dashboard |

## Operations

| Command | Description |
|---------|-------------|
| `agentsgate logs [limit] [--action=X] [--tool=X] [--agentId=X] [--sessionId=X]` | List recent operation logs |
| `agentsgate ops watch` | Live-tail operations via SSE |
| `agentsgate ops tail [--limit=N] [--action=X] [--tool=X] [--agent=X] [--tags=X]` | Tail operations in tabular format |
| `agentsgate ops summary` | Aggregate statistics (counts, risk, trends, top agents/tools) |
| `agentsgate ops stats [--agentId=X] [--tool=X] [--limit=N]` | Offline stats from local DB |
| `agentsgate ops export [--format=csv\|json] [--out=file]` | Export operations to CSV or JSON |
| `agentsgate ops get <id>` | Fetch a single operation by ID |
| `agentsgate ops count [filters]` | Count operations matching filters |
| `agentsgate ops prune [--before=date] [--dry-run]` | Prune old operation logs |
| `agentsgate risk [--operationId=X] [--agentId=X] [--limit=N]` | Show risk assessments |
| `agentsgate explain <operationId>` | Explain the risk decision for a specific operation |
| `agentsgate replay <operationId> [--dry-run]` | Re-run an operation through the pipeline |
| `agentsgate top [--by=risk\|count] [--limit=N]` | Top agents/tools by risk or count |
| `agentsgate watch [--filter=X]` | Live watch operation stream |
| `agentsgate benchmark [--ops=N]` | Throughput benchmark |
| `agentsgate export [--format=X] [--out=file]` | Export full operation history |

## Policy

| Command | Description |
|---------|-------------|
| `agentsgate policy` | Print current policy rules |
| `agentsgate policy list` | List all policy rules with details |
| `agentsgate policy add --id=X --action=X --tool=X [--method=X] [--agentId=X] [--pathPattern=X] [--score=N] [--priority=N] [--description=X]` | Add a new policy rule |
| `agentsgate policy remove --id=X` | Remove a policy rule by ID |
| `agentsgate policy [--policy=path]` | Load policy from a specific file |

## Sessions

| Command | Description |
|---------|-------------|
| `agentsgate sessions [list]` | List sessions with event counts and risk stats (requires telemetry) |
| `agentsgate sessions <sessionId>` | Detail for one session |
| `agentsgate session <sessionId>` | Show operations for a specific session |
| `agentsgate session expire <sessionId>` | Force-expire a session — blocks all its future operations |
| `agentsgate session-ops [sessionId]` | Session detail derived from the operation log |

## Agents

| Command | Description |
|---------|-------------|
| `agentsgate agents` | List all agents with operation counts and risk stats |
| `agentsgate agent <agentId>` | Detail view for a single agent |
| `agentsgate agents tools <agentId>` | Tools used by an agent |
| `agentsgate agents sessions <agentId>` | Sessions for an agent |

## Tools

| Command | Description |
|---------|-------------|
| `agentsgate tools` | List all tools with operation counts and risk stats |
| `agentsgate tool <toolName>` | Detail view for a single tool |

## Telemetry

| Command | Description |
|---------|-------------|
| `agentsgate telemetry` | Current in-memory telemetry snapshot |
| `agentsgate telemetry sessions` | Per-session telemetry |
| `agentsgate telemetry agents` | Per-agent telemetry |
| `agentsgate telemetry tools` | Per-tool telemetry |

## Checkpoints & Rollback

| Command | Description |
|---------|-------------|
| `agentsgate checkpoints [limit] [--operationId=X]` | List recent checkpoints |
| `agentsgate snapshot [--operationId=X]` | Manage snapshots |
| `agentsgate diff <checkpointId>` | Show diff for a checkpoint |
| `agentsgate rollback <checkpointId>` | Restore files from a checkpoint |

## Approvals

| Command | Description |
|---------|-------------|
| `agentsgate approvals` | List pending approval requests |
| `agentsgate approve <id>` | Approve a pending operation |
| `agentsgate deny <id>` | Deny a pending operation |

## Audit & Debug

| Command | Description |
|---------|-------------|
| `agentsgate audit [--verify] [--limit=N]` | HMAC-verify operation log integrity |
| `agentsgate verify-logs [--limit=N]` | Verify HMAC signatures on recent logs |
| `agentsgate errors [limit]` | Recent errors recorded by the running proxy |
| `agentsgate circuit-breakers [reset <agentId>]` | View or reset per-agent circuit breakers |
| `agentsgate rate-limits` | View per-agent rate limiter stats |
| `agentsgate quota` | View per-agent daily quota usage |
| `agentsgate report [--agentId=X] [--format=X]` | Generate a risk report |
| `agentsgate tree` | Show the operation tree |
| `agentsgate prune [--days=N] [--dry-run]` | Prune old logs from the database |
| `agentsgate completion [bash\|zsh\|fish]` | Print shell completion script |
