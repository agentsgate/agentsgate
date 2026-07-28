#!/usr/bin/env node
/**
 * AgentsGate CLI
 * Usage:
 *   agentsgate start [port] [--config=path] [--team=NAME]  Start the proxy
 *   agentsgate stop                          Stop the running proxy
 *   agentsgate status [--team=NAME]          Show proxy status
 *   agentsgate logs [limit] [--action=X] [--tool=X] [--agentId=X]
 *   agentsgate telemetry [agents|tools]       Show telemetry stats
 *   agentsgate telemetry export --otlp=<url> Export OTLP metrics to collector
 *   agentsgate approvals                     List pending approvals
 *   agentsgate approve <id>                  Approve a pending operation
 *   agentsgate deny <id>                     Deny a pending operation
 *   agentsgate checkpoints [limit]           List recent checkpoints
 *   agentsgate rollback <checkpointId>       Roll back to a checkpoint
 *   agentsgate config                        Print current effective config
 *   agentsgate policy [--policy=path]        Print current effective policy
 */
import path from 'node:path';
import { registerServer, removeServer } from './utils/claude-desktop-injector.js';
import { parseFlag } from './cli/shared.js';
import { AGENTSGATE_VERSION } from './version.js';
import { cmdStart, cmdStop, cmdStatus, cmdSession, cmdConfig, cmdProxy, cmdDoctor } from './cli/lifecycle.js';
import { cmdLogs, cmdOpsStats, cmdOps, cmdExport } from './cli/ops.js';
import { cmdAgents } from './cli/agents.js';
import { cmdTools } from './cli/tools.js';
import { cmdSessionsOps } from './cli/sessions-ops.js';
import { cmdTop, cmdWatch, cmdSessions, cmdDiff, cmdSnapshot } from './cli/sessions.js';
import { cmdHealth, cmdQuota, cmdCheckpointsCli, cmdRisk, cmdTelemetry, cmdApprovals, cmdErrors, cmdResolve, cmdRollback, cmdCircuitBreakers, cmdVerifyLogs, cmdRateLimits, cmdBenchmark } from './cli/dashboard-cmds.js';
import { cmdPolicy } from './cli/policy-cmd.js';
import { cmdTree, cmdExplain, cmdReport, cmdAudit, cmdReplay } from './cli/reports.js';
import { cmdPrune, cmdInject, cmdInjectDb, cmdDbSnapshotPrune, resolveInjectConfigPath } from './cli/inject.js';

const ALL_COMMANDS = [
  'start', 'stop', 'status', 'logs', 'telemetry', 'approvals', 'approve', 'deny',
  'checkpoints', 'rollback', 'config', 'policy', 'proxy', 'export', 'prune', 'audit',
  'replay', 'completion',
];

const BASH_COMPLETION = `
# AgentsGate bash completion
# Add to ~/.bashrc:  source <(agentsgate completion bash)

_agentsgate_complete() {
  local cur prev
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

  local commands="${ALL_COMMANDS.join(' ')}"
  local policy_cmds="list add remove set-threshold"

  case "\${prev}" in
    agentsgate)
      COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
      return 0 ;;
    policy)
      COMPREPLY=( $(compgen -W "\${policy_cmds}" -- "\${cur}") )
      return 0 ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh" -- "\${cur}") )
      return 0 ;;
    approve|deny|rollback)
      return 0 ;;
    *)
      COMPREPLY=( $(compgen -W "--config= --agentId= --action= --tool= --format= --output= --from= --to= --dry-run --diff" -- "\${cur}") )
      return 0 ;;
  esac
}

complete -F _agentsgate_complete agentsgate
`;

const ZSH_COMPLETION = `
# AgentsGate zsh completion
# Add to ~/.zshrc:  source <(agentsgate completion zsh)

_agentsgate() {
  local -a commands
  commands=(
    ${ALL_COMMANDS.map(c => `'${c}'`).join('\n    ')}
  )

  local -a policy_cmds
  policy_cmds=('list' 'add' 'remove' 'set-threshold')

  local -a shells
  shells=('bash' 'zsh')

  local -a flags
  flags=(
    '--config=[path to config file]'
    '--agentId=[filter by agent ID]'
    '--action=[filter by action: allow|block|require_approval]'
    '--tool=[filter by tool name]'
    '--format=[output format: json|csv]'
    '--output=[output file path]'
    '--from=[ISO date start of window]'
    '--to=[ISO date end of window]'
    '--dry-run[preview without making changes]'
    '--diff[show risk trend diff]'
  )

  _arguments -C \\
    '1: :->command' \\
    '*: :->args'

  case $state in
    command)
      _describe 'command' commands ;;
    args)
      case $words[2] in
        policy)     _describe 'subcommand' policy_cmds ;;
        completion) _describe 'shell' shells ;;
        *)          _describe 'option' flags ;;
      esac ;;
  esac
}

compdef _agentsgate agentsgate
`;

function cmdCompletion(args: string[]): void {
  const shell = (args[0] ?? 'bash').toLowerCase();
  if (shell === 'zsh') {
    process.stdout.write(ZSH_COMPLETION.trimStart());
  } else {
    process.stdout.write(BASH_COMPLETION.trimStart());
  }
}

// ── T452: inject-pg ───────────────────────────────────────────────────────────

async function cmdInjectPg(args: string[]): Promise<void> {
  const sub = args[0];

  // agentsgate inject-pg remove [--name=X] [--config=path] [--target=X]
  if (sub === 'remove') {
    const name       = parseFlag(args, 'name') ?? 'agentsgate-pg-database';
    const configFlag = parseFlag(args, 'config');
    const targetFlag = parseFlag(args, 'target');
    const cfgPath    = await resolveInjectConfigPath(configFlag, targetFlag);
    const result     = await removeServer(name, { configPath: cfgPath });
    if (result.removed) {
      console.log(`Removed "${result.name}" from ${result.configPath}`);
    } else {
      console.log(`"${result.name}" was not found in ${result.configPath}`);
    }
    return;
  }

  // agentsgate inject-pg [--connection-string=X] [--name=X] [--force] [--config=path] [--target=X]
  const connFlag   = parseFlag(args, 'connection-string') ?? parseFlag(args, 'conn');
  const nameFlag   = parseFlag(args, 'name') ?? 'agentsgate-pg-database';
  const forceFlag  = args.includes('--force');
  const configFlag = parseFlag(args, 'config');
  const targetFlag = parseFlag(args, 'target');

  if (!connFlag) {
    console.error('Error: --connection-string=<url> is required.');
    console.error('Usage: agentsgate inject-pg --connection-string=postgresql://user:pass@host:5432/db [--name=agentsgate-pg-database] [--force]');
    process.exit(1);
  }

  const scriptDir = path.dirname(process.argv[1]!);
  const binPath = path.resolve(scriptDir, '..', 'mcp-servers', 'pg-database', 'index.js');

  const entry: { command: string; args: string[] } = {
    command: 'node',
    args: [binPath, '--connection-string', connFlag],
  };

  const cfgPath = await resolveInjectConfigPath(configFlag, targetFlag);
  const result  = await registerServer(nameFlag, entry, { configPath: cfgPath, force: forceFlag });

  if (result.replaced) {
    console.log(`Replaced "${result.name}" in ${result.configPath}`);
  } else if (result.added) {
    console.log(`Registered "${result.name}" in ${result.configPath}`);
    console.log(`  command: node ${binPath}`);
    console.log(`  connection: ${connFlag.replace(/:([^:@]+)@/, ':***@')}`);
    console.log(`\nRestart Claude Desktop / Claude Code for the change to take effect.`);
  } else {
    console.log(`"${result.name}" is already registered in ${result.configPath}.`);
    console.log(`Use --force to overwrite the existing entry.`);
  }
}

// ── T460: inject-mysql ────────────────────────────────────────────────────────

async function cmdInjectMysql(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === 'remove') {
    const name       = parseFlag(args, 'name') ?? 'agentsgate-mysql-database';
    const configFlag = parseFlag(args, 'config');
    const targetFlag = parseFlag(args, 'target');
    const cfgPath    = await resolveInjectConfigPath(configFlag, targetFlag);
    const result     = await removeServer(name, { configPath: cfgPath });
    if (result.removed) {
      console.log(`Removed "${result.name}" from ${result.configPath}`);
    } else {
      console.log(`"${result.name}" was not found in ${result.configPath}`);
    }
    return;
  }

  const connFlag   = parseFlag(args, 'connection-string') ?? parseFlag(args, 'conn');
  const nameFlag   = parseFlag(args, 'name') ?? 'agentsgate-mysql-database';
  const forceFlag  = args.includes('--force');
  const configFlag = parseFlag(args, 'config');
  const targetFlag = parseFlag(args, 'target');

  if (!connFlag) {
    console.error('Error: --connection-string=<url> is required.');
    console.error('Usage: agentsgate inject-mysql --connection-string=mysql://user:pass@host:3306/db [--name=agentsgate-mysql-database] [--force]');
    process.exit(1);
  }

  const scriptDir = path.dirname(process.argv[1]!);
  const binPath = path.resolve(scriptDir, '..', 'mcp-servers', 'mysql-database', 'index.js');

  const entry: { command: string; args: string[] } = {
    command: 'node',
    args: [binPath, '--connection-string', connFlag],
  };

  const cfgPath = await resolveInjectConfigPath(configFlag, targetFlag);
  const result  = await registerServer(nameFlag, entry, { configPath: cfgPath, force: forceFlag });

  if (result.replaced) {
    console.log(`Replaced "${result.name}" in ${result.configPath}`);
  } else if (result.added) {
    console.log(`Registered "${result.name}" in ${result.configPath}`);
    console.log(`  command: node ${binPath}`);
    console.log(`  connection: ${connFlag.replace(/:([^:@]+)@/, ':***@')}`);
    console.log(`\nRestart Claude Desktop / Claude Code for the change to take effect.`);
  } else {
    console.log(`"${result.name}" is already registered in ${result.configPath}.`);
    console.log(`Use --force to overwrite the existing entry.`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const [command, ...rest] = args;

function run(fn: () => Promise<void>): void {
  fn().catch((err: unknown) => {
    console.error('Error:', (err as Error).message);
    process.exit(1);
  });
}

switch (command) {
  case 'start':       run(() => cmdStart(rest)); break;
  case 'stop':        run(cmdStop); break;
  case 'status':      run(() => cmdStatus(rest)); break;
  case 'logs':        run(() => cmdLogs(rest)); break;
  case 'telemetry':   run(() => cmdTelemetry(rest)); break;
  case 'approvals':   run(cmdApprovals); break;
  case 'approve': {
    const approveId = rest[0];
    if (!approveId) { console.error('Usage: agentsgate approve <id>'); process.exit(1); }
    run(() => cmdResolve(approveId, true));
    break;
  }
  case 'deny': {
    const denyId = rest[0];
    if (!denyId) { console.error('Usage: agentsgate deny <id>'); process.exit(1); }
    run(() => cmdResolve(denyId, false));
    break;
  }
  case 'checkpoints': run(() => cmdCheckpointsCli(rest)); break; // T279: enhanced with --operationId
  case 'rollback': {
    const cpId = rest[0];
    if (!cpId) { console.error('Usage: agentsgate rollback <checkpointId>'); process.exit(1); }
    run(() => cmdRollback(cpId));
    break;
  }
  case 'config':      run(() => cmdConfig(rest)); break;
  case 'policy':      run(() => cmdPolicy(rest)); break;
  case 'proxy':       run(() => cmdProxy(rest)); break;
  case 'export':      run(() => cmdExport(rest)); break;
  case 'prune':       run(() => cmdPrune(rest)); break;
  case 'audit':       run(() => cmdAudit(rest)); break;
  case 'replay':      run(() => cmdReplay(rest)); break;
  case 'completion':  cmdCompletion(rest); break;
  case 'inject':      run(() => cmdInject(['inject', ...rest])); break;
  case 'inject-db':   run(() => cmdInjectDb(rest)); break;
  case 'inject-sqlite': run(() => cmdInjectDb(rest)); break;
  case 'inject-pg':   run(() => cmdInjectPg(rest)); break;
  case 'inject-mysql': run(() => cmdInjectMysql(rest)); break;
  case 'db':
    if (rest[0] === 'snapshot' && rest[1] === 'prune') {
      run(() => cmdDbSnapshotPrune(rest.slice(2)));
    } else {
      console.error(`Unknown db subcommand: ${rest.join(' ')}`);
      process.exit(1);
    }
    break;
  case 'eject':       run(() => cmdInject(['eject', ...rest])); break;
  case 'doctor':      run(() => cmdDoctor(rest)); break;
  case 'session':     run(() => cmdSession(rest)); break;
  case 'ops':         run(() => cmdOps(rest)); break;
  case 'ops-stats':   run(() => cmdOpsStats(rest)); break;
  case 'benchmark':   run(() => cmdBenchmark(rest)); break;
  case 'explain':     run(() => cmdExplain(rest)); break;
  case 'report':      run(() => cmdReport(rest)); break;
  case 'snapshot':    run(() => cmdSnapshot(rest)); break;
  case 'diff':        run(() => cmdDiff(rest)); break;
  case 'tree':        run(() => cmdTree(rest)); break;
  case 'circuit-breakers': run(() => cmdCircuitBreakers(rest)); break;
  case 'sessions':         run(() => cmdSessions(rest)); break;
  case 'watch':            run(() => cmdWatch(rest)); break;
  case 'verify-logs':      run(() => cmdVerifyLogs(rest)); break;
  case 'rate-limits':      run(() => cmdRateLimits(rest)); break;
  case 'top':              run(() => cmdTop(rest)); break;
  case 'health':           run(() => cmdHealth(rest)); break;
  case 'agents':           run(() => cmdAgents(rest)); break;
  case 'agent':            run(() => cmdAgents(rest)); break;  // shorthand
  case 'tools':            run(() => cmdTools(rest)); break;
  case 'tool':             run(() => cmdTools(rest)); break;   // shorthand
  case 'quota':            run(() => cmdQuota(rest)); break;
  case 'risk':             run(() => cmdRisk(rest)); break;
  case 'session-ops':      run(() => cmdSessionsOps(rest)); break; // uses ops data (T277)
  case 'errors':           run(() => cmdErrors(rest)); break;

  default: {
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
    process.exit(command ? 1 : 0);
  }
}
