import path from 'node:path';
import fs from 'node:fs/promises';
import { StateStore } from '../modules/m2-store/index.js';
import { loadConfig } from '../config.js';
import { inject as cdInject, eject as cdEject, status as cdStatus, getClaudeDesktopConfigPath, getClaudeCodeConfigPath, detectConfigPaths, registerServer, removeServer } from '../utils/claude-desktop-injector.js';
import type { RegisterServerResult } from '../utils/claude-desktop-injector.js';
import { DB_FILE, parseFlag, hasFlag, readState, promptConfirm } from './shared.js';

export async function cmdPrune(args: string[]): Promise<void> {
  const configPath = parseFlag(args, 'config');
  const dryRun = hasFlag(args, 'dry-run');
  const config = await loadConfig(configPath);
  const retentionDays = config.logs?.retentionDays ?? 30;
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

  console.log(`Pruning operation logs older than ${retentionDays} days (before ${cutoff.toISOString()})...`);

  if (dryRun) {
    console.log('Dry run — no changes made.');
    return;
  }

  const store = new StateStore(DB_FILE);
  await store.initialize();
  const deleted = await store.pruneOperationLogs(cutoff);
  await store.close();
  console.log(`Deleted ${deleted} operation log(s).`);
}

// ── T131: Claude Desktop inject / eject ────────────────────────────────────────

/** Resolve the target config path, with auto-detection fallback. */
export async function resolveInjectConfigPath(configFlag: string | undefined, targetFlag: string | undefined): Promise<string> {
  if (configFlag) return configFlag;
  if (targetFlag === 'claude-code')    return getClaudeCodeConfigPath();
  if (targetFlag === 'claude-desktop') return getClaudeDesktopConfigPath();

  // Auto-detect: find which config files actually exist
  const found = await detectConfigPaths();
  if (found.length === 0) {
    // Neither exists — fall back to Claude Desktop default (will error naturally)
    return getClaudeDesktopConfigPath();
  }
  if (found.length === 1) return found[0]!.path;

  // Both exist — prefer Claude Code when running in a terminal/CLI context
  // (TERM or WT_SESSION indicates a terminal; absence suggests GUI / Desktop context)
  const inTerminal = Boolean(process.env['TERM'] ?? process.env['WT_SESSION'] ?? process.env['CLAUDE_CODE']);
  return inTerminal ? found[0]!.path : found[1]!.path;
}

export async function cmdInject(args: string[]): Promise<void> {
  // Allow `agentsgate inject status` (dispatched as ['inject', 'status'])
  let sub = args[0] ?? 'inject';
  if (sub === 'inject' && args[1] === 'status') sub = 'status';

  const configFlag = parseFlag(args, 'config');
  const proxyFlag  = parseFlag(args, 'proxy') ?? 'agentsgate';
  const targetFlag = parseFlag(args, 'target'); // 'claude-code' | 'claude-desktop'

  if (sub === 'status') {
    const cfgPath = configFlag ?? await resolveInjectConfigPath(configFlag, targetFlag);
    const statuses = await cdStatus(cfgPath, proxyFlag);
    if (!statuses.length) {
      console.log(`No MCP servers found in:\n  ${cfgPath}`);
      return;
    }
    const statusLabel = cfgPath === getClaudeCodeConfigPath() ? 'Claude Code' : 'Claude Desktop';
    console.log(`${statusLabel} MCP server injection status (${cfgPath}):\n`);
    for (const s of statuses) {
      const tag = s.injected ? '[injected]' : '[original]';
      console.log(`  ${tag.padEnd(12)} ${s.server.padEnd(24)} ${s.originalCommand}`);
    }
    return;
  }

  if (sub === 'eject') {
    const cfgPath = await resolveInjectConfigPath(configFlag, targetFlag);
    const result = await cdEject(cfgPath, proxyFlag);
    if (result.ejected.length === 0) {
      console.log('No injected servers found to eject.');
    } else {
      console.log(`Ejected AgentsGate from ${result.ejected.length} server(s):`);
      for (const name of result.ejected) console.log(`  - ${name}`);
    }
    if (result.notInjected.length) {
      console.log(`\nNot injected (skipped): ${result.notInjected.join(', ')}`);
    }
    console.log(`\nConfig: ${result.configPath}`);
    return;
  }

  // Default: inject — check for already-running proxies first
  const cfgPath = await resolveInjectConfigPath(configFlag, targetFlag);
  const isClaudeCode = cfgPath === getClaudeCodeConfigPath();

  // 1. Check if the AgentsGate HTTP proxy (agentsgate start) is running
  const runningState = await readState();
  let httpProxyRunning = false;
  if (runningState) {
    try { process.kill(runningState.pid, 0); httpProxyRunning = true; } catch { /* stale */ }
  }

  // 2. Check if any servers are already injected (stdio proxy tier)
  let alreadyInjectedServers: string[] = [];
  try {
    const statuses = await cdStatus(cfgPath, proxyFlag);
    alreadyInjectedServers = statuses.filter(s => s.injected).map(s => s.server);
  } catch { /* config may not exist yet */ }

  const hasTierConflict = httpProxyRunning || alreadyInjectedServers.length > 0;
  if (hasTierConflict) {
    console.error('\n⚠️  WARNING: AgentsGate MCP proxy already detected!\n');
    if (httpProxyRunning && runningState) {
      console.error(`  HTTP proxy (agentsgate start) is RUNNING`);
      console.error(`    PID:       ${runningState.pid}`);
      console.error(`    Port:      ${runningState.port}`);
      console.error(`    Dashboard: http://localhost:${runningState.dashboardPort}`);
      console.error(`    Started:   ${runningState.startedAt}\n`);
    }
    if (alreadyInjectedServers.length > 0) {
      console.error(`  Stdio proxy (agentsgate inject) already wraps ${alreadyInjectedServers.length} server(s):`);
      for (const name of alreadyInjectedServers) console.error(`    - ${name}`);
      console.error('');
    }
    console.error(
      '  Proceeding will add another proxy tier. Running multiple AgentsGate\n' +
      '  proxy layers causes duplicate logging, double risk evaluation, and\n' +
      '  may produce unexpected behaviour.\n'
    );
    const proceed = await promptConfirm('  Proceed and run multiple proxy tiers?');
    if (!proceed) {
      console.error('\nInjection cancelled.');
      process.exit(0);
    }
    console.error('');
  }

  let result;
  try {
    result = await cdInject(cfgPath, proxyFlag);
  } catch (err) {
    console.error(`Failed to inject: ${(err as Error).message}`);
    console.error(`Config path used:\n  ${cfgPath}`);
    console.error(`\nFor Claude Code:    ${getClaudeCodeConfigPath()}`);
    console.error(`For Claude Desktop: ${getClaudeDesktopConfigPath()}`);
    console.error(`\nUse --target=claude-code or --target=claude-desktop to specify explicitly.`);
    process.exit(1);
  }
  if (result.injected.length === 0 && result.alreadyInjected.length > 0) {
    console.log('All servers are already injected.');
  } else if (result.injected.length > 0) {
    console.log(`Injected AgentsGate proxy into ${result.injected.length} server(s):`);
    for (const name of result.injected) console.log(`  + ${name}`);
  }
  if (result.alreadyInjected.length) {
    console.log(`\nAlready injected (skipped): ${result.alreadyInjected.join(', ')}`);
  }
  console.log(`\nConfig:  ${result.configPath}`);
  console.log(`Backup:  ${result.backupPath}`);
  if (isClaudeCode) {
    console.log('\nRestart Claude Code (or reload MCP servers) to apply changes.');
    console.log('In Claude Code: /mcp or restart the session.');
  } else {
    console.log('\nRestart Claude Desktop to apply changes.');
  }
}

// ── T443: inject-db ───────────────────────────────────────────────────────────

export async function cmdInjectDb(args: string[]): Promise<void> {
  const sub = args[0];

  // agentsgate inject-db remove [--name=X] [--config=path] [--target=X]
  if (sub === 'remove') {
    const name       = parseFlag(args, 'name') ?? 'agentsgate-database';
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

  // agentsgate inject-db [--db=path] [--name=X] [--force] [--config=path] [--target=X]
  const dbFlag     = parseFlag(args, 'db');
  const nameFlag   = parseFlag(args, 'name') ?? 'agentsgate-database';
  const forceFlag  = args.includes('--force');
  const configFlag = parseFlag(args, 'config');
  const targetFlag = parseFlag(args, 'target');

  if (!dbFlag) {
    console.error('Error: --db=<path> is required.');
    console.error('Usage: agentsgate inject-db --db=/path/to/database.sqlite [--name=agentsgate-database] [--force]');
    process.exit(1);
  }

  // Resolve the database-mcp binary path relative to this CLI script (dist/)
  const scriptDir = path.dirname(process.argv[1]!);
  const binPath = path.resolve(scriptDir, '..', 'mcp-servers', 'database', 'index.js');

  const entry: { command: string; args: string[] } = {
    command: 'node',
    args: [binPath, '--db', dbFlag],
  };

  const cfgPath = await resolveInjectConfigPath(configFlag, targetFlag);
  const result: RegisterServerResult = await registerServer(nameFlag, entry, { configPath: cfgPath, force: forceFlag });

  if (result.replaced) {
    console.log(`Replaced "${result.name}" in ${result.configPath}`);
  } else if (result.added) {
    console.log(`Registered "${result.name}" in ${result.configPath}`);
    console.log(`  command: node ${binPath}`);
    console.log(`  db:      ${dbFlag}`);
    console.log(`\nRestart Claude Desktop / Claude Code for the change to take effect.`);
  } else {
    console.log(`"${result.name}" is already registered in ${result.configPath}.`);
    console.log(`Use --force to overwrite the existing entry.`);
  }
}

// ── T453: db snapshot prune ───────────────────────────────────────────────────

export async function cmdDbSnapshotPrune(args: string[]): Promise<void> {
  const olderThanFlag = parseFlag(args, 'older-than') ?? '7d';
  const dbFlag = parseFlag(args, 'db');
  if (!dbFlag) {
    console.error('Error: --db=<path> is required.');
    console.error('Usage: agentsgate db snapshot prune --db=/path/to/database.sqlite [--older-than=7d]');
    process.exit(1);
  }

  const match = /^(\d+)(d|h)$/.exec(olderThanFlag);
  if (!match) {
    console.error('Error: --older-than must be in format Nd or Nh (e.g. 7d, 24h)');
    process.exit(1);
  }
  const amount = parseInt(match[1]!, 10);
  const unit = match[2] as 'd' | 'h';
  const cutoffMs = unit === 'd' ? amount * 24 * 60 * 60 * 1000 : amount * 60 * 60 * 1000;
  const cutoff = new Date(Date.now() - cutoffMs);

  const dbPath = path.resolve(dbFlag);
  const dbDir = path.dirname(dbPath);
  const snapshotDir = path.join(dbDir, '.agentsgate-snapshots');

  let files: string[];
  try {
    files = await fs.readdir(snapshotDir);
  } catch {
    console.log('No snapshots directory found — nothing to prune.');
    return;
  }

  const jsonFiles = files.filter(f => f.endsWith('.json'));
  let pruned = 0;
  let skipped = 0;

  for (const file of jsonFiles) {
    const fullPath = path.join(snapshotDir, file);
    const stat = await fs.stat(fullPath).catch(() => null);
    if (!stat) { skipped++; continue; }
    if (stat.mtime < cutoff) {
      await fs.unlink(fullPath).catch(() => { /* ignore */ });
      pruned++;
    } else {
      skipped++;
    }
  }

  console.log(`Pruned ${pruned} snapshot(s) older than ${olderThanFlag}. Kept ${skipped}.`);
}
