/**
 * `agentsgate level` — and the config write the dashboard shares with it.
 *
 * `saveConfigProtectionLevel` is the one that matters most: the dashboard calls
 * it so a level chosen there survives a restart. If it silently dropped the
 * rest of the config, changing the level would quietly wipe an API key.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { describe, it, expect, beforeEach } from 'vitest';
import { redirectHome, capture } from './helpers.js';

const home = redirectHome();
const { cmdLevel, saveConfigProtectionLevel } = await import('../../src/cli/level-cmd.js');

const configFile = path.join(home, '.agentsgate', 'config.json');

async function readConfig(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(configFile, 'utf-8')) as Record<string, unknown>;
}

beforeEach(async () => {
  await fs.rm(path.join(home, '.agentsgate'), { recursive: true, force: true });
});

describe('saveConfigProtectionLevel', () => {
  it('writes the level when there is no config file yet', async () => {
    await saveConfigProtectionLevel(undefined, 'strict');
    expect((await readConfig())['protection']).toEqual({ level: 'strict' });
  });

  it('leaves everything else in the file alone', async () => {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({
      proxy: { port: 4100 },
      dashboard: { apiKey: 'do-not-lose-me' },
    }));

    await saveConfigProtectionLevel(undefined, 'minimal');

    const cfg = await readConfig();
    expect(cfg['dashboard']).toEqual({ apiKey: 'do-not-lose-me' });
    expect(cfg['proxy']).toEqual({ port: 4100 });
    expect(cfg['protection']).toEqual({ level: 'minimal' });
  });

  it('keeps other keys inside protection', async () => {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, JSON.stringify({ protection: { level: 'minimal', note: 'keep' } }));
    await saveConfigProtectionLevel(undefined, 'strict');
    expect((await readConfig())['protection']).toEqual({ level: 'strict', note: 'keep' });
  });

  it('starts fresh rather than throwing when the file is corrupt', async () => {
    await fs.mkdir(path.dirname(configFile), { recursive: true });
    await fs.writeFile(configFile, '{ not json');
    await saveConfigProtectionLevel(undefined, 'balanced');
    expect((await readConfig())['protection']).toEqual({ level: 'balanced' });
  });

  it('honours an explicit path', async () => {
    const other = path.join(home, 'custom', 'cfg.json');
    await saveConfigProtectionLevel(other, 'strict');
    expect(JSON.parse(await fs.readFile(other, 'utf-8'))['protection']).toEqual({ level: 'strict' });
  });
});

describe('agentsgate level', () => {
  it('shows the level in force and what each category does', async () => {
    const { stdout } = await capture(() => cmdLevel([]));
    expect(stdout).toMatch(/Protection level: balanced/);
    for (const category of ['destructive', 'credential', 'exfiltration', 'write_delete', 'exec', 'read']) {
      expect(stdout, category).toContain(category);
    }
    expect(stdout).toMatch(/refused/);   // destructive
    expect(stdout).toMatch(/runs/);      // read
  });

  it('offers the levels it is not on', async () => {
    const { stdout } = await capture(() => cmdLevel([]));
    expect(stdout).toMatch(/Other levels: minimal, strict/);
  });

  it('says policy rules win, so nobody thinks the level is the last word', async () => {
    const { stdout } = await capture(() => cmdLevel([]));
    expect(stdout).toMatch(/Policy rules are applied after the level/);
  });

  it('changes the level and says what that means', async () => {
    const { stdout } = await capture(() => cmdLevel(['minimal']));
    expect(stdout).toMatch(/set to "minimal"/);
    expect(stdout).toMatch(/Only wholesale destruction/);
    expect((await readConfig())['protection']).toEqual({ level: 'minimal' });
  });

  it('then reports the new level, not the old one', async () => {
    await capture(() => cmdLevel(['strict']));
    const { stdout } = await capture(() => cmdLevel([]));
    expect(stdout).toMatch(/Protection level: strict/);
    expect(stdout).toMatch(/Other levels: minimal, balanced/);
  });

  it('accepts the name whatever case it is written in', async () => {
    await capture(() => cmdLevel(['STRICT']));
    expect((await readConfig())['protection']).toEqual({ level: 'strict' });
  });

  it('refuses an unknown level, lists the real ones, and changes nothing', async () => {
    const { stderr, exitCode } = await capture(() => cmdLevel(['paranoid']));
    expect(exitCode).toBe(1);
    expect(stderr).toMatch(/Unknown level "paranoid"/);
    expect(stderr).toMatch(/minimal, balanced, strict/);
    await expect(fs.access(configFile)).rejects.toThrow();
  });

  it('tells you a restart is needed for the CLI path', async () => {
    // The dashboard applies it live; setting it from the CLI does not reach a
    // proxy that is already running.
    const { stdout } = await capture(() => cmdLevel(['minimal']));
    expect(stdout).toMatch(/agentsgate stop && agentsgate start/);
  });
});
