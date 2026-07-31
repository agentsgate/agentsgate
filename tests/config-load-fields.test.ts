/**
 * `loadConfig` must return what the file says.
 *
 * It rebuilt the config from a hand-written list of keys, so any section added
 * afterwards was read off disk and dropped on the floor — silently, with the
 * default taking its place. `protection.level` never reached the proxy, so
 * `agentsgate level strict` wrote the file and changed nothing.
 * `approvals.waitTimeoutMs` and `approvals.grantTtlMs` went the same way.
 *
 * This is the same defect this release fixed in `loadPolicy`, which dropped
 * `mutedRules` and `ruleOverrides`. Listing keys by name is the bug; a test
 * that only checks the keys someone remembered will not catch the next one, so
 * this one walks the file instead.
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../src/config.js';

let dir: string;
let file: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ag-config-'));
  file = path.join(dir, 'config.json');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const write = async (config: unknown): Promise<void> => {
  await fs.writeFile(file, JSON.stringify(config, null, 2));
};

describe('protection', () => {
  it('reaches the caller', async () => {
    await write({ protection: { level: 'strict' } });
    expect((await loadConfig(file)).protection?.level).toBe('strict');
  });

  it('falls back to the default when the file says nothing', async () => {
    await write({});
    expect((await loadConfig(file)).protection?.level).toBe('balanced');
  });
});

describe('approvals', () => {
  it('keeps every field, not just the one that existed first', async () => {
    await write({ approvals: { maxAgeMs: 1000, waitTimeoutMs: 5000, grantTtlMs: 7000 } });
    const { approvals } = await loadConfig(file);
    expect(approvals?.maxAgeMs).toBe(1000);
    expect(approvals?.waitTimeoutMs).toBe(5000);
    expect(approvals?.grantTtlMs).toBe(7000);
  });

  it('keeps the holdHttpRequests switch', async () => {
    await write({ approvals: { holdHttpRequests: true } });
    expect((await loadConfig(file)).approvals?.holdHttpRequests).toBe(true);
  });

  it('still defaults maxAgeMs when the section is absent', async () => {
    await write({});
    expect((await loadConfig(file)).approvals?.maxAgeMs).toBe(86_400_000);
  });
});

describe('every section in the file', () => {
  it('survives the round trip', async () => {
    // Deliberately exhaustive: the failure mode is a section nobody thought to
    // add to the merge, so assert on the whole document rather than a list.
    const written = {
      proxy: { port: 4100, host: '127.0.0.1', checkpointThreshold: 0.4 },
      intervention: { allowBelow: 0.2, blockAtOrAbove: 0.8 },
      webhook: { url: 'https://example.com/hook', secret: 's' },
      approvals: { maxAgeMs: 1, waitTimeoutMs: 2, grantTtlMs: 3, holdHttpRequests: true },
      telemetry: { exportEndpoint: 'https://example.com/t', exportIntervalMs: 1000 },
      intelligence: { communityEndpoint: 'https://example.com/c' },
      rateLimit: { enabled: true, maxOpsPerMinute: 5 },
      logs: { retentionDays: 7 },
      dashboard: { apiKey: 'k', roles: { k: 'admin' }, allowedHosts: ['example.com'] },
      audit: { signingSecret: 'a' },
      protection: { level: 'minimal' },
      team: 'blue',
    };
    await write(written);
    const loaded = await loadConfig(file) as unknown as Record<string, unknown>;

    for (const [section, value] of Object.entries(written)) {
      expect(loaded[section], section).toEqual(value);
    }
  });
});

describe('with no file at all', () => {
  it('returns usable defaults rather than failing', async () => {
    const config = await loadConfig(path.join(dir, 'absent.json'));
    expect(config.proxy.port).toBe(4000);
    expect(config.intervention.blockAtOrAbove).toBe(0.7);
    expect(config.protection?.level).toBe('balanced');
  });
});
