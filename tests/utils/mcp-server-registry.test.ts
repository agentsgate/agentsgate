/**
 * T110 — MCP server registry: discover installed MCP servers.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MCPServerRegistry } from '../../src/utils/mcp-server-registry.js';

async function writeTmpFile(dir: string, name: string, content: unknown): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, JSON.stringify(content), 'utf-8');
  return p;
}

describe('MCPServerRegistry', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-reg-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ── Claude Desktop format ────────────────────────────────────────────────────

  it('discovers servers from claude_desktop_config.json', async () => {
    const cfgPath = await writeTmpFile(tmpDir, 'claude_desktop_config.json', {
      mcpServers: {
        filesystem: { command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] },
        github:     { command: 'npx', args: ['-y', '@mcp/server-github'], env: { GITHUB_TOKEN: 'tok' } },
      },
    });

    const registry = new MCPServerRegistry();
    const servers = await registry.discover([cfgPath]);

    expect(servers).toHaveLength(2);
    const fs_ = servers.find(s => s.name === 'filesystem');
    expect(fs_).toBeDefined();
    expect(fs_!.command).toBe('npx');
    expect(fs_!.args).toEqual(['-y', '@mcp/server-filesystem', '/tmp']);
    expect(fs_!.env).toBeUndefined();
    expect(fs_!.sourceFile).toBe(cfgPath);

    const gh = servers.find(s => s.name === 'github');
    expect(gh!.env).toEqual({ GITHUB_TOKEN: 'tok' });
  });

  // ── .mcp.json format ────────────────────────────────────────────────────────

  it('discovers servers from .mcp.json (servers key)', async () => {
    const cfgPath = await writeTmpFile(tmpDir, '.mcp.json', {
      servers: {
        myserver: { command: 'node', args: ['./server.mjs'] },
      },
    });

    const registry = new MCPServerRegistry();
    const servers = await registry.discover([cfgPath]);

    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('myserver');
    expect(servers[0].command).toBe('node');
    expect(servers[0].args).toEqual(['./server.mjs']);
  });

  // ── Multiple files, deduplication ───────────────────────────────────────────

  it('merges multiple config files and deduplicates by name (first wins)', async () => {
    const p1 = await writeTmpFile(tmpDir, 'claude_desktop_config.json', {
      mcpServers: {
        shared:    { command: 'npx', args: ['first-version'] },
        'only-in-a': { command: 'node', args: ['a.js'] },
      },
    });
    const p2 = await writeTmpFile(tmpDir, 'extra.json', {
      mcpServers: {
        shared:      { command: 'npx', args: ['second-version'] },  // should be ignored
        'only-in-b': { command: 'node', args: ['b.js'] },
      },
    });

    const registry = new MCPServerRegistry();
    const servers = await registry.discover([p1, p2]);

    const shared = servers.find(s => s.name === 'shared');
    expect(shared!.args).toEqual(['first-version']); // first file wins

    const names = servers.map(s => s.name);
    expect(names).toContain('only-in-a');  // eslint-disable-line
    expect(names).toContain('only-in-b');
    expect(servers.filter(s => s.name === 'shared')).toHaveLength(1); // no duplicate
  });

  // ── Missing / invalid files ──────────────────────────────────────────────────

  it('returns empty array when no config files exist', async () => {
    const registry = new MCPServerRegistry();
    const servers = await registry.discover([path.join(tmpDir, 'nonexistent.json')]);
    expect(servers).toHaveLength(0);
  });

  it('skips invalid JSON gracefully', async () => {
    const bad = path.join(tmpDir, 'claude_desktop_config.json');
    await fs.writeFile(bad, 'not json at all', 'utf-8');
    const registry = new MCPServerRegistry();
    const servers = await registry.discover([bad]);
    expect(servers).toHaveLength(0);
  });

  it('skips entries with missing command field', async () => {
    const cfgPath = await writeTmpFile(tmpDir, 'claude_desktop_config.json', {
      mcpServers: {
          'no-command': { args: ['oops'] },         // no command
        'ok-server':  { command: 'node', args: [] },
      },
    });
    const registry = new MCPServerRegistry();
    const servers = await registry.discover([cfgPath]);
    expect(servers).toHaveLength(1);
    expect(servers[0].name).toBe('ok-server');  // eslint-disable-line
  });

  // ── toCommandArray ───────────────────────────────────────────────────────────

  it('toCommandArray builds [command, ...args] array', () => {
    const cfg = {
      name: 'test', command: 'npx', args: ['-y', '@mcp/server', '/path'],
      sourceFile: '/tmp/cfg.json',
    };
    expect(MCPServerRegistry.toCommandArray(cfg)).toEqual(['npx', '-y', '@mcp/server', '/path']);
  });

  it('toCommandArray works with no args', () => {
    const cfg = { name: 'bare', command: 'node', args: [], sourceFile: '/x' };
    expect(MCPServerRegistry.toCommandArray(cfg)).toEqual(['node']);
  });

  // ── getDefaultConfigPaths ────────────────────────────────────────────────────

  it('getDefaultConfigPaths includes .mcp.json and a platform-specific path', () => {
    const paths = MCPServerRegistry.getDefaultConfigPaths();
    expect(paths.some(p => p.endsWith('.mcp.json'))).toBe(true);
    expect(paths.length).toBeGreaterThanOrEqual(2);
  });
});
