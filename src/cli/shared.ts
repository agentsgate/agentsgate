import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs/promises';
import readline from 'node:readline';

export const STATE_DIR = path.join(os.homedir(), '.agentsgate');
export const STATE_FILE = path.join(STATE_DIR, 'state.json');
export const DB_FILE = path.join(STATE_DIR, 'agentsgate.db');
export const SHADOW_DIR = path.join(STATE_DIR, 'shadow-repo');

export interface ProxyState {
  pid: number;
  port: number;
  dashboardPort: number;
  startedAt: string;
}

// ── Argument parsing helpers ──────────────────────────────────────────────────

export function parseFlag(args: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const match = args.find(a => a.startsWith(prefix));
  return match ? match.slice(prefix.length) : undefined;
}

export function hasFlag(args: string[], name: string): boolean {
  return args.includes(`--${name}`) || args.includes(`-${name[0]}`);
}

/** Validate a team name and return the DB path for it. Exits on invalid name. */
export function resolveDbPath(team: string | undefined): string {
  if (!team) return DB_FILE;
  if (!/^[a-zA-Z0-9_-]+$/.test(team)) {
    console.error(`Invalid --team name "${team}": only [a-zA-Z0-9_-] characters are allowed.`);
    process.exit(1);
  }
  return path.join(STATE_DIR, `data-${team}.db`);
}

// ── State helpers ─────────────────────────────────────────────────────────────

export async function readState(): Promise<ProxyState | null> {
  try {
    return JSON.parse(await fs.readFile(STATE_FILE, 'utf-8')) as ProxyState;
  } catch {
    return null;
  }
}

/** Prompt the user for a yes/no answer. Returns true if they answer yes. */
export async function promptConfirm(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return new Promise(resolve => {
    rl.question(`${question} [y/N] `, answer => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

export async function dashFetch(
  dashboardPort: number,
  method: string,
  urlPath: string,
  bodyData?: unknown
): Promise<{ status: number; body: unknown }> {
  const opts: RequestInit = { method };
  if (bodyData !== undefined) {
    opts.body = JSON.stringify(bodyData);
    opts.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(`http://127.0.0.1:${dashboardPort}${urlPath}`, opts);
  return { status: res.status, body: await res.json() as unknown };
}
