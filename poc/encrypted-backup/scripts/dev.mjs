import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const node = process.execPath;
const env = { ...process.env, POC_BACKUP_PORT: process.env.POC_BACKUP_PORT || '4180' };
const server = spawn(node, ['server/cli.js'], { cwd: root, env, stdio: 'inherit' });
const vite = spawn(node, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', ...process.argv.slice(2)], {
  cwd: root, env, stdio: 'inherit'
});
let stopping = false;

function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  server.kill('SIGTERM');
  vite.kill('SIGTERM');
  setTimeout(() => process.exit(code), 100).unref();
}
server.on('exit', (code) => { if (!stopping && code !== 0) stop(code || 1); });
vite.on('exit', (code) => { if (!stopping) stop(code || 0); });
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
