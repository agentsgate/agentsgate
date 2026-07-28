import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const nodeCmd = process.execPath;

async function main() {
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), 'agentsgate-smoke-'));
  const proxyPort = 4300 + Math.floor(Math.random() * 200);
  const configPath = path.join(tempHome, 'config.json');
  const env = buildEnv(tempHome);

  await fs.writeFile(configPath, JSON.stringify({ proxy: { port: proxyPort } }, null, 2));

  let child;
  try {
    child = spawn(nodeCmd, ['dist/cli.js', 'start', `--config=${configPath}`], {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const logs = [];
    child.stdout.on('data', chunk => logs.push(String(chunk)));
    child.stderr.on('data', chunk => logs.push(String(chunk)));

    await waitForHealth(proxyPort + 1);

    const statusOutput = await execNode(['dist/cli.js', 'status'], env);
    if (!statusOutput.includes('AgentsGate is RUNNING')) {
      throw new Error(`Unexpected status output: ${statusOutput}`);
    }

    const res = await fetch(`http://127.0.0.1:${proxyPort + 1}/health`);
    if (!res.ok) {
      throw new Error(`Health endpoint returned ${res.status}`);
    }

    await execNode(['dist/cli.js', 'stop'], env);
    await waitForExit(child, 10_000);

    const stoppedOutput = await execNode(['dist/cli.js', 'status'], env);
    if (!stoppedOutput.includes('STOPPED')) {
      throw new Error(`Unexpected stopped status output: ${stoppedOutput}`);
    }

    console.log('Smoke startup passed.');
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGINT');
      await waitForExit(child, 5_000).catch(() => {
        child.kill();
      });
    }
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

function buildEnv(tempHome) {
  return {
    ...process.env,
    HOME: tempHome,
    USERPROFILE: tempHome,
  };
}

function execNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(nodeCmd, args, {
      cwd: rootDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    child.on('error', reject);
    child.on('exit', code => {
      if (code === 0) {
        resolve(output);
        return;
      }
      reject(new Error(output || `node ${args.join(' ')} exited with ${code ?? 'unknown'}`));
    });
  });
}

async function waitForHealth(port, timeoutMs = 15_000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // Retry until timeout.
    }

    await new Promise(resolve => setTimeout(resolve, 250));
  }

  throw new Error(`Timed out waiting for dashboard health on port ${port}`);
}

function waitForExit(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    if (child.exitCode !== null) {
      resolve();
      return;
    }

    const timeout = setTimeout(() => reject(new Error('Timed out waiting for process exit')), timeoutMs);
    child.on('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
    child.on('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

main().catch(error => {
  console.error('Smoke startup failed:', error.message);
  process.exit(1);
});