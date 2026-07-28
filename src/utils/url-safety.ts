/**
 * URL safety helpers shared by the dashboard, approval webhook sender, and
 * telemetry exporter.
 *
 * Two concerns:
 *  1. Redacting credentials embedded in URLs before they are returned/logged.
 *  2. SSRF defense for outbound requests to operator/agent-influenced URLs —
 *     protocol allow-list plus a DNS-resolving private/loopback/metadata-IP
 *     denylist (a hostname regex alone is bypassable via a public domain whose
 *     A record points at an internal address).
 */

import dns from 'node:dns/promises';
import net from 'node:net';

/** Mask any `user:pass@` credentials in a URL for safe display/logging. */
export function redactUrlCredentials(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = u.username ? '***' : '';
      u.password = u.password ? '***' : '';
    }
    return u.toString();
  } catch {
    // Not a parseable URL — mask any credential-looking segment wholesale.
    return url.replace(/\/\/[^@/]+@/, '//***@');
  }
}

/** True if an IPv4/IPv6 address is loopback, private, link-local, CGNAT, or a cloud metadata IP. */
export function isPrivateOrReservedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true; // malformed → treat as unsafe
    const [a, b] = p as [number, number, number, number];
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 10.0.0.0/8
    if (a === 127) return true;                     // loopback
    if (a === 169 && b === 254) return true;        // link-local + 169.254.169.254 metadata
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true;        // 192.168.0.0/16
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    if (a >= 224) return true;                      // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return true;        // loopback / unspecified
    if (lower.startsWith('fe80')) return true;                 // link-local
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true; // unique local fc00::/7
    // IPv4-mapped (::ffff:127.0.0.1) — recurse on the embedded v4.
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateOrReservedIp(mapped[1]!);
    return false;
  }
  return true; // not an IP literal → caller resolves DNS first
}

/**
 * True for link-local / cloud-metadata addresses — the SSRF-to-credentials
 * vector (e.g. 169.254.169.254 on AWS/GCP/Azure) — plus unspecified/multicast.
 * Narrower than {@link isPrivateOrReservedIp}: it deliberately does NOT flag
 * loopback or RFC1918 private ranges, which is where legitimate internal
 * services (OTLP collectors, metrics sinks) commonly live.
 */
export function isLinkLocalOrMetadataIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p.length !== 4 || p.some(n => Number.isNaN(n))) return true;
    const [a, b] = p as [number, number, number, number];
    if (a === 169 && b === 254) return true; // link-local + cloud metadata
    if (a === 0) return true;                // unspecified
    if (a >= 224) return true;               // multicast/reserved
    return false;
  }
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' ) return true;                 // unspecified
    if (lower.startsWith('fe80')) return true;        // link-local
    if (lower.startsWith('ff')) return true;          // multicast
    if (lower === 'fd00:ec2::254') return true;       // AWS IMDS over IPv6
    const mapped = lower.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isLinkLocalOrMetadataIp(mapped[1]!);
    return false;
  }
  return true;
}

export interface SafeWebhookOptions {
  /** Bypass the IP denylist entirely (tests / explicit opt-in only). */
  allowPrivate?: boolean;
  /**
   * Denylist strictness:
   *  - 'all-private' (default): reject loopback + RFC1918 + link-local + metadata.
   *    Use for outbound webhooks to external receivers.
   *  - 'metadata-only': reject only link-local/metadata/multicast, allow
   *    loopback + private. Use for internal sinks (OTLP collectors) that
   *    legitimately live on private/loopback addresses.
   */
  mode?: 'all-private' | 'metadata-only';
}

/**
 * Validate an outbound webhook/exporter URL against SSRF: enforce http(s), then
 * resolve DNS and reject if any resolved address is private/loopback/metadata.
 * Throws on rejection; returns the resolved IPs on success.
 */
export async function assertSafeOutboundUrl(url: string, opts: SafeWebhookOptions = {}): Promise<string[]> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${redactUrlCredentials(url)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Webhook URL must use http(s): ${parsed.protocol}`);
  }
  if (opts.allowPrivate) return [];

  const isBlocked = opts.mode === 'metadata-only' ? isLinkLocalOrMetadataIp : isPrivateOrReservedIp;
  const rejection = opts.mode === 'metadata-only'
    ? 'Webhook URL resolves to a link-local/metadata address'
    : 'Webhook URL resolves to a private/loopback/metadata address';

  const host = parsed.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  // If the host is already an IP literal, check it directly.
  if (net.isIP(host)) {
    if (isBlocked(host)) throw new Error(rejection);
    return [host];
  }
  // Otherwise resolve DNS and check every returned address.
  const results = await dns.lookup(host, { all: true });
  if (results.length === 0) throw new Error(`Webhook host did not resolve: ${host}`);
  for (const { address } of results) {
    if (isBlocked(address)) throw new Error(rejection);
  }
  return results.map(r => r.address);
}
