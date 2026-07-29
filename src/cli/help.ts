/**
 * The CLI banner and usage block.
 *
 * Lives apart from the dispatch switch so `--version` can print the version on
 * its own, and so both can be asserted without spawning the built entry point.
 */
import { AGENTSGATE_VERSION } from '../version.js';

/** Just the version — no banner suffix, no usage. */
export const VERSION_LINE = `AgentsGate v${AGENTSGATE_VERSION}`;

/** The banner followed by every command the CLI accepts. */
export function printUsage(): void {
  console.log(`AgentsGate v${AGENTSGATE_VERSION} — MCP Proxy Gateway\n`);
  console.log('Usage:');
  console.log('  agentsgate start [port] [--config=path] [--dry-run] [--team=NAME] [--foreground]  Start the proxy (background by default)');
  console.log('  agentsgate stop                          Stop the proxy');
  console.log('  agentsgate status [--team=NAME]          Show status');
  console.log('    --team=NAME       Namespace identifier — uses ~/.agentsgate/data-{NAME}.db');
  console.log('  agentsgate logs [N] [--action=X] [--tool=X] [--agentId=X]');
  console.log('  agentsgate telemetry                     Show telemetry stats');
  console.log('  agentsgate telemetry agents              Per-agent telemetry table');
  console.log('  agentsgate telemetry tools               Per-tool telemetry table');
  console.log('  agentsgate telemetry export --otlp=<url> Export metrics via OTLP to collector');
  console.log('  agentsgate approvals                     List pending approvals');
  console.log('  agentsgate approve <id>                  Approve an operation');
  console.log('  agentsgate deny <id>                     Deny an operation');
  console.log('  agentsgate checkpoints [N]               List recent checkpoints');
  console.log('  agentsgate rollback <checkpointId>       Roll back a checkpoint');
  console.log('  agentsgate config [--config=path]        Show effective config');
  console.log('  agentsgate policy [list|add|remove|set-threshold]');
  console.log('  agentsgate proxy [--server=name|-- <cmd>]  Stdio MCP proxy');
  console.log('  agentsgate proxy discover                  List discovered MCP servers');
  console.log('  agentsgate export [N] [--format=json|csv|ndjson] [--output=file]');
  console.log('  agentsgate prune [--dry-run] [--config=path]  Prune old logs');
  console.log('  agentsgate audit [N] [--from=ISO] [--to=ISO] [--agentId=X] [--diff]');
  console.log('  agentsgate errors [N]                        Recent errors recorded by the proxy');
  console.log('  agentsgate replay [N] [--policy=path] [--output=file]  Re-evaluate stored ops');
  console.log('  agentsgate completion [bash|zsh]             Shell tab-completion script');
  console.log('  agentsgate inject [--config=path]            Inject proxy into Claude Desktop config');
  console.log('  agentsgate inject status [--config=path]     Show injection status');
  console.log('  agentsgate eject  [--config=path]            Remove proxy from Claude Desktop config');
  console.log('  agentsgate inject-db --db=<path>             Register database MCP server in Claude config');
  console.log('  agentsgate inject-db remove [--name=X]       Remove database MCP server from Claude config');
  console.log('  agentsgate inject-sqlite --db=<path>              Register SQLite MCP server (alias for inject-db)');
  console.log('  agentsgate inject-pg --connection-string=<url>   Register PostgreSQL MCP server in Claude config');
  console.log('  agentsgate inject-pg remove [--name=X]           Remove PostgreSQL MCP server from Claude config');
  console.log('  agentsgate inject-mysql --connection-string=<url>  Register MySQL MCP server in Claude config');
  console.log('  agentsgate inject-mysql remove [--name=X]          Remove MySQL MCP server from Claude config');
  console.log('  agentsgate db snapshot prune --db=<path>         Delete snapshots older than 7d (default)');
  console.log('  agentsgate db snapshot prune --older-than=<Nd>   e.g. --older-than=30d or --older-than=24h');
  console.log('  agentsgate doctor [--config=path]            Self-check: DB, shadow, policy, proxy');
  console.log('  agentsgate session expire <sessionId>        Force-expire a session (block all future ops)');
  console.log('  agentsgate session-ops [sessionId]           Show operation-based session detail (T277)');
  console.log('  agentsgate ops watch                         Live-tail the operation stream in terminal');
  console.log('  agentsgate benchmark [N] [--concurrency=C]   Measure proxy throughput with N synthetic ops');
  console.log('  agentsgate explain <operationId>             Print full risk score breakdown for an operation');
  console.log('  agentsgate report [N] [--output=file]        Generate markdown compliance summary');
  console.log('  agentsgate snapshot [list|inspect|delete]    Manage checkpoint snapshots');
  console.log('  agentsgate tree <operationId> [--depth=N]    Show causality tree of chained operations');
  console.log('  agentsgate circuit-breakers [list|reset <agentId>]  Manage circuit breakers');
}
