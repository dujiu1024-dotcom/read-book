import './style.css';
import { saveMessage, saveJob, listMessages, listJobs } from './local-store.js';

const $ = (id) => document.getElementById(id);
let activeJob = null;
let streamController = null;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function renderMessages() {
  const messages = (await listMessages()).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  $('messages').innerHTML = messages.map((item) => `<li><strong>${item.role}</strong> · ${item.content}</li>`).join('');
}
function status(text) { $('status').textContent = text; }
function renderStream(text) { $('stream').textContent = text; }
async function requestGeneration(job) {
  const response = await fetch('/api/generations', {
    method: 'POST', headers: { 'content-type': 'application/json', 'Idempotency-Key': job.idempotencyKey },
    body: JSON.stringify({ message: job.userText })
  });
  if (!response.ok) throw new Error('创建生成任务失败：' + response.status);
  const receipt = await response.json();
  const updated = { ...job, generationId: receipt.generation_id, status: receipt.status, reused: receipt.reused || false };
  await saveJob(updated);
  activeJob = updated;
  return updated;
}
async function finalize(job) {
  const response = await fetch('/api/generations/' + job.generationId);
  if (!response.ok) throw new Error('查询最终结果失败');
  const result = await response.json();
  if (result.status === 'completed' && result.final_result) {
    await saveMessage({ id: 'assistant:' + job.generationId, generationId: job.generationId, role: 'assistant', content: result.final_result.text, createdAt: result.final_result.completedAt });
    await saveJob({ ...job, status: 'completed', lastSequence: result.sequence });
    renderStream(result.final_result.text);
    status('生成完成：最终结果已确认并写入本地。');
  } else if (result.status === 'cancelled') {
    await saveJob({ ...job, status: 'cancelled', lastSequence: result.sequence });
    status('生成已取消；未写入 Assistant Message。');
  } else {
    await saveJob({ ...job, status: result.status, lastSequence: result.sequence });
  }
  await renderMessages();
  return result;
}
async function consumeEvents(job) {
  streamController?.abort();
  streamController = new AbortController();
  let streamed = '';
  const response = await fetch('/api/generations/' + job.generationId + '/events?after=' + (job.lastSequence || 0), { signal: streamController.signal });
  if (!response.ok) throw new Error('连接事件流失败');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() || '';
      for (const block of blocks) {
        const line = block.split('\n').find((item) => item.startsWith('data: '));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        job = { ...job, lastSequence: event.sequence, status: event.type === 'completed' ? 'completed' : event.type === 'cancelled' ? 'cancelled' : 'running' };
        await saveJob(job);
        if (event.type === 'delta') { streamed += event.text; renderStream(streamed); status('正在接收流式增量…'); }
      }
    }
  } finally { reader.releaseLock(); }
  return finalize(job);
}
async function recoverJob(job) {
  if (!job.generationId || ['completed', 'cancelled'].includes(job.status)) return;
  const response = await fetch('/api/generations/' + job.generationId);
  if (!response.ok) return;
  const state = await response.json();
  if (state.status === 'completed' || state.status === 'cancelled') return finalize(job);
  activeJob = { ...job, status: state.status, lastSequence: Math.max(job.lastSequence || 0, state.sequence > 0 ? state.sequence - 1 : 0) };
  await consumeEvents(activeJob);
}
$('send').addEventListener('click', async () => {
  const userText = $('message').value.trim();
  if (!userText) return;
  status('正在先保存用户消息到本地…');
  const createdAt = new Date().toISOString();
  const userMessage = { id: crypto.randomUUID(), role: 'user', content: userText, createdAt };
  await saveMessage(userMessage);
  const job = { idempotencyKey: crypto.randomUUID(), userText, userMessageId: userMessage.id, status: 'queued', lastSequence: 0 };
  await saveJob(job);
  await renderMessages();
  status('用户消息已先落本地，正在创建服务端生成任务…');
  try { activeJob = await requestGeneration(job); await consumeEvents(activeJob); }
  catch (error) { status('任务暂不可用；用户消息仍保留在本地。' + error.message); }
});
$('disconnect').addEventListener('click', () => {
  streamController?.abort();
  status('客户端流连接已断开；服务端任务继续运行。');
});
$('recover').addEventListener('click', async () => {
  const jobs = await listJobs();
  for (const job of jobs) if (!['completed', 'cancelled'].includes(job.status)) await recoverJob(job);
});
$('duplicate').addEventListener('click', async () => {
  if (!activeJob) { status('没有可重复提交的任务。'); return; }
  try {
    const repeated = await requestGeneration(activeJob);
    status(repeated.generationId === activeJob.generationId ? '幂等验证通过：重复请求复用同一 generation_id。' : '幂等验证失败：生成任务 ID 不一致。');
  } catch (error) { status(error.message); }
});
$('cancel').addEventListener('click', async () => {
  if (!activeJob?.generationId) { status('没有可取消的生成任务。'); return; }
  const response = await fetch('/api/generations/' + activeJob.generationId + '/cancel', { method: 'POST' });
  const result = await response.json();
  activeJob = { ...activeJob, status: result.status };
  await saveJob(activeJob);
  await finalize(activeJob);
});
await renderMessages();
await $('recover').click();
