/**
 * Tests for the shared URL-safety helpers (credential redaction + SSRF guard)
 * added in the 2026-07 security review.
 */

import { describe, it, expect } from 'vitest';
import {
  redactUrlCredentials,
  isPrivateOrReservedIp,
  assertSafeOutboundUrl,
} from '../../src/utils/url-safety.js';

describe('redactUrlCredentials', () => {
  it('masks user:pass in a URL', () => {
    const out = redactUrlCredentials('https://user:secret@example.com/hook');
    expect(out).not.toContain('secret');
    expect(out).toContain('example.com');
  });

  it('leaves credential-less URLs intact', () => {
    expect(redactUrlCredentials('https://example.com/hook')).toBe('https://example.com/hook');
  });
});

describe('isPrivateOrReservedIp', () => {
  it('flags loopback / private / link-local / metadata ranges', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('flags IPv6 loopback, ULA, link-local, and v4-mapped', () => {
    for (const ip of ['::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
      expect(isPrivateOrReservedIp(ip)).toBe(true);
    }
  });

  it('allows public addresses', () => {
    expect(isPrivateOrReservedIp('8.8.8.8')).toBe(false);
    expect(isPrivateOrReservedIp('1.1.1.1')).toBe(false);
  });
});

describe('assertSafeOutboundUrl', () => {
  it('rejects non-http(s) protocols', async () => {
    await expect(assertSafeOutboundUrl('file:///etc/passwd')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('gopher://x')).rejects.toThrow();
  });

  it('rejects URLs whose literal host is a private/metadata IP', async () => {
    await expect(assertSafeOutboundUrl('http://169.254.169.254/latest/meta-data')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('http://127.0.0.1:8080/x')).rejects.toThrow();
    await expect(assertSafeOutboundUrl('http://[::1]/x')).rejects.toThrow();
  });

  it('honors allowPrivate for loopback (test/opt-in path)', async () => {
    await expect(assertSafeOutboundUrl('http://127.0.0.1:9999/x', { allowPrivate: true })).resolves.toBeDefined();
  });

  it('metadata-only mode allows loopback/private but still blocks metadata', async () => {
    // OTLP collectors live on loopback/private — allowed in metadata-only mode.
    await expect(assertSafeOutboundUrl('http://127.0.0.1:4318', { mode: 'metadata-only' })).resolves.toBeDefined();
    await expect(assertSafeOutboundUrl('http://10.0.0.5:4318', { mode: 'metadata-only' })).resolves.toBeDefined();
    // ...but the cloud metadata IP is still rejected.
    await expect(assertSafeOutboundUrl('http://169.254.169.254/', { mode: 'metadata-only' })).rejects.toThrow();
  });
});
