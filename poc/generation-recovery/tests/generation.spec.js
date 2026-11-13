import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
  for (let attempt = 0; attempt < 80; attempt++) {
    if (child.exitCode !== null) throw new Error('Mock server exited before becoming healthy');
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Mock server health timeout');
}
function launchServer(port, stateFile) {
  return spawn(process.execPath, ['server.mjs'], {
    cwd: process.cwd(),
    env: { ...process.env, PORT: String(port), GENERATION_STATE_FILE: stateFile },
    stdio: 'ignore'
  });
}
async function stopServer(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => child.once('exit', resolve));
}

test('服务进程重启后恢复任务、事件序号与幂等映射', async () => {
  const port = 4188;
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
