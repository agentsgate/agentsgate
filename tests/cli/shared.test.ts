/**
 * src/cli/shared.ts — argument parsing, state file, dashboard fetch.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { redirectHome, writeState, clearState, capture } from './helpers.js';

// Must precede the CLI import — STATE_DIR is resolved at module load.
const HOME = redirectHome();

const { parseFlag, hasFlag, resolveDbPath, readState, dashFetch, STATE_DIR, STATE_FILE, DB_FILE, SHADOW_DIR } =
  await import('../../src/cli/shared.js');

describe('parseFlag', () => {
  it('returns the value after --name=', () => {
    expect(parseFlag(['--limit=25'], 'limit')).toBe('25');
  });

  it('returns undefined when the flag is absent', () => {
    expect(parseFlag(['--other=1'], 'limit')).toBeUndefined();
  });

  it('returns undefined for a bare flag with no value', () => {
    expect(parseFlag(['--limit'], 'limit')).toBeUndefined();
  });

  it('returns an empty string for --name= with nothing after it', () => {
    expect(parseFlag(['--limit='], 'limit')).toBe('');
  });

  it('takes the first occurrence when repeated', () => {
    expect(parseFlag(['--limit=1', '--limit=2'], 'limit')).toBe('1');
  });

  it('does not match a flag that merely shares a prefix', () => {
    expect(parseFlag(['--limits=5'], 'limit')).toBeUndefined();
  });

  it('preserves values containing = and spaces', () => {
    expect(parseFlag(['--connection-string=postgresql://u:p@h/db?a=b'], 'connection-string'))
      .toBe('postgresql://u:p@h/db?a=b');
  });
});

describe('hasFlag', () => {
  it('matches the long form', () => {
    expect(hasFlag(['--dry-run'], 'dry-run')).toBe(true);
  });

  it('matches the single-letter short form', () => {
    expect(hasFlag(['-d'], 'dry-run')).toBe(true);
  });

  it('is false when absent', () => {
    expect(hasFlag(['--other'], 'dry-run')).toBe(false);
  });

  it('does not match --name=value form', () => {
    expect(hasFlag(['--dry-run=true'], 'dry-run')).toBe(false);
  });
});

describe('resolveDbPath', () => {
  it('returns the default database when no team is given', () => {
    expect(resolveDbPath(undefined)).toBe(DB_FILE);
  });

  it('namespaces the database per team', () => {
    expect(resolveDbPath('acme')).toBe(path.join(STATE_DIR, 'data-acme.db'));
  });

  it('accepts letters, digits, hyphen and underscore', () => {
    expect(resolveDbPath('Team_9-x')).toBe(path.join(STATE_DIR, 'data-Team_9-x.db'));
  });

  // The team name is interpolated into a filesystem path, so anything that
  // could climb out of STATE_DIR has to be refused rather than sanitised.
  for (const bad of ['../escape', 'a/b', 'a\\b', 'has space', 'dot.dot', '']) {
    it(`refuses ${JSON.stringify(bad)}`, async () => {
      const r = await capture(() => { resolveDbPath(bad); });
      if (bad === '') {
        expect(r.exitCode).toBeUndefined();      // empty is falsy → default DB
      } else {
        expect(r.exitCode).toBe(1);
        expect(r.stderr).toContain('Invalid --team name');
      }
    });
  }
});

describe('path constants', () => {
  it('are all rooted at the .agentsgate directory under HOME', () => {
    expect(STATE_DIR).toBe(path.join(HOME, '.agentsgate'));
    expect(STATE_FILE).toBe(path.join(STATE_DIR, 'state.json'));
    expect(DB_FILE).toBe(path.join(STATE_DIR, 'agentsgate.db'));
    expect(SHADOW_DIR).toBe(path.join(STATE_DIR, 'shadow-repo'));
  });
});

describe('readState', () => {
  it('returns null when the state file is absent', async () => {
    await clearState(HOME);
    expect(await readState()).toBeNull();
  });

  it('returns null rather than throwing on malformed JSON', async () => {
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(STATE_FILE, '{ not json');
    expect(await readState()).toBeNull();
  });

  it('parses a well-formed state file', async () => {
    await writeState(HOME, { pid: 4242, port: 4000, dashboardPort: 4001 });
    const state = await readState();
    expect(state).toMatchObject({ pid: 4242, port: 4000, dashboardPort: 4001 });
  });
});

describe('dashFetch', () => {
  let server: http.Server;
  let port: number;
  let seen: { method?: string; url?: string; body: string; contentType?: string };

  beforeAll(async () => {
    seen = { body: '' };
    server = http.createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += String(c); });
      req.on('end', () => {
        seen = {
          method: req.method,
          url: req.url,
          body,
          contentType: req.headers['content-type'],
        };
        if (req.url === '/boom') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"nope"}'); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, echo: body || null }));
      });
    });
    port = await new Promise(r => server.listen(0, '127.0.0.1', () => r((server.address() as { port: number }).port)));
  });

  afterAll(async () => { await new Promise(r => server.close(() => r(null))); });

  it('performs a GET and returns status and parsed body', async () => {
    const { status, body } = await dashFetch(port, 'GET', '/operations?limit=5');
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true });
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/operations?limit=5');
  });

  it('sends no body or content-type when none is supplied', async () => {
    await dashFetch(port, 'GET', '/x');
    expect(seen.body).toBe('');
    expect(seen.contentType).toBeUndefined();
  });

  it('serialises a JSON body and sets the content type', async () => {
    await dashFetch(port, 'POST', '/rules', { id: 'R1', score: 0.9 });
    expect(seen.method).toBe('POST');
    expect(seen.contentType).toBe('application/json');
    expect(JSON.parse(seen.body)).toEqual({ id: 'R1', score: 0.9 });
  });

  it('reports a non-2xx status instead of throwing', async () => {
    const { status, body } = await dashFetch(port, 'GET', '/boom');
    expect(status).toBe(500);
    expect(body).toMatchObject({ error: 'nope' });
  });

  it('rejects when the port is not listening', async () => {
    await expect(dashFetch(1, 'GET', '/x')).rejects.toThrow();
  });
});
