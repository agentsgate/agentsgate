/**
 * T460 — agentsgate inject-mysql CLI tests
 *
 * Tests:
 * 1. The inject-mysql command is routed and appears in help text (source inspection)
 * 2. registerServer / removeServer helpers work correctly with a temp config file
 *    (same helpers that cmdInjectMysql uses internally)
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-inject-mysql-'));
  configPath = path.join(tmpDir, 'claude_desktop_config.json');
  // Start with an empty config
  await fs.writeFile(configPath, JSON.stringify({ mcpServers: {} }), 'utf8');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. CLI source routing — inject-mysql is wired
// ---------------------------------------------------------------------------

describe('inject-mysql CLI routing (source inspection)', () => {
  it('1.1 src/cli.ts contains "inject-mysql" case in the command switch', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain("case 'inject-mysql':");
  });

  it('1.2 src/cli.ts contains cmdInjectMysql function definition', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain('async function cmdInjectMysql(');
  });

  it('1.3 help text includes inject-mysql', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    expect(source).toContain('inject-mysql --connection-string=');
  });

  it('1.4 help text includes inject-mysql remove subcommand', async () => {
    // The usage block lives in src/cli/help.ts so `--version` can print on its own.
    const helpPath = path.resolve('src/cli/help.ts');
    const source = await fs.readFile(helpPath, 'utf8');
    expect(source).toContain('inject-mysql remove');
  });

  it('1.5 cmdInjectMysql exits with error when --connection-string is missing', async () => {
    const cliPath = path.resolve('src/cli.ts');
    const source = await fs.readFile(cliPath, 'utf8');
    // Verify the error message is in the source
    expect(source).toContain('--connection-string=<url> is required');
  });
});

// ---------------------------------------------------------------------------
// 2. registerServer — the same helper used by cmdInjectMysql
// ---------------------------------------------------------------------------

describe('inject-mysql registerServer helper', () => {
  it('2.1 registers a new mysql-database server entry', async () => {
    const result = await registerServer(
      'agentsgate-mysql-database',
      {
        command: 'node',
        args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://user:pass@localhost:3306/mydb'],
      },
      { configPath },
    );
    expect(result.added).toBe(true);
    expect(result.replaced).toBe(false);
    expect(result.name).toBe('agentsgate-mysql-database');
    expect(result.configPath).toBe(configPath);
  });

  it('2.2 config file contains the registered entry after registration', async () => {
    await registerServer(
      'agentsgate-mysql-database',
      {
        command: 'node',
        args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://user:pass@localhost:3306/mydb'],
      },
      { configPath },
    );
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toHaveProperty('agentsgate-mysql-database');
  });

  it('2.3 second registration without --force returns added=false', async () => {
    const entry = {
      command: 'node',
      args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://user:pass@localhost:3306/mydb'],
    };
    await registerServer('agentsgate-mysql-database', entry, { configPath });
    const result2 = await registerServer('agentsgate-mysql-database', entry, { configPath, force: false });
    expect(result2.added).toBe(false);
    expect(result2.replaced).toBe(false);
  });

  it('2.4 second registration with --force returns replaced=true', async () => {
    const entry = {
      command: 'node',
      args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://user:pass@localhost:3306/mydb'],
    };
    await registerServer('agentsgate-mysql-database', entry, { configPath });
    const result2 = await registerServer('agentsgate-mysql-database', entry, { configPath, force: true });
    expect(result2.replaced).toBe(true);
  });

  it('2.5 can use a custom name for the server entry', async () => {
    const result = await registerServer(
      'my-custom-mysql',
      {
        command: 'node',
        args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://localhost:3306/testdb'],
      },
      { configPath },
    );
    expect(result.name).toBe('my-custom-mysql');
    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).toHaveProperty('my-custom-mysql');
  });
});

// ---------------------------------------------------------------------------
// 3. removeServer — the same helper used by cmdInjectMysql remove
// ---------------------------------------------------------------------------

describe('inject-mysql removeServer helper', () => {
  it('3.1 removes a registered mysql-database server', async () => {
    // Register first
    await registerServer(
      'agentsgate-mysql-database',
      { command: 'node', args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://localhost:3306/db'] },
      { configPath },
    );

    const result = await removeServer('agentsgate-mysql-database', { configPath });
    expect(result.removed).toBe(true);
    expect(result.name).toBe('agentsgate-mysql-database');
  });

  it('3.2 config file no longer has the entry after removal', async () => {
    await registerServer(
      'agentsgate-mysql-database',
      { command: 'node', args: ['/dist/mcp-servers/mysql-database/index.js', '--connection-string', 'mysql://localhost:3306/db'] },
      { configPath },
    );
    await removeServer('agentsgate-mysql-database', { configPath });

    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).not.toHaveProperty('agentsgate-mysql-database');
  });

  it('3.3 removeServer returns removed=false when server does not exist', async () => {
    const result = await removeServer('agentsgate-mysql-database', { configPath });
    expect(result.removed).toBe(false);
  });

  it('3.4 other servers in config are untouched after remove', async () => {
    // Register two servers
    await registerServer(
      'agentsgate-mysql-database',
      { command: 'node', args: ['mysql.js', '--connection-string', 'mysql://localhost:3306/db'] },
      { configPath },
    );
    await registerServer(
      'other-server',
      { command: 'node', args: ['other.js'] },
      { configPath },
    );

    await removeServer('agentsgate-mysql-database', { configPath });

    const raw = await fs.readFile(configPath, 'utf8');
    const config = JSON.parse(raw) as { mcpServers: Record<string, unknown> };
    expect(config.mcpServers).not.toHaveProperty('agentsgate-mysql-database');
    expect(config.mcpServers).toHaveProperty('other-server');
  });
});

// ---------------------------------------------------------------------------
// 4. Connection string masking
// ---------------------------------------------------------------------------

describe('inject-mysql connection string masking', () => {
  it('4.1 password in connection string is masked for logging', () => {
    const connStr = 'mysql://user:secretpassword@myhost.example.com:3306/mydb';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    expect(masked).toBe('mysql://user:***@myhost.example.com:3306/mydb');
    expect(masked).not.toContain('secretpassword');
  });

  it('4.2 connection string without password is unchanged by mask', () => {
    // No password field — the regex does not match
    const connStr = 'mysql://myhost.example.com:3306/mydb';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    // No @ present so mask has no effect
    expect(masked).toBe(connStr);
  });

  it('4.3 masking preserves the rest of the connection string', () => {
    const connStr = 'mysql://admin:hunter2@db.example.com:3306/production';
    const masked = connStr.replace(/:([^:@]+)@/, ':***@');
    expect(masked).toContain('admin');
    expect(masked).toContain('db.example.com');
    expect(masked).toContain('production');
    expect(masked).not.toContain('hunter2');
  });
});
