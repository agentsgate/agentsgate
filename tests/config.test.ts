import { describe, it, expect } from 'vitest';
import { loadConfig, DEFAULT_CONFIG } from '../src/config.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

describe('loadConfig', () => {
  it('returns defaults when no config file exists', async () => {
    const config = await loadConfig('/nonexistent/config.json');
    expect(config.proxy.port).toBe(DEFAULT_CONFIG.proxy.port);
    expect(config.intervention.allowBelow).toBe(DEFAULT_CONFIG.intervention.allowBelow);
    expect(config.approvals?.maxAgeMs).toBe(DEFAULT_CONFIG.approvals?.maxAgeMs);
    expect(config.webhook).toBeUndefined();
  });

  it('merges a partial config file over defaults', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-cfg-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({
      proxy: { port: 8080 },
      webhook: { url: 'https://example.com/hook' },
    }));

    const config = await loadConfig(tmpFile);
    expect(config.proxy.port).toBe(8080);
    // checkpointThreshold should still have the default
    expect(config.proxy.checkpointThreshold).toBe(DEFAULT_CONFIG.proxy.checkpointThreshold);
    expect(config.webhook?.url).toBe('https://example.com/hook');
    expect(config.intelligence).toBeUndefined();
    expect(config.approvals?.maxAgeMs).toBe(DEFAULT_CONFIG.approvals?.maxAgeMs);

    await fs.unlink(tmpFile);
  });

  it('respects custom intervention thresholds', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-cfg-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({
      intervention: { allowBelow: 0.2, blockAtOrAbove: 0.8 },
    }));

    const config = await loadConfig(tmpFile);
    expect(config.intervention.allowBelow).toBe(0.2);
    expect(config.intervention.blockAtOrAbove).toBe(0.8);

    await fs.unlink(tmpFile);
  });

  it('returns rate limit config when present', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-cfg-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({
      rateLimit: { enabled: true, maxOpsPerMinute: 30 },
    }));

    const config = await loadConfig(tmpFile);
    expect(config.rateLimit?.enabled).toBe(true);
    expect(config.rateLimit?.maxOpsPerMinute).toBe(30);

    await fs.unlink(tmpFile);
  });

  it('returns approvals config when present', async () => {
    const tmpFile = path.join(os.tmpdir(), `as-cfg-${Date.now()}.json`);
    await fs.writeFile(tmpFile, JSON.stringify({
      approvals: { maxAgeMs: 60_000 },
    }));

    const config = await loadConfig(tmpFile);
    expect(config.approvals?.maxAgeMs).toBe(60_000);

    await fs.unlink(tmpFile);
  });
});
