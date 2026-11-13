import { withDatasetWriter } from './coordination.js';

let worker;
let sequence = 0;
const pending = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./sqlite-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    const item = pending.get(data.id);
    if (!item) return;
    pending.delete(data.id);
    if (data.error) item.reject(new Error(data.error.message));
    else item.resolve(data.result);
  };
  worker.onerror = (event) => {
    for (const item of pending.values()) item.reject(new Error(event.message || 'SQLite Worker 异常退出'));
    pending.clear();
    worker = undefined;
  };
  return worker;
}

function request(type, payload = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    getWorker().postMessage({ id, type, ...payload });
  });
}

export async function runSqlite(count, datasetId) {
  const coordinated = await withDatasetWriter(datasetId, async () => {
    await request('init');
    return request('run', { count, datasetId });
  });
  return { ...coordinated.result, writerCoordination: coordinated.coordination };
}
export async function checkSqlite(datasetId) {
  await request('init');
  return request('check', { datasetId });
}
