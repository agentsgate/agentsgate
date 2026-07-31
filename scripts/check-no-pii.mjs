#!/usr/bin/env node
/**
 * Refuse to ship a file carrying someone's name.
 *
 * The PDFs under docs/ are exported from Word, and Word stamps its own
 * application-level user name into `/Author` on every export — whatever the
 * source document says. So a clean .docx is not enough, and "remember to strip
 * it" has already failed once. This is the check that does not forget.
 *
 * Scans tracked files for personal identifiers: PDF metadata, document
 * properties, absolute home paths, machine names, and personal email
 * addresses. Exits non-zero on a hit, naming the file and what was found.
 *
 *   node scripts/check-no-pii.mjs            # tracked files
 *   node scripts/check-no-pii.mjs --staged   # only what is about to be committed
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Each pattern is something that should never reach a public repository.
 * Deliberately not a list of one person's details — a project that changes
 * hands should still be protected, so these match the *shape* of the problem.
 */
const PATTERNS = [
  { name: 'macOS home path', re: /\/Users\/[A-Za-z0-9._-]+\// },
  { name: 'Windows home path', re: /[A-Z]:\\Users\\(?!<)[A-Za-z0-9._-]+\\/ },
  { name: 'Linux home path', re: /\/home\/(?!runner\b)[A-Za-z0-9._-]+\// },
  { name: 'personal email', re: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|icloud|me|outlook|hotmail|yahoo)\.[a-z.]{2,}/i },
  { name: 'hostname', re: /\b[A-Za-z0-9-]+s-(?:MacBook|iMac|Mac-mini|Mac-Studio)(?:-Pro|-Air)?\b/i },
];

/**
 * Placeholders, stand-ins and third-party strings that look like a hit and are
 * not. A path is only a leak when the name in it belongs to somebody.
 */
const PLACEHOLDER_NAMES =
  'username|user|your-?name|yourname|foo|bar|baz|qux|me|you|someone|somebody|test|example|alice|bob|runner|<[^>\\\\/]+>';

const ALLOWED = [
  new RegExp(`^/Users/(?:${PLACEHOLDER_NAMES})/`, 'i'),
  new RegExp(`^[A-Z]:\\\\Users\\\\(?:${PLACEHOLDER_NAMES})\\\\`, 'i'),
  new RegExp(`^/home/(?:${PLACEHOLDER_NAMES})/`, 'i'),
  /@(?:example|test)\.(?:com|org|net)$/i,
  /^(?:example|test|user|you|me|someone)@/i,
];

const TEXT_EXT = new Set(['.md', '.txt', '.json', '.yml', '.yaml', '.ts', '.js', '.mjs', '.cjs', '.html', '.css']);
const BINARY_SCANNABLE = new Set(['.pdf']);

function tracked(stagedOnly) {
  const args = stagedOnly
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACM']
    : ['ls-files'];
  return execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);
}

/**
 * Readable strings from a binary. A PDF keeps its metadata uncompressed, so a
 * plain byte scan finds `/Author (…)` without needing to parse the document.
 */
function printableRuns(buf) {
  const out = [];
  let run = '';
  for (const byte of buf) {
    if (byte >= 0x20 && byte < 0x7f) {
      run += String.fromCharCode(byte);
    } else {
      if (run.length >= 6) out.push(run);
      run = '';
    }
  }
  if (run.length >= 6) out.push(run);
  return out.join('\n');
}

function findingsIn(text) {
  const found = [];
  for (const { name, re } of PATTERNS) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
    for (const m of text.matchAll(g)) {
      if (ALLOWED.some(a => a.test(m[0]))) continue;
      found.push({ name, sample: m[0].slice(0, 60) });
    }
  }
  return found;
}

const stagedOnly = process.argv.includes('--staged');
const files = tracked(stagedOnly);
const problems = [];

for (const file of files) {
  const ext = path.extname(file).toLowerCase();
  const scannable = TEXT_EXT.has(ext) || BINARY_SCANNABLE.has(ext);
  if (!scannable) continue;

  let buf;
  try {
    buf = await fs.readFile(file);
  } catch {
    continue;   // deleted between listing and reading
  }
  const text = BINARY_SCANNABLE.has(ext) ? printableRuns(buf) : buf.toString('utf8');

  // `/Author (…)` in a PDF is the case that keeps recurring, so name it clearly
  // rather than leaving it to the generic patterns.
  if (ext === '.pdf') {
    for (const m of text.matchAll(/\/(Author|Creator)\s*\(([^)]{1,80})\)/g)) {
      const value = m[2].trim();
      if (value && !/^(AgentsGate|Word|Microsoft|Adobe|LaTeX|Pages|Quartz|Chromium|Skia)/i.test(value)) {
        problems.push({ file, name: `PDF /${m[1]}`, sample: value });
      }
    }
  }

  for (const f of findingsIn(text)) problems.push({ file, ...f });
}

if (problems.length === 0) {
  console.log(`No personal identifiers in ${files.length} tracked file(s).`);
  process.exit(0);
}

// One line per distinct (file, kind, value); the same name in 400 places is one
// problem, not four hundred.
const seen = new Set();
console.error('Personal identifiers found — these must not be published:\n');
for (const { file, name, sample } of problems) {
  const key = `${file}|${name}|${sample}`;
  if (seen.has(key)) continue;
  seen.add(key);
  console.error(`  ${file}`);
  console.error(`    ${name}: ${sample}`);
}
console.error('\nFor a PDF exported from Word, /Author is the application\'s user name');
console.error('rather than anything stored in the document. Either change it in');
console.error('Word > Settings > User Information, or strip it before committing.');
process.exit(1);
