/**
 * T131 — Claude Desktop auto-injection.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { inject, eject, status } from '../../src/utils/claude-desktop-injector.js';

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentsgate-inject-'));
  cfgPath = path.join(tmpDir, 'claude_desktop_config.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function writeConfig(mcpServers: Record<string, unknown>) {
  await fs.writeFile(cfgPath, JSON.stringify({ mcpServers }, null, 2), 'utf-8');
}

async function readConfig() {
  return JSON.parse(await fs.readFile(cfgPath, 'utf-8')) as {
    mcpServers: Record<string, { command: string; args: string[] }>;
  };
}

describe('inject()', () => {
  it('wraps each server command with agentsgate proxy', async () => {
    await writeConfig({
      filesystem: { command: 'npx', args: ['-y', '@mcp/server-filesystem', '/tmp'] },
      github:     { command: 'node', args: ['server.js'] },
    });

    const result = await inject(cfgPath);
    expect(result.injected.sort()).toEqual(['filesystem', 'github']);
    expect(result.alreadyInjected).toHaveLength(0);

    const cfg = await readConfig();
    expect(cfg.mcpServers['filesystem'].command).toBe('agentsgate');
    expect(cfg.mcpServers['filesystem'].args).toEqual(['proxy', '--', 'npx', '-y', '@mcp/server-filesystem', '/tmp']);
    expect(cfg.mcpServers['github'].args).toEqual(['proxy', '--', 'node', 'server.js']);
  });

  it('creates a backup file alongside the config', async () => {
    await writeConfig({ myserver: { command: 'node', args: ['s.js'] } });
    const result = await inject(cfgPath);
    const bkp = await fs.readFile(result.backupPath, 'utf-8');
    const parsed = JSON.parse(bkp) as { mcpServers: Record<string, unknown> };
    expect(parsed.mcpServers['myserver']).toBeDefined();
    // Backup has the original command
    expect((parsed.mcpServers['myserver'] as { command: string }).command).toBe('node');
  });

  it('skips already-injected servers', async () => {
    await writeConfig({
      already: { command: 'agentsgate', args: ['proxy', '--', 'node', 's.js'] },
      fresh:   { command: 'npx', args: ['pkg'] },
    });

    const result = await inject(cfgPath);
    expect(result.injected).toEqual(['fresh']);
    expect(result.alreadyInjected).toEqual(['already']);
  });

  it('preserves unrelated config keys', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({
      someOtherKey: 'preserved',
      mcpServers: { srv: { command: 'node', args: [] } },
    }), 'utf-8');

    await inject(cfgPath);
    const raw = JSON.parse(await fs.readFile(cfgPath, 'utf-8')) as { someOtherKey: string };
    expect(raw.someOtherKey).toBe('preserved');
  });

  it('uses custom proxyCommand', async () => {
    await writeConfig({ srv: { command: 'node', args: ['s.js'] } });
    await inject(cfgPath, '/usr/local/bin/agentsgate');
    const cfg = await readConfig();
    expect(cfg.mcpServers['srv'].command).toBe('/usr/local/bin/agentsgate');
  });
});

describe('eject()', () => {
  it('restores original command and args', async () => {
    await writeConfig({ srv: { command: 'npx', args: ['-y', 'server-pkg'] } });
    await inject(cfgPath);

    const result = await eject(cfgPath);
    expect(result.ejected).toEqual(['srv']);

    const cfg = await readConfig();
    expect(cfg.mcpServers['srv'].command).toBe('npx');
    expect(cfg.mcpServers['srv'].args).toEqual(['-y', 'server-pkg']);
  });

  it('removes the backup file after eject', async () => {
    await writeConfig({ srv: { command: 'node', args: ['s.js'] } });
    const { backupPath } = await inject(cfgPath);
    await eject(cfgPath);
    await expect(fs.access(backupPath)).rejects.toThrow();
  });

  it('reports notInjected servers', async () => {
    await writeConfig({
      injected: { command: 'agentsgate', args: ['proxy', '--', 'node', 's.js'] },
      plain:    { command: 'node', args: ['p.js'] },
    });
    const result = await eject(cfgPath);
    expect(result.ejected).toEqual(['injected']);
    expect(result.notInjected).toEqual(['plain']);
  });
});

describe('status()', () => {
  it('returns injected=false for plain servers', async () => {
    await writeConfig({ fs: { command: 'npx', args: ['-y', 'pkg'] } });
    const s = await status(cfgPath);
    expect(s).toHaveLength(1);
    expect(s[0].injected).toBe(false);
    expect(s[0].server).toBe('fs');
    expect(s[0].originalCommand).toContain('npx');
  });

  it('returns injected=true after inject()', async () => {
    await writeConfig({ fs: { command: 'node', args: ['s.js'] } });
    await inject(cfgPath);
    const s = await status(cfgPath);
    expect(s[0].injected).toBe(true);
    expect(s[0].originalCommand).toContain('node s.js');
  });

  it('returns empty array when config file is missing', async () => {
    const s = await status(path.join(tmpDir, 'nonexistent.json'));
    expect(s).toHaveLength(0);
  });
});
