/**
 * Claude Desktop Auto-Injection (T131)
 *
 * Modifies claude_desktop_config.json so each MCP server is wrapped by the
 * AgentsGate stdio proxy. Before modifying, the original config is backed up
 * alongside the target file as `<name>.agentsgate.bak.json`.
 *
 * Injected entry format:
 *   { "command": "agentsgate", "args": ["proxy", "--", "<original_cmd>", ...original_args] }
 *
 * Detection: an entry is considered already injected when
 *   command === proxyCommand && args[0] === 'proxy' && args[1] === '--'
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

/**
 * Write a config/backup file that may contain secrets (e.g. database connection
 * strings passed to `inject-pg`/`inject-mysql`).
 *
 * - Restrictive `0o600` permissions (owner read/write only) so the secret is not
 *   left group/world-readable under the process umask.
 * - Atomic: writes to a randomly-named temp file in the same directory then
 *   renames over the target, so a crash mid-write can never truncate/corrupt the
 *   existing config, and the rename replaces (rather than writes through) any
 *   symlink pre-planted at the target path.
 */
async function writeConfigSecurely(targetPath: string, content: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.${path.basename(targetPath)}.tmp-${crypto.randomBytes(6).toString('hex')}`);
  try {
    await fs.writeFile(tmpPath, content, { encoding: 'utf-8', mode: 0o600, flag: 'wx' });
    await fs.rename(tmpPath, targetPath);
    // Defensive: ensure restrictive perms even if the target pre-existed.
    await fs.chmod(targetPath, 0o600).catch(() => { /* best effort */ });
  } catch (err) {
    await fs.unlink(tmpPath).catch(() => { /* temp may not exist */ });
    throw err;
  }
}

interface RawServerEntry {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  [key: string]: unknown;
}

interface ClaudeDesktopConfig {
  mcpServers?: Record<string, RawServerEntry>;
  [key: string]: unknown;
}

export interface InjectionStatus {
  server: string;
  injected: boolean;
  /** Original command string (before injection, or unwrapped from args). */
  originalCommand: string;
}

export interface InjectionResult {
  configPath: string;
  backupPath: string;
  injected: string[];
  alreadyInjected: string[];
}

export interface EjectResult {
  configPath: string;
  ejected: string[];
  notInjected: string[];
}

export interface RegisterServerResult {
  configPath: string;
  name: string;
  added: boolean;      // true if newly added
  replaced: boolean;   // true if an existing entry was overwritten (--force)
}

export interface RemoveServerResult {
  configPath: string;
  name: string;
  removed: boolean;    // true if the entry existed and was removed
}

/**
 * Returns the platform-specific Claude Desktop config path.
 */
export function getClaudeDesktopConfigPath(): string {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  }
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Claude', 'claude_desktop_config.json');
  }
  const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
  return path.join(xdgConfig, 'Claude', 'claude_desktop_config.json');
}

/**
 * Returns the Claude Code global settings path (~/.claude/settings.json).
 * Claude Code uses this file for MCP server configuration — it is separate
 * from the Claude Desktop config.
 */
export function getClaudeCodeConfigPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json');
}

/**
 * Auto-detect which config file(s) exist on disk.
 * Returns paths in preference order: Claude Code first (more likely when
 * the user is working in a terminal/CLI context), then Claude Desktop.
 */
export async function detectConfigPaths(): Promise<{ path: string; target: 'claude-code' | 'claude-desktop' }[]> {
  const candidates: { path: string; target: 'claude-code' | 'claude-desktop' }[] = [
    { path: getClaudeCodeConfigPath(),    target: 'claude-code' },
    { path: getClaudeDesktopConfigPath(), target: 'claude-desktop' },
  ];
  const found: { path: string; target: 'claude-code' | 'claude-desktop' }[] = [];
  for (const c of candidates) {
    try { await fs.access(c.path); found.push(c); } catch { /* not present */ }
  }
  return found;
}

function backupPath(cfgPath: string): string {
  const ext = path.extname(cfgPath);
  const base = cfgPath.slice(0, -ext.length);
  return `${base}.agentsgate.bak${ext}`;
}

function isInjected(entry: RawServerEntry, proxyCmd: string): boolean {
  return entry.command === proxyCmd
    && Array.isArray(entry.args)
    && entry.args[0] === 'proxy'
    && entry.args[1] === '--';
}

/**
 * Inject AgentsGate proxy into every non-injected MCP server in the config.
 *
 * @param configPath    Path to claude_desktop_config.json (defaults to platform path).
 * @param proxyCommand  The agentsgate executable name on PATH (default: "agentsgate").
 */
export async function inject(
  configPath?: string,
  proxyCommand = 'agentsgate'
): Promise<InjectionResult> {
  const cfgPath = configPath ?? getClaudeDesktopConfigPath();
  const bkpPath = backupPath(cfgPath);

  const raw = await fs.readFile(cfgPath, 'utf-8');
  const config = JSON.parse(raw) as ClaudeDesktopConfig;

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  // Write backup before mutating (may contain secrets — same restrictive write)
  await writeConfigSecurely(bkpPath, raw);

  const injected: string[] = [];
  const alreadyInjected: string[] = [];

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (isInjected(entry, proxyCommand)) {
      alreadyInjected.push(name);
      continue;
    }

    const originalCmd = entry.command ?? '';
    const originalArgs = Array.isArray(entry.args) ? entry.args : [];

    config.mcpServers[name] = {
      ...entry,
      command: proxyCommand,
      args: ['proxy', '--', originalCmd, ...originalArgs],
    };

    injected.push(name);
  }

  await writeConfigSecurely(cfgPath, JSON.stringify(config, null, 2));

  return { configPath: cfgPath, backupPath: bkpPath, injected, alreadyInjected };
}

/**
 * Remove AgentsGate proxy injection, restoring the original command/args for
 * each server. If a backup file exists it is removed after a successful eject.
 */
export async function eject(
  configPath?: string,
  proxyCommand = 'agentsgate'
): Promise<EjectResult> {
  const cfgPath = configPath ?? getClaudeDesktopConfigPath();
  const bkpPath = backupPath(cfgPath);

  const raw = await fs.readFile(cfgPath, 'utf-8');
  const config = JSON.parse(raw) as ClaudeDesktopConfig;

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    return { configPath: cfgPath, ejected: [], notInjected: [] };
  }

  const ejected: string[] = [];
  const notInjected: string[] = [];

  for (const [name, entry] of Object.entries(config.mcpServers)) {
    if (!isInjected(entry, proxyCommand)) {
      notInjected.push(name);
      continue;
    }

    // args = ['proxy', '--', <original_cmd>, ...original_args]
    const args = entry.args ?? [];
    const originalCmd  = args[2] ?? '';
    const originalArgs = args.slice(3);

    config.mcpServers[name] = {
      ...entry,
      command: originalCmd,
      args: originalArgs,
    };

    ejected.push(name);
  }

  await writeConfigSecurely(cfgPath, JSON.stringify(config, null, 2));

  // Remove backup if it exists
  try { await fs.unlink(bkpPath); } catch { /* no backup — fine */ }

  return { configPath: cfgPath, ejected, notInjected };
}

/**
 * Register a new named MCP server entry in the config.
 * If the entry already exists and force is not set, returns added: false, replaced: false.
 * If force is set and the entry already exists, overwrites and returns replaced: true.
 */
export async function registerServer(
  name: string,
  entry: RawServerEntry,
  options: { configPath?: string; force?: boolean } = {}
): Promise<RegisterServerResult> {
  const cfgPath = options.configPath ?? getClaudeDesktopConfigPath();

  let config: ClaudeDesktopConfig;
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    config = JSON.parse(raw) as ClaudeDesktopConfig;
  } catch {
    config = { mcpServers: {} };
  }

  if (!config.mcpServers || typeof config.mcpServers !== 'object') {
    config.mcpServers = {};
  }

  if (name in config.mcpServers && options.force !== true) {
    return { configPath: cfgPath, name, added: false, replaced: false };
  }

  const replaced = name in config.mcpServers && options.force === true;
  config.mcpServers[name] = entry;

  await writeConfigSecurely(cfgPath, JSON.stringify(config, null, 2));

  return { configPath: cfgPath, name, added: !replaced, replaced };
}

/**
 * Remove a named MCP server entry from the config.
 * Returns removed: false if the entry did not exist.
 */
export async function removeServer(
  name: string,
  options: { configPath?: string } = {}
): Promise<RemoveServerResult> {
  const cfgPath = options.configPath ?? getClaudeDesktopConfigPath();

  let config: ClaudeDesktopConfig;
  try {
    const raw = await fs.readFile(cfgPath, 'utf-8');
    config = JSON.parse(raw) as ClaudeDesktopConfig;
  } catch {
    return { configPath: cfgPath, name, removed: false };
  }

  if (!config.mcpServers || !(name in config.mcpServers)) {
    return { configPath: cfgPath, name, removed: false };
  }

  delete config.mcpServers[name];
  await writeConfigSecurely(cfgPath, JSON.stringify(config, null, 2));

  return { configPath: cfgPath, name, removed: true };
}

/**
 * Return the injection status of each server without modifying any files.
 */
export async function status(
  configPath?: string,
  proxyCommand = 'agentsgate'
): Promise<InjectionStatus[]> {
  const cfgPath = configPath ?? getClaudeDesktopConfigPath();

  let raw: string;
  try {
    raw = await fs.readFile(cfgPath, 'utf-8');
  } catch {
    return [];
  }

  const config = JSON.parse(raw) as ClaudeDesktopConfig;
  if (!config.mcpServers) return [];

  return Object.entries(config.mcpServers).map(([name, entry]) => {
    const injectedFlag = isInjected(entry, proxyCommand);
    let originalCommand: string;
    if (injectedFlag) {
      const args = entry.args ?? [];
      originalCommand = [args[2] ?? '', ...args.slice(3)].join(' ').trim();
    } else {
      originalCommand = [entry.command ?? '', ...(entry.args ?? [])].join(' ').trim();
    }
    return { server: name, injected: injectedFlag, originalCommand };
  });
}
