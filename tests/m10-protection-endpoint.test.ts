/**
 * `GET`/`POST /protection` — the dashboard's level switch.
 *
 * Changing what gets stopped has to take effect on the running proxy, not on
 * the next restart: a control whose effect you have to restart to see is one
 * nobody will use. It also has to persist, because a level that silently
 * reverts is worse than one that cannot be changed at all.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DashboardAPI } from '../src/modules/m10-dashboard/index.js';
import { StateStore } from '../src/modules/m2-store/index.js';
import { getProtectionLevel } from '../src/protection-levels.js';
import type { ProtectionLevel, ProtectionLevelName } from '../src/protection-levels.js';

let dir: string;
let store: StateStore;
let dash: DashboardAPI;
let port: number;
let current: ProtectionLevel | undefined;
let saved: ProtectionLevelName[];

async function start(opts: Record<string, unknown> = {}): Promise<void> {
  dash = new DashboardAPI(store, {
    getProtectionLevel: () => current,
    setProtectionLevel: (name) => { current = getProtectionLevel(name); saved.push(name); },
    ...opts,
  });
  await dash.start(0);
  port = dash.getPort();
}

const get = async (p: string): Promise<{ status: number; body: any }> => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`);
  return { status: r.status, body: await r.json().catch(() => null) };
};

const post = async (p: string, body: unknown, headers: Record<string, string> = {}) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-prot-'));
  store = new StateStore(path.join(dir, 'p.db'));
  await store.initialize();
  current = getProtectionLevel('balanced');
  saved = [];
});

afterEach(async () => {
  await dash?.stop();
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describe('GET /protection', () => {
  it('reports the level in force, with its whole table', async () => {
    await start();
    const { status, body } = await get('/protection');
    expect(status).toBe(200);
    expect(body.level).toBe('balanced');
    expect(body.summary).toBeTruthy();
    expect(body.categories.destructive).toBe('block');
    expect(body.categories.write_update).toBe('allow');
    expect(body.available).toEqual(['minimal', 'balanced', 'strict']);
    expect(body.editable).toBe(true);
  });

  it('says so when no level is configured', async () => {
    current = undefined;
    await start();
    expect((await get('/protection')).body.level).toBeNull();
  });

  it('marks itself read-only when there is no way to set it', async () => {
    await start({ setProtectionLevel: undefined });
    expect((await get('/protection')).body.editable).toBe(false);
  });

  it('is unavailable when the server was not given a level at all', async () => {
    await start({ getProtectionLevel: undefined });
    expect((await get('/protection')).status).toBe(503);
  });
});

describe('POST /protection', () => {
  it('changes what is in force straight away', async () => {
    await start();
    const { status, body } = await post('/protection', { level: 'strict' });
    expect(status).toBe(200);
    expect(body.level).toBe('strict');
    expect(current?.name).toBe('strict');            // the running proxy sees it
    expect((await get('/protection')).body.level).toBe('strict');
  });

  it('persists the choice', async () => {
    await start();
    await post('/protection', { level: 'minimal' });
    expect(saved).toEqual(['minimal']);
  });

  it('refuses a level that does not exist, and lists the ones that do', async () => {
    await start();
    const { status, body } = await post('/protection', { level: 'paranoid' });
    expect(status).toBe(400);
    expect(body.available).toEqual(['minimal', 'balanced', 'strict']);
    expect(current?.name).toBe('balanced');          // unchanged
  });

  it('refuses a body that is not what it should be', async () => {
    await start();
    expect((await post('/protection', { level: 42 })).status).toBe(400);
    expect((await post('/protection', {})).status).toBe(400);
    expect(current?.name).toBe('balanced');
  });

  it('refuses when there is no setter', async () => {
    await start({ setProtectionLevel: undefined });
    expect((await post('/protection', { level: 'strict' })).status).toBe(503);
  });
});

describe('who may change it', () => {
  it('needs the admin role, not merely a valid key', async () => {
    await start({ apiKey: 'admin-key', roles: { 'viewer-key': 'viewer', 'approver-key': 'approver' } });

    for (const key of ['viewer-key', 'approver-key']) {
      const r = await fetch(`http://127.0.0.1:${port}/protection`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
        body: JSON.stringify({ level: 'minimal' }),
      });
      expect(r.status, key).toBe(403);
    }
    expect(current?.name).toBe('balanced');

    const ok = await fetch(`http://127.0.0.1:${port}/protection`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': 'admin-key' },
      body: JSON.stringify({ level: 'minimal' }),
    });
    expect(ok.status).toBe(200);
    expect(current?.name).toBe('minimal');
  });

  it('is not readable without a key when one is set', async () => {
    await start({ apiKey: 'admin-key' });
    expect((await get('/protection')).status).toBe(401);
  });
});
