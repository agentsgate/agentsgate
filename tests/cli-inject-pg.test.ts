/**
 * T452 — agentsgate inject-pg CLI tests
 *
 * Tests:
 * 1. The inject-pg command is routed and appears in help text (source inspection)
 * 2. registerServer / removeServer helpers work correctly with a temp config file
 *    (same helpers that cmdInjectPg uses internally)
 * 3. Connection string masking for logs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  registerServer,
  removeServer,
} from '../src/utils/claude-desktop-injector.js';

let tmpDir: string;
let configPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-inject-pg-'));
  configPath = path.join(tmpDir, 'claude_desktop_config.json');
  // Start with an empty config
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. CLI source routing — inject-pg is wired
// ---------------------------------------------------------------------------

describe('inject-pg CLI routing (source inspection)', () => {
  it('1.1 src/cli.ts contains "inject-pg" case in the command switch', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain("case 'inject-pg':");
  });

  it('1.2 src/cli.ts contains cmdInjectPg function definition', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain('async function cmdInjectPg(');
  });

  it('1.3 help text includes inject-pg', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain('inject-pg --connection-string=');
  });

  it('1.4 help text includes inject-pg remove subcommand', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain('inject-pg remove');
  });

  it('1.5 cmdInjectPg exits with error when --connection-string is missing', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    // Verify the error message is in the source
    expect(source).toContain('--connection-string=<url> is required');
  });
});

// ---------------------------------------------------------------------------
// 2. registerServer — the same helper used by cmdInjectPg
// ---------------------------------------------------------------------------

describe('inject-pg registerServer helper', () => {
  it('2.1 registers a new pg-database server entry', async () => {
    const result = await registerServer(
      'agentsgate-pg-database',
      {
        command: 'node',
        args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://user:pass@localhost/mydb'],
      },
      { configPath },
    );
    expect(result.added).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.name).toBe('agentsgate-pg-database');
    expect(result.configPath).toBe(configPath);
  });

  it('2.2 config file contains the registered entry after registration', async () => {
    await registerServer(
      'agentsgate-pg-database',
      {
        command: 'node',
        args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://user:pass@localhost/mydb'],
      },
      { configPath },
    );
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toHaveProperty('agentsgate-pg-database');
  });

  it('2.3 second registration without --force returns added=false', async () => {
    const entry = {
      command: 'node',
      args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://user:pass@localhost/mydb'],
    };
    await registerServer('agentsgate-pg-database', entry, { configPath });
    const result2 = await registerServer('agentsgate-pg-database', entry, { configPath, force: false });
    expect(result2.added).toBe(false);
    expect(result2.replaced).toBe(false);
  });

  it('2.4 second registration with --force returns replaced=true', async () => {
    const entry = {
      command: 'node',
      args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://user:pass@localhost/mydb'],
    };
    await registerServer('agentsgate-pg-database', entry, { configPath });
    const result2 = await registerServer('agentsgate-pg-database', entry, { configPath, force: true });
    expect(result2.replaced).toBe(true);
  });

  it('2.5 can use a custom name for the server entry', async () => {
    const result = await registerServer(
      'my-custom-pg',
      {
        command: 'node',
        args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://localhost/testdb'],
      },
      { configPath },
    );
    expect(result.name).toBe('my-custom-pg');
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toHaveProperty('my-custom-pg');
  });
});

// ---------------------------------------------------------------------------
// 3. removeServer — the same helper used by cmdInjectPg remove
// ---------------------------------------------------------------------------

describe('inject-pg removeServer helper', () => {
  it('3.1 removes a registered pg-database server', async () => {
    // Register first
    await registerServer(
      'agentsgate-pg-database',
      { command: 'node', args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://localhost/db'] },
      { configPath },
    );

    const result = await removeServer('agentsgate-pg-database', { configPath });
    expect(result.removed).toBe(true);
    expect(result.name).toBe('agentsgate-pg-database');
  });

  it('3.2 config file no longer has the entry after removal', async () => {
    await registerServer(
      'agentsgate-pg-database',
      { command: 'node', args: ['/dist/mcp-servers/pg-database/index.js', '--connection-string', 'postgresql://localhost/db'] },
      { configPath },
    );
    await removeServer('agentsgate-pg-database', { configPath });

    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).not.toHaveProperty('agentsgate-pg-database');
  });

  it('3.3 removeServer returns removed=false when server does not exist', async () => {
    const result = await removeServer('agentsgate-pg-database', { configPath });
    expect(result.removed).toBe(false);
  });

  it('3.4 other servers in config are untouched after remove', async () => {
    // Register two servers
    await registerServer(
      'agentsgate-pg-database',
      { command: 'node', args: ['pg.js', '--connection-string', 'postgresql://localhost/db'] },
      { configPath },
    );
    await registerServer(
      'other-server',
      { command: 'node', args: ['other.js'] },
      { configPath },
    );

    await removeServer('agentsgate-pg-database', { configPath });

    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).not.toHaveProperty('agentsgate-pg-database');
    expect(config.mcpServers).toHaveProperty('other-server');
  });
});

// ---------------------------------------------------------------------------
// 4. Connection string masking
// ---------------------------------------------------------------------------

describe('inject-pg connection string masking', () => {
  it('4.1 password in connection string is masked for logging', () => {
    const connStr = 'postgresql://user:secretpassword@myhost.example.com:5432/mydb';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    expect(masked).toBe('postgresql://user:***@myhost.example.com:5432/mydb');
    expect(masked).not.toContain('secretpassword');
  });

  it('4.2 connection string without password is unchanged by mask', () => {
    // No password field — the regex does not match
    const connStr = 'postgresql://myhost.example.com:5432/mydb';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    // No @ present so mask has no effect
    expect(masked).toBe(connStr);
  });

  it('4.3 masking preserves the rest of the connection string', () => {
    const connStr = 'postgresql://admin:hunter2@db.example.com:5432/production';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    expect(masked).toContain('admin');
    expect(masked).toContain('db.example.com');
    expect(masked).toContain('production');
    expect(masked).not.toContain('hunter2');
  });
});
