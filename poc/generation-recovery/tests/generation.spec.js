import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createNetServer } from 'node:net';

test('用户消息先落本地，最终结果确认后才写入 Assistant Message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#status')).toContainText('生成完成', { timeout: 20_000 });
  await expect(page.locator('#messages')).toContainText('user');
  await expect(page.locator('#messages')).toContainText('assistant');
  await expect(page.locator('#messages')).toContainText('这是一条模拟生成结果。');
});

test('客户端断线并刷新后，可恢复服务端最终结果', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '断开流连接' }).click();
  await page.reload();
  await expect(page.locator('#status')).toContainText('生成完成', { timeout: 20_000 });
  await expect(page.locator('#messages')).toContainText('assistant');
});

test('重复提交相同幂等键返回同一 generation_id', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '重复提交同一请求' }).click();
  await expect(page.locator('#status')).toContainText('幂等验证通过');
});

test('取消任务后不生成正式 Assistant Message', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#stream')).toContainText('这是', { timeout: 10_000 });
  await page.getByRole('button', { name: '取消生成' }).click();
  await expect(page.locator('#status')).toContainText('生成已取消');
  await expect(page.locator('#messages')).not.toContainText('assistant');
});

async function waitForHealth(port, child) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (child.exitCode !== null) throw new Error('Mock server exited before becoming healthy');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Mock server health timeout');
}
async function freePort() {
  const server = createNetServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const port = server.address().port;
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}
function launchServer(port, stateFile, extraEnv = {}) {
  return spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), GENERATION_STATE_FILE: stateFile, ...extraEnv },
    stdio: 'ignore'
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('服务进程重启后恢复任务、事件序号与幂等映射', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-generation-'));
  const stateFile = join(stateDir, 'state.json');
  let child = launchServer(port, stateFile);
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'restart-test-key' },
      body: JSON.stringify({ message: 'restart fixture' })
    });
    expect(created.status).toBe(202);
    const receipt = await created.json();
    let beforeRestart;
    for (let attempt = 0; attempt < 50; attempt++) {
      beforeRestart = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (beforeRestart.sequence >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(beforeRestart.sequence).toBeGreaterThanOrEqual(3);
    await stopServer(child);
    child = launchServer(port, stateFile);
    await waitForHealth(port, child);

    const repeated = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'restart-test-key' },
      body: JSON.stringify({ message: 'restart fixture' })
    });
    const reused = await repeated.json();
    expect(reused.generation_id).toBe(receipt.generation_id);
    expect(reused.reused).toBe(true);

    let finalState;
    for (let attempt = 0; attempt < 80; attempt++) {
      finalState = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (finalState.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(finalState.status).toBe('completed');
    expect(finalState.final_result.text).toBe('这是一条模拟生成结果。');
    expect(finalState.sequence).toBeGreaterThan(beforeRestart.sequence);

    const replay = await (await fetch(base + '/api/generations/' + receipt.generation_id + '/events?after=1')).text();
    const events = [...replay.matchAll(/"sequence":(\d+)/g)].map((match) => Number(match[1]));
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toBe(2);
    expect(events.every((value, index) => index === 0 || value === events[index - 1] + 1)).toBe(true);
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('同一幂等键绑定请求正文，正文不同时拒绝复用', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-idempotency-'));
  const child = launchServer(port, join(stateDir, 'state.json'));
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const send = (message) => fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'payload-bound-key' },
      body: JSON.stringify({ message })
    });
    const first = await send('first payload');
    expect(first.status).toBe(202);
    const firstReceipt = await first.json();
    const same = await send('first payload');
    expect(same.status).toBe(200);
    expect((await same.json()).generation_id).toBe(firstReceipt.generation_id);
    const different = await send('different payload');
    expect(different.status).toBe(409);
    expect((await different.json()).error).toContain('different request payload');
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('事件重连回放保持 event_id 唯一且序号连续', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-event-replay-'));
  const child = launchServer(port, join(stateDir, 'state.json'));
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'event-replay-key' },
      body: JSON.stringify({ message: 'event replay fixture' })
    });
    const receipt = await created.json();
    let state;
    for (let attempt = 0; attempt < 80; attempt++) {
      state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (state.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(state.status).toBe('completed');
    const readEvents = async (after) => (await fetch(base + '/api/generations/' + receipt.generation_id + '/events?after=' + after)).text();
    const firstReplay = await readEvents(0);
    const reconnectReplay = await readEvents(2);
    const parse = (raw) => [...raw.matchAll(/data: (\{[^\n]+\})/g)].map((match) => JSON.parse(match[1]));
    const all = parse(firstReplay);
    const resumed = parse(reconnectReplay);
    expect(all.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(new Set(all.map((event) => event.event_id)).size).toBe(all.length);
    expect(resumed.map((event) => event.sequence)).toEqual([3, 4, 5, 6, 7]);
    expect(resumed.every((event, index) => event.sequence === all[index + 2].sequence)).toBe(true);
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('接近自然完成时取消仍产生唯一终态，不暴露最终结果', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-cancel-race-'));
  const child = launchServer(port, join(stateDir, 'state.json'), { GENERATION_TOKEN_DELAY_MS: '1000' });
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'cancel-race-key' },
      body: JSON.stringify({ message: 'cancel race fixture' })
    });
    const receipt = await created.json();
    let state;
    // sequence 1 is "started"; sequence >= 5 means four deltas are durable.
    // Do not poll the SSE endpoint here: an active SSE response intentionally stays open.
    for (let attempt = 0; attempt < 80; attempt++) {
      state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (state.sequence >= 5 || ['completed', 'cancelled', 'failed'].includes(state.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cancelled = await fetch(base + '/api/generations/' + receipt.generation_id + '/cancel', { method: 'POST' });
    expect((await cancelled.json()).status).toBe('cancelled');
    await new Promise((resolve) => setTimeout(resolve, 300));
    state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
    expect(state.status).toBe('cancelled');
    expect(state.final_result).toBeNull();
    const events = await (await fetch(base + '/api/generations/' + receipt.generation_id + '/events?after=0')).text();
    expect([...events.matchAll(/event: completed/g)]).toHaveLength(0);
    expect([...events.matchAll(/event: cancelled/g)]).toHaveLength(1);
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('创建任务请求失败后可在刷新后使用原幂等键重试', async ({ page }) => {
  let failedOnce = false;
  await page.route('**/api/generations', async (route) => {
    if (route.request().method() === 'POST' && !failedOnce) {
      failedOnce = true;
      await route.abort('failed');
      return;
    }
    await route.continue();
  });
  await page.goto('/');
  await page.locator('#message').fill('retry fixture: do not duplicate user message');
  await page.getByRole('button', { name: '发送消息' }).click();
  await expect(page.locator('#status')).toContainText('可重试创建');
  await expect(page.locator('#messages').locator('li')).toHaveCount(1);
  await expect(page.locator('#retry')).toBeVisible();

  // The pending local job survives refresh; retry reuses the same key and message.
  await page.reload();
  await expect(page.locator('#retry')).toBeVisible();
  await page.getByRole('button', { name: '重试创建任务' }).click();
  await expect(page.locator('#status')).toContainText('生成完成', { timeout: 20_000 });
  await expect(page.locator('#messages').locator('li')).toHaveCount(2);
  await expect(page.locator('#messages')).toContainText('retry fixture: do not duplicate user message');
  await expect(page.locator('#messages')).toContainText('这是一条模拟生成结果。');
});


test('服务端持久化状态不包含用户消息明文', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-private-payload-'));
  const stateFile = join(stateDir, 'state.json');
  const child = launchServer(port, stateFile);
  const privateMessage = 'private-message-fixture-DO-NOT-PERSIST';
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'private-payload-key' },
      body: JSON.stringify({ message: privateMessage })
    });
    expect(created.status).toBe(202);
    const receipt = await created.json();
    for (let attempt = 0; attempt < 80; attempt++) {
      const state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (state.status === 'completed') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const persisted = await readFile(stateFile, 'utf8');
    expect(persisted).not.toContain(privateMessage);
    expect(persisted).toContain(receipt.generation_id);
    expect(persisted).toContain('requestHash');
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});


test('SSE 长连接发送心跳并关闭时清理订阅', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-sse-heartbeat-'));
  const child = launchServer(port, join(stateDir, 'state.json'), {
    GENERATION_TOKEN_DELAY_MS: '5000',
    GENERATION_HEARTBEAT_MS: '1000'
  });
  const controller = new AbortController();
  let reader;
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'heartbeat-key' },
      body: JSON.stringify({ message: 'heartbeat fixture' })
    });
    const receipt = await created.json();
    const response = await fetch(base + '/api/generations/' + receipt.generation_id + '/events', { signal: controller.signal });
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    reader = response.body.getReader();
    const decoder = new TextDecoder();
    await reader.read();
    const heartbeat = await reader.read();
    expect(decoder.decode(heartbeat.value)).toContain(': heartbeat');
  } finally {
    controller.abort();
    await reader?.cancel().catch(() => undefined);
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('超过任务 TTL 后转为 expired 且停止继续生成', async () => {
  const port = await freePort();
  const stateDir = await mkdtemp(join(tmpdir(), 'read-book-generation-ttl-'));
  const child = launchServer(port, join(stateDir, 'state.json'), {
    GENERATION_TOKEN_DELAY_MS: '3000',
    GENERATION_TASK_TTL_MS: '1000'
  });
  try {
    await waitForHealth(port, child);
    const base = `http://127.0.0.1:${port}`;
    const created = await fetch(base + '/api/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'ttl-key' },
      body: JSON.stringify({ message: 'ttl fixture' })
    });
    const receipt = await created.json();
    let state;
    for (let attempt = 0; attempt < 60; attempt++) {
      state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
      if (state.status === 'expired') break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    expect(state.status).toBe('expired');
    expect(state.final_result).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 2500));
    state = await (await fetch(base + '/api/generations/' + receipt.generation_id)).json();
    expect(state.status).toBe('expired');
    expect(state.final_result).toBeNull();
  } finally {
    await stopServer(child);
    await rm(stateDir, { recursive: true, force: true });
  }
});
