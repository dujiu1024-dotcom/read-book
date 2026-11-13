import http from 'node:http';
import { randomUUID } from 'node:crypto';

const tasks = new Map();
const idempotency = new Map();
const subscribers = new Map();
const tokens = ['这是', '一条', '模拟', '生成', '结果。'];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}
async function body(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  return raw ? JSON.parse(raw) : {};
}
function emit(task, type, data = {}) {
  const event = { event_id: task.id + ':' + (task.sequence + 1), sequence: ++task.sequence, generation_id: task.id, type, ...data };
  task.events.push(event);
  for (const response of subscribers.get(task.id) || []) response.write(`id: ${event.event_id}\nevent: ${type}\ndata: ${JSON.stringify(event)}\n\n`);
  if (['completed', 'cancelled', 'failed'].includes(type)) {
    for (const response of subscribers.get(task.id) || []) response.end();
    subscribers.delete(task.id);
  }
}
async function execute(task) {
  task.status = 'running';
  emit(task, 'started');
  const chunks = [];
  for (const token of tokens) {
    if (task.status === 'cancelled') return;
    await delay(180);
    if (task.status === 'cancelled') return;
    chunks.push(token);
    emit(task, 'delta', { text: token });
  }
  if (task.status !== 'running') return;
  task.status = 'completed';
  task.finalResult = { text: chunks.join(''), completedAt: new Date().toISOString() };
  emit(task, 'completed', { result_available: true });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1:4177');
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return json(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/generations') {
      const idempotencyKey = req.headers['idempotency-key'];
      if (!idempotencyKey) return json(res, 400, { error: 'Idempotency-Key required' });
      if (idempotency.has(idempotencyKey)) return json(res, 200, { ...idempotency.get(idempotencyKey), reused: true });
      const input = await body(req);
      if (typeof input.message !== 'string' || !input.message.trim()) return json(res, 400, { error: 'message required' });
      const task = { id: randomUUID(), idempotencyKey, status: 'queued', message: input.message, sequence: 0, events: [], finalResult: null };
      tasks.set(task.id, task);
      const receipt = { generation_id: task.id, status: task.status, idempotency_key: idempotencyKey };
      idempotency.set(idempotencyKey, receipt);
      json(res, 202, receipt);
      setImmediate(() => execute(task));
      return;
    }
    const match = url.pathname.match(/^\/api\/generations\/([^/]+)(?:\/(events|cancel))?$/);
    if (match) {
      const task = tasks.get(match[1]);
      if (!task) return json(res, 404, { error: 'generation not found' });
      if (req.method === 'GET' && !match[2]) {
        return json(res, 200, { generation_id: task.id, status: task.status, sequence: task.sequence, final_result: task.status === 'completed' ? task.finalResult : null });
      }
      if (req.method === 'GET' && match[2] === 'events') {
        const after = Number(url.searchParams.get('after') || 0);
        res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const event of task.events.filter((item) => item.sequence > after)) res.write(`id: ${event.event_id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        if (['completed', 'cancelled', 'failed'].includes(task.status)) return res.end();
        if (!subscribers.has(task.id)) subscribers.set(task.id, new Set());
        subscribers.get(task.id).add(res);
        req.on('close', () => subscribers.get(task.id)?.delete(res));
        return;
      }
      if (req.method === 'POST' && match[2] === 'cancel') {
        if (['queued', 'running'].includes(task.status)) {
          task.status = 'cancelled';
          emit(task, 'cancelled');
        }
        return json(res, 200, { generation_id: task.id, status: task.status });
      }
    }
    json(res, 404, { error: 'not found' });
  } catch (error) { json(res, 500, { error: error.message }); }
});
server.listen(4177, '127.0.0.1', () => process.stdout.write('Mock Generation Server listening on 4177\n'));
