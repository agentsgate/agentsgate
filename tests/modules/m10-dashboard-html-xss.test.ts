/**
 * XSS containment for the browser-side dashboard.
 *
 * Everything the dashboard renders about an operation — agent id, tool, method,
 * params, error text — is supplied by the agent under observation. That is the
 * untrusted party by definition, so any of it reaching the operator's DOM
 * unescaped is a stored-XSS route into the console used to police that agent.
 *
 * The script is a template literal rather than a module, so these tests pull
 * the individual render functions out of it and run them in isolation with the
 * handful of helpers they depend on.
 */
import { describe, it, expect } from 'vitest';
import { DASHBOARD_HTML } from '../../src/modules/m10-dashboard/dashboard-html.js';

/** The inline <script> body — everything the browser executes. */
function scriptBody(): string {
  const start = DASHBOARD_HTML.indexOf('<script>');
  const end = DASHBOARD_HTML.lastIndexOf('</script>');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return DASHBOARD_HTML.slice(start + '<script>'.length, end);
}

/** Source text of a top-level `function name(...)` declaration. */
function extractFunction(name: string): string {
  const body = scriptBody();
  const start = body.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`function ${name} not found in dashboard script`);

  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') { depth++; seenBrace = true; }
    else if (ch === '}') {
      depth--;
      if (seenBrace && depth === 0) return body.slice(start, i + 1);
    }
  }
  throw new Error(`unbalanced braces while extracting ${name}`);
}

/** Compile a dashboard function together with the helpers it calls. */
function compile<T>(name: string, deps: string[] = []): T {
  const sources = [...deps.map(extractFunction), extractFunction(name)].join('\n');
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${sources}\nreturn ${name};`)() as T;
}

/**
 * A tool name that closes a single-quoted attribute and starts a new one.
 * This is the shape an agent would use to reach the operator's DOM.
 */
const BREAKOUT = `x' onmouseover='alert(1)`;

describe('escaping helper', () => {
  const esc = compile<(s: unknown) => string>('esc');

  it('neutralises every character that can break out of markup or an attribute', () => {
    expect(esc(`<script>`)).toBe('&lt;script&gt;');
    expect(esc(`'`)).toBe('&#39;');
    expect(esc(`"`)).toBe('&quot;');
    expect(esc('&')).toBe('&amp;');
    expect(esc('`')).toBe('&#96;');
  });

  it('escapes the ampersand first, so entities are not double-decoded', () => {
    // &lt; must survive as &amp;lt; — otherwise a browser decodes it to "<".
    expect(esc('&lt;')).toBe('&amp;lt;');
  });

  it('coerces non-strings rather than throwing', () => {
    expect(esc(null)).toBe('null');
    expect(esc(undefined)).toBe('undefined');
    expect(esc(42)).toBe('42');
  });
});

describe('renderRuleDetail — quick-rule buttons', () => {
  const renderRuleDetail = compile<(fired: unknown[], reasons: string[], op: unknown) => string>(
    'renderRuleDetail', ['esc'],
  );

  it('contains no attribute breakout when the tool name carries a quote', () => {
    const html = renderRuleDetail([], [], { tool: BREAKOUT, method: 'write', agentId: 'a' });

    // The payload must never appear in a form where the quote is still live.
    expect(html).not.toContain(`onmouseover='alert(1)`);
    expect(html).toContain('&#39;');
  });

  it('contains no attribute breakout when the method carries a quote', () => {
    const html = renderRuleDetail([], [], { tool: 'fs', method: BREAKOUT, agentId: 'a' });
    expect(html).not.toContain(`onmouseover='alert(1)`);
  });

  it('contains no attribute breakout when the agent id carries a quote', () => {
    const html = renderRuleDetail([], [], { tool: 'fs', method: 'write', agentId: BREAKOUT });
    expect(html).not.toContain(`onmouseover='alert(1)`);
  });

  it('introduces no event-handler attribute beyond the intended onclick', () => {
    const html = renderRuleDetail([], [], { tool: BREAKOUT, method: BREAKOUT, agentId: BREAKOUT });

    // An injected handler needs a live quote to open its value. Once the
    // payload is entity-encoded the text "onmouseover" may still appear, but
    // as inert data — it is followed by &#39; rather than by a real quote.
    const liveHandlers = [...html.matchAll(/\son(\w+)\s*=\s*['"]/g)].map(m => m[1]);
    expect(new Set(liveHandlers)).toEqual(new Set(['click']));
  });

  it('leaves the payload inert rather than dropping it', () => {
    const html = renderRuleDetail([], [], { tool: BREAKOUT, method: 'write', agentId: 'a' });
    // The data survives for the operator to read; only its quotes are encoded.
    expect(html).toContain('onmouseover=&#39;alert(1)');
    expect(html).not.toContain(`onmouseover='alert(1)`);
  });

  it('still renders the readable button labels', () => {
    const html = renderRuleDetail([], [], { tool: 'filesystem', method: 'write_file', agentId: 'agent-a' });
    expect(html).toContain('Block filesystem/write_file');
    expect(html).toContain('Trust agent agent-a');
  });

  it('emits no quick-rule block when tool or method is missing', () => {
    expect(renderRuleDetail([], [], { agentId: 'a' })).not.toContain('openRuleModal');
  });
});

describe('dashboard markup', () => {
  it('escapes single quotes in every interpolation inside a single-quoted attribute', () => {
    // A guard against reintroducing the pattern: any ${...} landing inside
    // onclick='...' must pass through esc()/escHtml(), or be a literal.
    const offenders: string[] = [];
    DASHBOARD_HTML.split('\n').forEach((line, i) => {
      for (const m of line.matchAll(/onclick='([^']*)'/g)) {
        const attr = m[1] ?? '';
        for (const interp of attr.matchAll(/\$\{([^}]*)\}/g)) {
          const expr = interp[1] ?? '';
          if (/\b(esc|escHtml)\s*\(/.test(expr)) continue;
          if (/^\s*[\w.]+\s*$/.test(expr) && !/[A-Za-z]/.test(expr)) continue;
          offenders.push(`L${i + 1}: \${${expr.trim()}}`);
        }
      }
    });
    expect(offenders).toEqual([]);
  });

  it('ships an escaping helper that covers quotes and backticks', () => {
    const body = scriptBody();
    expect(body).toContain('function esc(');
    for (const entity of ['&amp;', '&lt;', '&gt;', '&quot;', '&#39;', '&#96;']) {
      expect(body).toContain(entity);
    }
  });
});

describe('served page — structure and self-containment', () => {
  it('is a complete HTML document', () => {
    expect(DASHBOARD_HTML.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(DASHBOARD_HTML).toContain('</html>');
    expect(DASHBOARD_HTML).toContain('<title>');
  });

  it('loads nothing from a remote origin', () => {
    // The dashboard holds the operator's full agent history; a third-party
    // script or font would be able to read it, and would break in an
    // air-gapped deployment.
    const remote = [...DASHBOARD_HTML.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)]
      .map(m => m[1] ?? '')
      .filter(u => /^(https?:)?\/\//.test(u));
    expect(remote).toEqual([]);
  });

  it('has exactly one inline script and one inline style block', () => {
    expect(DASHBOARD_HTML.match(/<script>/g) ?? []).toHaveLength(1);
    expect(DASHBOARD_HTML.match(/<\/script>/g) ?? []).toHaveLength(1);
    expect(DASHBOARD_HTML.match(/<style>/g) ?? []).toHaveLength(1);
  });

  it('registers a handler for every tab it renders', () => {
    const tabs = new Set([...DASHBOARD_HTML.matchAll(/showTab\('([a-z-]+)'/g)].map(m => m[1]));
    expect(tabs.size).toBeGreaterThan(1);
    // Every tab named in a button must have a matching panel element.
    for (const tab of tabs) {
      expect(DASHBOARD_HTML).toContain(`tab-${tab}`);
    }
  });

  it('addresses the API relative to its own origin', () => {
    // BASE = '' keeps the dashboard working behind a reverse proxy on any path.
    expect(DASHBOARD_HTML).toContain("const BASE = ''");
    expect(DASHBOARD_HTML).not.toMatch(/fetch\(\s*['"]https?:\/\//);
  });

  it('never interpolates a value into the document at build time', () => {
    // DASHBOARD_HTML is a constant served verbatim; a server-side ${...} would
    // mean per-request string building, and a place for server state to leak.
    expect(DASHBOARD_HTML).not.toMatch(/\$\{[^}]*\breq\b/);
    expect(DASHBOARD_HTML).not.toMatch(/\$\{[^}]*\bprocess\./);
  });
});
