/**
 * T438 — Unit tests for the new OTLP config fields
 *
 * Tests that loadConfig correctly parses otlpEndpoint and otlpExportIntervalMs
 * in the telemetry block.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';

const tmpFiles: string[] = [];

async function writeTmpConfig(data: unknown): Promise<string> {
  const file = path.join(os.tmpdir(), `as-cfg-otlp-${Date.now()}-${Math.random()}.json`);
  await fs.writeFile(file, JSON.stringify(data));
  tmpFiles.push(file);
  return file;
}

afterEach(async () => {
  for (const f of tmpFiles.splice(0)) {
    await fs.unlink(f).catch(() => {/* ignore */});
  }
});

// ── tests ──────────────────────────────────────────────────────────────────────

describe('T438 — config OTLP fields', () => {
  it('1. loadConfig accepts otlpEndpoint in the telemetry block', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 60_000,
        otlpEndpoint: 'http://collector:4318/v1/metrics',
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpEndpoint).toBe('http://collector:4318/v1/metrics');
  });

  it('2. loadConfig accepts otlpExportIntervalMs in the telemetry block', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 60_000,
        otlpExportIntervalMs: 120_000,
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpExportIntervalMs).toBe(120_000);
  });

  it('3. both otlpEndpoint and otlpExportIntervalMs can be set together', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 60_000,
        otlpEndpoint: 'http://otel-collector:4318',
        otlpExportIntervalMs: 300_000,
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpEndpoint).toBe('http://otel-collector:4318');
    expect(config.telemetry?.otlpExportIntervalMs).toBe(300_000);
  });

  it('4. otlpEndpoint is undefined when not present in config', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 60_000,
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpEndpoint).toBeUndefined();
  });

  it('5. otlpExportIntervalMs is undefined when not present in config', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 60_000,
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpExportIntervalMs).toBeUndefined();
  });

  it('6. missing otlpEndpoint is not defaulted to null (must be undefined)', async () => {
    const file = await writeTmpConfig({
      telemetry: { exportEndpoint: 'http://x.com', exportIntervalMs: 60_000 },
    });
    const config = await loadConfig(file);
    // Must be undefined, not null
    expect(config.telemetry?.otlpEndpoint).not.toBe(null);
    expect(config.telemetry?.otlpEndpoint).toBeUndefined();
  });

  it('7. missing otlpExportIntervalMs is not defaulted to null (must be undefined)', async () => {
    const file = await writeTmpConfig({
      telemetry: { exportEndpoint: 'http://x.com', exportIntervalMs: 60_000 },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.otlpExportIntervalMs).not.toBe(null);
    expect(config.telemetry?.otlpExportIntervalMs).toBeUndefined();
  });

  it('8. other telemetry fields remain intact alongside new OTLP fields', async () => {
    const file = await writeTmpConfig({
      telemetry: {
        exportEndpoint: 'http://example.com/stats',
        exportIntervalMs: 90_000,
        anomalyWebhookUrl: 'http://alerts.example.com',
        anomalyZScoreThreshold: 2.5,
        otlpEndpoint: 'http://otel:4318',
        otlpExportIntervalMs: 180_000,
      },
    });
    const config = await loadConfig(file);
    expect(config.telemetry?.exportEndpoint).toBe('http://example.com/stats');
    expect(config.telemetry?.exportIntervalMs).toBe(90_000);
    expect(config.telemetry?.anomalyWebhookUrl).toBe('http://alerts.example.com');
    expect(config.telemetry?.anomalyZScoreThreshold).toBe(2.5);
    expect(config.telemetry?.otlpEndpoint).toBe('http://otel:4318');
    expect(config.telemetry?.otlpExportIntervalMs).toBe(180_000);
  });

  it('9. telemetry section is undefined when not present in config file', async () => {
    const file = await writeTmpConfig({
      proxy: { port: 4001 },
    });
    const config = await loadConfig(file);
    expect(config.telemetry).toBeUndefined();
  });

  it('10. loadConfig with nonexistent file still has undefined otlp fields', async () => {
    const config = await loadConfig('/nonexistent/path/config.json');
    expect(config.telemetry).toBeUndefined();
  });
});
