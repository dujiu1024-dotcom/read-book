import http from 'node:http';
import { randomUUID, createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

const PORT = Number(process.env.PORT || 4177);
const STATE_FILE = resolve(process.env.GENERATION_STATE_FILE || './.poc-generation-state.json');
const tokens = ['这是', '一条', '模拟', '生成', '结果。'];
const TOKEN_DELAY_MS = Number(process.env.GENERATION_TOKEN_DELAY_MS || 180);
const HEARTBEAT_MS = Number(process.env.GENERATION_HEARTBEAT_MS || 15_000);
const TASK_TTL_MS = Number(process.env.GENERATION_TASK_TTL_MS || 24 * 60 * 60 * 1000);
if (!Number.isSafeInteger(HEARTBEAT_MS) || HEARTBEAT_MS < 1000) throw new Error('GENERATION_HEARTBEAT_MS must be an integer >= 1000');
if (!Number.isSafeInteger(TASK_TTL_MS) || TASK_TTL_MS < 1000) throw new Error('GENERATION_TASK_TTL_MS must be an integer >= 1000');
const tasks = new Map();
const idempotency = new Map();
const subscribers = new Map();
let persistQueue = Promise.resolve();

function audit(event, fields = {}) {
  // Deliberately exclude message content, access tokens and idempotency keys.
  process.stdout.write(JSON.stringify({ at: new Date().toISOString(), event, ...fields }) + '\n');
}
function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function snapshot() {
  return {
    version: 1,
    tasks: [...tasks.values()].map((task) => ({ ...task, events: task.events })),
    savedAt: new Date().toISOString()
  };
}
function persist() {
  persistQueue = persistQueue.then(async () => {
    const data = JSON.stringify(snapshot());
    await mkdir(dirname(STATE_FILE), { recursive: true });
    const temporary = STATE_FILE + '.tmp';
    await writeFile(temporary, data, { mode: 0o600 });
    await rename(temporary, STATE_FILE);
  });
  return persistQueue;
}
async function loadState() {
  try {
    const state = JSON.parse(await readFile(STATE_FILE, 'utf8'));
    if (state.version !== 1 || !Array.isArray(state.tasks)) throw new Error('Unsupported generation state version');
    for (const task of state.tasks) {
      tasks.set(task.id, task);
      idempotency.set(task.idempotencyKey, {
        generation_id: task.id,
        status: task.status,
        idempotency_key: task.idempotencyKey,
        request_hash: task.requestHash || null
      });
      // A process restart interrupts execution, not the durable job. Resume from
      // the last persisted delta; sequence/event IDs remain stable.
      if (task.status === 'running') task.status = 'queued';
    }
    await persist();
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
function emit(task, type, data = {}) {
  const event = { event_id: task.id + ':' + (task.sequence + 1), sequence: ++task.sequence, generation_id: task.id, type, ...data };
  task.events.push(event);
  for (const response of subscribers.get(task.id) || []) response.write(`id: ${event.event_id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (['completed', 'cancelled', 'failed', 'expired'].includes(type)) {
    for (const response of subscribers.get(task.id) || []) response.end();
    subscribers.delete(task.id);
  }
}
function expireTasks(now = Date.now()) {
  let changed = false;
  for (const task of tasks.values()) {
    if (!['queued', 'running'].includes(task.status) || !task.expiresAt || Date.parse(task.expiresAt) > now) continue;
    task.status = 'expired';
    task.finalResult = null;
    emit(task, 'expired');
    const receipt = idempotency.get(task.idempotencyKey);
    if (receipt) receipt.status = 'expired';
    audit('generation.expired', { generation_id: task.id, sequence: task.sequence });
    changed = true;
  }
  return changed;
}
const delay = (ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
async function execute(task) {
  if (!['queued', 'running'].includes(task.status)) return;
  task.status = 'running';
  if (!task.events.some((event) => event.type === 'started')) emit(task, 'started');
  await persist();
  const alreadyProduced = task.events.filter((event) => event.type === 'delta').length;
  for (let index = alreadyProduced; index < tokens.length; index++) {
    await delay(TOKEN_DELAY_MS);
    if (task.status !== 'running') return;
    emit(task, 'delta', { text: tokens[index] });
    await persist();
  }
  if (task.status !== 'running') return;
  task.status = 'completed';
  task.finalResult = { text: tokens.join(''), completedAt: new Date().toISOString() };
  emit(task, 'completed', { result_available: true });
  await persist();
  audit('generation.completed', { generation_id: task.id, sequence: task.sequence });
}
function schedule(task) {
  setImmediate(() => execute(task).catch(async (error) => {
    task.status = 'failed';
    task.failureCode = 'GENERATION_EXECUTION_FAILED';
    emit(task, 'failed', { code: task.failureCode });
    await persist();
    audit('generation.failed', { generation_id: task.id, code: task.failureCode, sequence: task.sequence });
  }));
}

await loadState();
expireTasks();
for (const task of tasks.values()) if (task.status === 'queued') schedule(task);
const expiryTimer = setInterval(() => { if (expireTasks()) void persist(); }, Math.min(TASK_TTL_MS, 60_000));
expiryTimer.unref?.();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:' + PORT);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/generations') {
      const idempotencyKey = req.headers['idempotency-key'];
      if (!idempotencyKey) return json(res, 400, { error: 'Idempotency-Key required' });
      const input = await body(req);
      if (typeof input.message !== 'string' || !input.message.trim()) return json(res, 400, { error: 'message required' });
      const requestHash = createHash('sha256').update(input.message).digest('hex');
      if (idempotency.has(idempotencyKey)) {
        const existing = idempotency.get(idempotencyKey);
        if (existing.request_hash && existing.request_hash !== requestHash) {
          return json(res, 409, { error: 'Idempotency-Key was already used with a different request payload' });
        }
        return json(res, 200, { ...existing, reused: true });
      }
      const createdAt = new Date().toISOString();
      const task = { id: randomUUID(), idempotencyKey, requestHash, status: 'queued', sequence: 0, events: [], finalResult: null, createdAt, expiresAt: new Date(Date.now() + TASK_TTL_MS).toISOString() };
      tasks.set(task.id, task);
      const receipt = { generation_id: task.id, status: task.status, idempotency_key: idempotencyKey, request_hash: requestHash };
      idempotency.set(idempotencyKey, receipt);
      await persist();
      audit('generation.created', { generation_id: task.id, request_hash: requestHash, status: task.status });
      json(res, 202, receipt);
      schedule(task);
      return;
    }
    const match = url.pathname.match(/^\/api\/generations\/([^/]+)(?:\/(events|cancel))?$/);
    if (match) {
      const task = tasks.get(match[1]);
      if (!task) return json(res, 404, { error: 'generation not found' });
      expireTasks();
      if (req.method === 'GET' && !match[2]) {
        return json(res, 200, { generation_id: task.id, status: task.status, sequence: task.sequence, final_result: task.status === 'completed' ? task.finalResult : null });
      }
      if (req.method === 'GET' && match[2] === 'events') {
        const after = Math.max(0, Number(url.searchParams.get('after') || 0));
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        });
        audit('generation.stream.open', { generation_id: task.id, after });
        for (const event of task.events.filter((item) => item.sequence > after)) res.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (['completed', 'cancelled', 'failed', 'expired'].includes(task.status)) return res.end();
        if (!subscribers.has(task.id)) subscribers.set(task.id, new Set());
        subscribers.get(task.id).add(res);
        const heartbeat = setInterval(() => {
          if (!res.destroyed && !res.writableEnded) res.write(': heartbeat\n\n');
        }, HEARTBEAT_MS);
        heartbeat.unref?.();
        res.on('close', () => {
          clearInterval(heartbeat);
          subscribers.get(task.id)?.delete(res);
          audit('generation.stream.close', { generation_id: task.id });
        });
        return;
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        if (['queued', 'running'].includes(task.status)) {
          task.status = 'cancelled';
          emit(task, 'cancelled');
          await persist();
          audit('generation.cancelled', { generation_id: task.id, sequence: task.sequence });
        }
        return json(res, 200, { generation_id: task.id, status: task.status });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (error) { json(res, 500, { error: error.message }); }
});
server.listen(PORT, '127.0.0.1', () => process.stdout.write('Mock Generation Server listening on ' + PORT + '\n'));
