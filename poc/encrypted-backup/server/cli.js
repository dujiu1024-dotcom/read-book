import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listenBackupHttpServer } from './http-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.POC_BACKUP_DATA_DIR || path.resolve(here, '../.poc-backup-data');
const port = Number(process.env.POC_BACKUP_PORT || 4180);
const host = process.env.POC_BACKUP_HOST || '127.0.0.1';

const app = await listenBackupHttpServer({ dataDir, port, host });
console.log(JSON.stringify({ event: 'ready', service: 'encrypted-backup-poc', host, port }));

function shutdown() {
  app.server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
