/**
 * A policy file that does not parse must not disarm the policy.
 *
 * `loadPolicy` treated every failure the same — missing file and syntax error
 * both returned `{ rules: [] }`. With `--policy` set the file is watched, so
 * saving a half-typed edit swapped the live policy for an empty one: every rule
 * stopped applying, silently, until the file parsed again. That is the opposite
 * of what a guard should do when it is confused.
 *
 * Missing file still means "no policy" — that is a legitimate state. Malformed
 * means "something is wrong", and the previous policy stays in force.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadPolicy, watchPolicy } from '../src/policy.js';
import type { AgentsGatePolicy, FSWatcher } from '../src/policy.js';

let dir: string;
const watchers: FSWatcher[] = [];

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-reload-'));
});

afterEach(async () => {
  for (const w of watchers.splice(0)) w.close();
  await fs.rm(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const GUARD: AgentsGatePolicy = {
  rules: [{ id: 'GUARD', match: { tool: 'filesystem' }, action: 'block' }],
};

describe('loadPolicy on a malformed file', () => {
  it('says so, rather than returning an empty policy in silence', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(dir, 'policy.json');
    await fs.writeFile(file, '{ "rules": [ ');

    const policy = await loadPolicy(file);

    expect(policy).toEqual({ rules: [] });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain(file);
  });

  it('stays silent when the file simply does not exist', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const policy = await loadPolicy(path.join(dir, 'absent.json'));
    expect(policy).toEqual({ rules: [] });
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('watchPolicy', () => {
  it('keeps the previous policy when the new content does not parse', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(dir, 'policy.json');
    await fs.writeFile(file, JSON.stringify(GUARD));

    let active = await loadPolicy(file);
    watchers.push(watchPolicy(file, p => { active = p; }));

    await fs.writeFile(file, '{ "rules": [ { "id": "GUARD",');   // mid-edit save
    await new Promise(r => setTimeout(r, 600));

    expect(active.rules).toHaveLength(1);
    expect(active.rules[0]?.id).toBe('GUARD');
  });

  it('applies the change once the file parses again', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const file = path.join(dir, 'policy.json');
    await fs.writeFile(file, JSON.stringify(GUARD));

    let active = await loadPolicy(file);
    watchers.push(watchPolicy(file, p => { active = p; }));

    await fs.writeFile(file, '{ "rules": [ broken');
    await new Promise(r => setTimeout(r, 600));
    expect(active.rules).toHaveLength(1);

    await fs.writeFile(file, JSON.stringify({
      rules: [
        { id: 'GUARD', match: { tool: 'filesystem' }, action: 'block' },
        { id: 'SECOND', match: { tool: 'shell' }, action: 'block' },
      ],
    }));
    await new Promise(r => setTimeout(r, 600));
    expect(active.rules).toHaveLength(2);
  });
});
