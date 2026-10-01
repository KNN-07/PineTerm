import { spawn } from 'node:child_process';
process.env.PINETERM_PUBLIC_ORIGIN ??= 'http://127.0.0.1:5173';
const children = [
  spawn(process.execPath, ['--import', 'tsx', '--watch', 'apps/server/src/index.ts'], { stdio: 'inherit', env: process.env }),
  spawn('npm', ['run', 'dev', '-w', '@pineterm/web'], { stdio: 'inherit', env: process.env }),
];
let stopping = false;
function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) {
  child.on('error', (error) => { console.error(error.message); stop(1); });
  child.on('exit', (code) => stop(code ?? 1));
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
