/**
 * MCPServerRegistry — Discovers installed MCP server configurations from
 * well-known config file locations (Claude Desktop, project-local .mcp.json)
 * and converts them into StdioProxyOptions-compatible descriptors.
 *
 * Supported config locations (checked in order):
 *   1. Explicitly provided path
 *   2. Project-local:  .mcp.json  (cwd)
 *   3. macOS:   ~/Library/Application Support/Claude/claude_desktop_config.json
 *   4. Windows: %APPDATA%\Claude\claude_desktop_config.json
 *   5. Linux:   ~/.config/Claude/claude_desktop_config.json
 *
 * Config format (Claude Desktop):
 *   { "mcpServers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 *
 * Config format (.mcp.json):
 *   { "servers": { "<name>": { "command": "...", "args": [...], "env": {...} } } }
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** A single MCP server configuration entry. */
export interface MCPServerConfig {
  /** Logical name of the server (key in the config file). */
  name: string;
  /** Executable to run (e.g. "npx", "node", "uvx"). */
  command: string;
  /** Arguments passed to the executable. */
  args: string[];
  /** Optional environment variable overrides for the child process. */
  env?: Record<string, string>;
  /** Source config file this entry was discovered from. */
  sourceFile: string;
}

/** Shape of a single server entry inside a Claude Desktop config file. */
interface RawServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
}

/** Shape of claude_desktop_config.json */
interface ClaudeDesktopConfig {
  mcpServers?: Record<string, RawServerEntry>;
}

/** Shape of .mcp.json */
interface McpJsonConfig {
  servers?: Record<string, RawServerEntry>;
}

/**
 * Discovers MCP server configurations from well-known filesystem locations.
 */
export class MCPServerRegistry {
  /** Return the ordered list of default config paths for the current platform. */
  static getDefaultConfigPaths(): string[] {
    const home = os.homedir();
    const paths: string[] = [
      path.join(process.cwd(), '.mcp.json'),
    ];

    if (process.platform === 'darwin') {
      paths.push(path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'));
    } else if (process.platform === 'win32') {
      const appData = process.env['APPDATA'] ?? path.join(home, 'AppData', 'Roaming');
      paths.push(path.join(appData, 'Claude', 'claude_desktop_config.json'));
    } else {
      // Linux / other
      const xdgConfig = process.env['XDG_CONFIG_HOME'] ?? path.join(home, '.config');
      paths.push(path.join(xdgConfig, 'Claude', 'claude_desktop_config.json'));
    }

    return paths;
  }

  /**
   * Discover MCP server configurations.
   *
   * @param configPaths - Explicit config file paths to try. If omitted, falls
   *   back to `getDefaultConfigPaths()`. All readable paths are merged.
   * @returns Deduplicated list of server configs (first occurrence wins on
   *   duplicate names).
   */
  async discover(configPaths?: string[]): Promise<MCPServerConfig[]> {
    const paths = configPaths ?? MCPServerRegistry.getDefaultConfigPaths();
    const configs: MCPServerConfig[] = [];
    const seenNames = new Set<string>();

    for (const cfgPath of paths) {
      const entries = await this.readConfigFile(cfgPath);
      for (const entry of entries) {
        if (!seenNames.has(entry.name)) {
          seenNames.add(entry.name);
          configs.push(entry);
        }
      }
    }

    return configs;
  }

  /**
   * Read a single config file and extract server entries.
   * Returns an empty array if the file is missing or unparseable.
   */
  private async readConfigFile(filePath: string): Promise<MCPServerConfig[]> {
    let raw: string;
    try {
      raw = await fs.readFile(filePath, 'utf-8');
    } catch {
      return []; // file not found or unreadable
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return []; // invalid JSON
    }

    // Determine format based on file name and structure
    const basename = path.basename(filePath);
    if (basename === '.mcp.json') {
      return this.extractMcpJson(parsed as McpJsonConfig, filePath);
    }
    return this.extractClaudeDesktop(parsed as ClaudeDesktopConfig, filePath);
  }

  private extractClaudeDesktop(config: ClaudeDesktopConfig, sourceFile: string): MCPServerConfig[] {
    if (!config || typeof config !== 'object') return [];
    const servers = config.mcpServers;
    if (!servers || typeof servers !== 'object') return [];
    return this.extractServers(servers, sourceFile);
  }

  private extractMcpJson(config: McpJsonConfig, sourceFile: string): MCPServerConfig[] {
    if (!config || typeof config !== 'object') return [];
    const servers = config.servers;
    if (!servers || typeof servers !== 'object') return [];
    return this.extractServers(servers, sourceFile);
  }

  private extractServers(
    servers: Record<string, RawServerEntry>,
    sourceFile: string
  ): MCPServerConfig[] {
    const result: MCPServerConfig[] = [];
    for (const [name, entry] of Object.entries(servers)) {
      if (!entry || typeof entry !== 'object') continue;
      const command = typeof entry.command === 'string' ? entry.command : undefined;
      if (!command) continue;
      const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
      const env = (entry.env && typeof entry.env === 'object' && !Array.isArray(entry.env))
        ? Object.fromEntries(
            Object.entries(entry.env as Record<string, unknown>)
              .filter(([, v]) => typeof v === 'string')
              .map(([k, v]) => [k, v as string])
          )
        : undefined;
      result.push({ name, command, args, env, sourceFile });
    }
    return result;
  }

  /**
   * Convert a discovered MCPServerConfig into a `command` array suitable for
   * passing directly to `MCPStdioProxy({ command: [...] })`.
   */
  static toCommandArray(config: MCPServerConfig): string[] {
    return [config.command, ...config.args];
  }
}
