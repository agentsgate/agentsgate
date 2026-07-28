import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const rootDir = process.cwd();
const npmCmd = 'npm';

async function main() {
  assertNodeVersion();

  await fs.mkdir(path.join(rootDir, 'logs'), { recursive: true });
  await fs.mkdir(path.join(os.homedir(), '.agentsgate'), { recursive: true });

  await run(npmCmd, process.env.CI ? ['ci'] : ['install']);
  await run(npmCmd, ['run', 'build']);
  await run(npmCmd, ['run', 'typecheck']);
  await run(npmCmd, ['test']);

  console.log('\nBootstrap complete.');
  console.log('Next steps:');
  console.log('  1. node dist/cli.js start');
  console.log('  2. node dist/cli.js status');
  console.log('  3. open http://localhost:4001');
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split('.')[0]);
  if (Number.isNaN(major) || major < 20) {
    throw new Error(`AgentsGate requires Node.js 20+. Current version: ${process.versions.node}`);
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = process.platform === 'win32'
      ? spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `${command} ${args.join(' ')}`], {
          cwd: rootDir,
          stdio: 'inherit',
          shell: false,
        })
      : spawn(command, args, {
          cwd: rootDir,
          stdio: 'inherit',
          shell: false,
        });

    child.on('exit', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code ?? 'unknown'}`));
    });
    child.on('error', reject);
  });
}

main().catch(error => {
  console.error('Bootstrap failed:', error.message);
  process.exit(1);
});