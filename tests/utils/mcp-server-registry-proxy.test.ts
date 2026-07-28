/**
 * T126 — MCPServerRegistry integration with agentsgate proxy CLI.
 * Tests the discover sub-command logic and --server auto-selection
 * directly through MCPServerRegistry (CLI integration tested via unit).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPServerRegistry } from '../../src/utils/mcp-server-registry.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-proxy-t126-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('MCPServerRegistry — proxy integration helpers', () => {
  it('discover returns all servers from config', async () => {
    const cfgPath = path.join(tmpDir, 'claude_desktop_config.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] },
        github:     { command: 'npx', args: ['-y', '@mcp/server-github'] },
      },
    }));

    const registry = new MCPServerRegistry();
    const servers = await registry.discover([cfgPath]);
    expect(servers.map(s => s.name).sort()).toEqual(['filesystem', 'github']);
  });

  it('toCommandArray produces valid command array for MCPStdioProxy', async () => {
    const cfgPath = path.join(tmpDir, 'claude_desktop_config.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      mcpServers: {
        myserver: { command: 'node', args: ['./server.mjs', '--port', '3000'] },
      },
    }));
    const registry = new MCPServerRegistry();
    const [server] = await registry.discover([cfgPath]);
    const cmd = MCPServerRegistry.toCommandArray(server);
    expect(cmd).toEqual(['node', './server.mjs', '--port', '3000']);
  });

  it('find by name — returns correct server config', async () => {
    const cfgPath = path.join(tmpDir, 'claude_desktop_config.json');
    await fs.writeFile(cfgPath, JSON.stringify({
      mcpServers: {
        alpha: { command: 'npx', args: ['alpha-server'] },
        beta:  { command: 'uvx', args: ['beta-server', '--debug'] },
      },
    }));
    const registry = new MCPServerRegistry();
    const servers = await registry.discover([cfgPath]);
    const found = servers.find(s => s.name === 'beta');
    expect(found).toBeDefined();
    expect(MCPServerRegistry.toCommandArray(found!)).toEqual(['uvx', 'beta-server', '--debug']);
  });

  it('returns empty when config not found and no fallback', async () => {
    const registry = new MCPServerRegistry();
    const servers = await registry.discover([path.join(tmpDir, 'nonexistent.json')]);
    expect(servers).toHaveLength(0);
  });

  it('discover merges .mcp.json and claude_desktop_config.json', async () => {
    const mcpJson = path.join(tmpDir, '.mcp.json');
    const claudeCfg = path.join(tmpDir, 'claude_desktop_config.json');
    await fs.writeFile(mcpJson, JSON.stringify({ servers: { local: { command: 'node', args: ['local.js'] } } }));
    await fs.writeFile(claudeCfg, JSON.stringify({ mcpServers: { remote: { command: 'npx', args: ['remote'] } } }));

    const registry = new MCPServerRegistry();
    const servers = await registry.discover([mcpJson, claudeCfg]);
    const names = servers.map(s => s.name);
    expect(names).toContain('local');
    expect(names).toContain('remote');
  });
});
