import { cp, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pagesDirectory = resolve(root, 'cloudflare-pages');
const config = JSON.parse(await readFile(join(pagesDirectory, 'wrangler.jsonc'), 'utf8'));
if (typeof config.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(config.name)) throw new Error('A valid Pages project name is required.');
if (config.pages_build_output_dir !== './public') throw new Error('Expected the Pages build output directory to be ./public.');

// Run outside this Vinext checkout: Wrangler otherwise discovers the ancestor
// .wrangler/deploy/config.json and mistakes the Pages proxy for the app Worker.
const staging = await mkdtemp(join(tmpdir(), 'whitemood-pages-'));
try {
  await copyFile(join(pagesDirectory, 'wrangler.jsonc'), join(staging, 'wrangler.jsonc'));
  await cp(join(pagesDirectory, 'public'), join(staging, 'public'), { recursive: true });
  const exitCode = await new Promise((resolveExit, reject) => {
    const child = spawn(process.execPath, [
      resolve(root, 'node_modules/wrangler/bin/wrangler.js'),
      'pages', 'deploy', 'public', '--project-name', config.name, '--branch', 'main',
    ], {
      cwd: staging,
      env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID ?? '0e8e7f0429306f575ea08b61a74dfc87' },
      stdio: 'inherit',
    });
    const interrupt = () => child.kill('SIGINT');
    const terminate = () => child.kill('SIGTERM');
    const cleanup = () => {
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', terminate);
    };
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', terminate);
    child.once('error', error => { cleanup(); reject(error); });
    child.once('exit', (code, signal) => { cleanup(); resolveExit(code ?? (signal === 'SIGINT' ? 130 : 1)); });
  });
  process.exitCode = exitCode;
} finally {
  await rm(staging, { recursive: true, force: true });
}
