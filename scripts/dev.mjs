import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const executable = name => resolve('node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const children = [
  spawn(executable('tsx'), ['watch', '--env-file-if-exists=.env', 'server/index.ts'], { stdio: 'inherit', shell: process.platform === 'win32' }),
  spawn(executable('vite'), ['--host', '127.0.0.1'], { stdio: 'inherit', shell: process.platform === 'win32' }),
];
let exiting = false;
function stop(code = 0) { if (exiting) return; exiting = true; children.forEach(child => child.kill('SIGTERM')); process.exitCode = code; }
for (const child of children) { child.on('error', error => { console.error(error.message); stop(1); }); child.on('exit', code => { if (!exiting) stop(code || 0); }); }
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
