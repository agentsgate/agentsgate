/**
 * src/cli/inject.ts — registering MCP servers in the Claude config.
 *
 * Every test passes an explicit --config so nothing touches a real Claude
 * Desktop or Claude Code configuration on the machine running the suite.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { redirectHome, capture } from './helpers.js';

redirectHome();

const { cmdInject, cmdInjectDb, resolveInjectConfigPath } = await import('../../src/cli/inject.js');

let cfgPath: string;
let dbPath: string;

beforeEach(async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-inject-'));
  cfgPath = path.join(dir, 'claude_desktop_config.json');
  dbPath = path.join(dir, 'data.sqlite');
  await fs.writeFile(cfgPath, JSON.stringify({ mcpServers: {} }, null, 2));
  await fs.writeFile(dbPath, '');
});

async function readConfig(): Promise<{ mcpServers: Record<string, { command?: string; args?: string[] }> }> {
  return JSON.parse(await fs.readFile(cfgPath, 'utf8')) as never;
}

describe('resolveInjectConfigPath', () => {
  it('honours an explicit --config over everything else', async () => {
    expect(await resolveInjectConfigPath('/tmp/explicit.json', 'claude-code')).toBe('/tmp/explicit.json');
  });

  it('resolves a distinct path per target', async () => {
    const code = await resolveInjectConfigPath(undefined, 'claude-code');
    const desktop = await resolveInjectConfigPath(undefined, 'claude-desktop');
    expect(code).not.toBe(desktop);
    expect(code.length).toBeGreaterThan(0);
    expect(desktop.length).toBeGreaterThan(0);
  });

  it('falls back to a usable path when no target is given', async () => {
    const auto = await resolveInjectConfigPath(undefined, undefined);
    expect(path.isAbsolute(auto)).toBe(true);
  });
});

describe('cmdInjectDb — register', () => {
  it('requires --db', async () => {
    const r = await capture(() => cmdInjectDb([`--config=${cfgPath}`]));
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('--db=<path> is required');
  });

  it('adds an entry under the default server name', async () => {
    const r = await capture(() => cmdInjectDb([`--db=${dbPath}`, `--config=${cfgPath}`]));
    expect(r.exitCode).toBeUndefined();

    const cfg = await readConfig();
    expect(Object.keys(cfg.mcpServers)).toContain('agentsgate-database');
  });

  it('honours a custom --name so several databases can coexist', async () => {
    await capture(() => cmdInjectDb([`--db=${dbPath}`, '--name=prod-db', `--config=${cfgPath}`]));
    await capture(() => cmdInjectDb([`--db=${dbPath}`, '--name=staging-db', `--config=${cfgPath}`]));

    const cfg = await readConfig();
    expect(Object.keys(cfg.mcpServers).sort()).toEqual(['prod-db', 'staging-db']);
  });

  it('preserves unrelated servers already in the config', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({
      mcpServers: { 'someone-elses-server': { command: 'node', args: ['x.js'] } },
    }));

    await capture(() => cmdInjectDb([`--db=${dbPath}`, `--config=${cfgPath}`]));

    const cfg = await readConfig();
    expect(cfg.mcpServers['someone-elses-server']).toMatchObject({ command: 'node' });
    expect(cfg.mcpServers['agentsgate-database']).toBeDefined();
  });
});

describe('cmdInjectDb — remove', () => {
  it('removes a previously registered server', async () => {
    await capture(() => cmdInjectDb([`--db=${dbPath}`, '--name=to-remove', `--config=${cfgPath}`]));
    expect(Object.keys((await readConfig()).mcpServers)).toContain('to-remove');

    const r = await capture(() => cmdInjectDb(['remove', '--name=to-remove', `--config=${cfgPath}`]));
    expect(r.stdout).toContain('Removed');
    expect(Object.keys((await readConfig()).mcpServers)).not.toContain('to-remove');
  });

  it('says so plainly when the server was not registered', async () => {
    const r = await capture(() => cmdInjectDb(['remove', '--name=never-added', `--config=${cfgPath}`]));
    expect(r.exitCode).toBeUndefined();
    expect(r.stdout).toContain('was not found');
  });

  it('leaves other servers untouched', async () => {
    await capture(() => cmdInjectDb([`--db=${dbPath}`, '--name=keep-me', `--config=${cfgPath}`]));
    await capture(() => cmdInjectDb([`--db=${dbPath}`, '--name=drop-me', `--config=${cfgPath}`]));

    await capture(() => cmdInjectDb(['remove', '--name=drop-me', `--config=${cfgPath}`]));

    expect(Object.keys((await readConfig()).mcpServers)).toEqual(['keep-me']);
  });
});

describe('cmdInject — status', () => {
  it('reports on a config with nothing injected', async () => {
    const r = await capture(() => cmdInject(['inject', 'status', `--config=${cfgPath}`]));
    expect(r.stdout.length + r.stderr.length).toBeGreaterThan(0);
  });
});
