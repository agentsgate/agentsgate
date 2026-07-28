import http from 'node:http';

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Security headers added to every response. */
const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'X-XSS-Protection': '0',
};

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...SECURITY_HEADERS,
  });
  res.end(payload);
}

export function html(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    // Restrict inline resources to self only; allow inline scripts/styles used by
    // the bundled dashboard HTML (no external fetches, no framing).
    'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
    ...SECURITY_HEADERS,
  });
  res.end(body);
}

export function prometheusText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8' });
  res.end(body);
}

export function clampInt(value: string | null, defaultVal: number, min = 0, max = Infinity): number {
  const n = value === null ? defaultVal : parseInt(value, 10);
  return isNaN(n) ? defaultVal : Math.min(max, Math.max(min, n));
}

