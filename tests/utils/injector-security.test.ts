/**
 * Security regression tests for the Claude Desktop config injector.
 *
 * Config files can hold secrets (DB connection strings passed to
 * inject-pg/inject-mysql), so writes must be owner-only (0o600) and atomic.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { registerServer, removeServer } from '../../src/utils/claude-desktop-injector.js';

let tmpDir: string;
let cfgPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-injector-sec-'));
  cfgPath = path.join(tmpDir, 'claude_desktop_config.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// chmod semantics differ on Windows; these assertions target POSIX.
const posix = process.platform !== 'win32';

describe('injector writes config files with 0o600 permissions', () => {
  it.runIf(posix)('registerServer creates the config owner-read/write only', async () => {
    await registerServer(
      'db',
      { command: 'agentsgate-pg', args: ['--connection-string', 'postgresql://u:secret@host/db'] },
      { configPath: cfgPath },
    );
    const mode = (await fs.stat(cfgPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it.runIf(posix)('tightens permissions even if the file pre-existed world-readable', async () => {
    await fs.writeFile(cfgPath, JSON.stringify({ mcpServers: {} }), { mode: 0o644 });
    await registerServer('x', { command: 'c' }, { configPath: cfgPath });
    const mode = (await fs.stat(cfgPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it('does not leave a temp file behind after a successful write', async () => {
    await registerServer('x', { command: 'c' }, { configPath: cfgPath });
    await removeServer('x', { configPath: cfgPath });
    const leftovers = (await fs.readdir(tmpDir)).filter(f => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('writes valid, parseable JSON (atomic rename produced a complete file)', async () => {
    await registerServer('db', { command: 'c', args: ['a'] }, { configPath: cfgPath });
    const parsed = JSON.parse(await fs.readFile(cfgPath, 'utf-8'));
    expect(parsed.mcpServers.db.command).toBe('c');
  });
});
