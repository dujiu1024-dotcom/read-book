import './style.css';
import { runIndexedDb, checkIndexedDb } from './indexeddb.js';
import { runSqlite, checkSqlite } from './sqlite.js';

const $ = (id) => document.getElementById(id);
const environment = {
  userAgent: navigator.userAgent,
  secureContext: window.isSecureContext,
  indexedDB: 'indexedDB' in window,
  opfs: Boolean(navigator.storage?.getDirectory),
  storageEstimate: Boolean(navigator.storage?.estimate),
  storagePersist: Boolean(navigator.storage?.persist),
  crossOriginIsolated: window.crossOriginIsolated
};
$('environment').innerHTML = Object.entries(environment).map(([key, value]) =>
  '<dt>' + key + '</dt><dd>' + String(value) + '</dd>'
).join('');
$('capability').textContent = environment.opfs && environment.crossOriginIsolated
  ? '检测完成：OPFS 与跨源隔离可用。实际 SQLite VFS 初始化仍以运行结果为准。'
  : '检测完成：当前环境缺少 OPFS 或跨源隔离，SQLite OPFS 测试可能无法启动。';

const saved = sessionStorage.getItem('lastPocDataset');
if (saved) {
  try {
    window.lastPocDataset = JSON.parse(saved);
    $('adapter').value = window.lastPocDataset.adapter;
  } catch { sessionStorage.removeItem('lastPocDataset'); }
}

async function storageStatus() {
  const [estimate, persisted] = await Promise.all([
    navigator.storage?.estimate?.().catch(() => null),
    navigator.storage?.persisted?.().catch(() => null)
  ]);
  let persistRequest = 'not available';
  if (navigator.storage?.persist) {
    try {
      persistRequest = await Promise.race([
        navigator.storage.persist().then((granted) => String(granted)).catch((error) => 'error: ' + error.message),
        new Promise((resolve) => setTimeout(() => resolve('timed out / permission unresolved'), 2500))
      ]);
    } catch (error) { persistRequest = 'error: ' + error.message; }
  }
  return { estimate, persisted, persistRequest };
}

function show(value) { $('output').textContent = JSON.stringify(value, null, 2); }
function setBusy(value) {
  $('run').disabled = value;
  $('integrity').disabled = value;
}

$('run').addEventListener('click', async () => {
  setBusy(true);
  $('status').textContent = '正在运行…';
  const adapter = $('adapter').value;
  const count = Number($('count').value);
  const datasetId = 'dataset-' + crypto.randomUUID();
  try {
    const result = adapter === 'indexeddb'
      ? await runIndexedDb(count, datasetId)
      : await runSqlite(count, datasetId);
    result.memory = {
      usedJSHeapSize: performance.memory?.usedJSHeapSize ?? null,
      totalJSHeapSize: performance.memory?.totalJSHeapSize ?? null,
      jsHeapSizeLimit: performance.memory?.jsHeapSizeLimit ?? null
    };
    result.storage = await storageStatus();
    result.browser = { userAgent: navigator.userAgent, crossOriginIsolated: window.crossOriginIsolated };
    show(result);
    $('status').textContent = result.integrity ? '完成：基础写入与查询通过。' : '失败：记录数量不一致。';
    window.lastPocDataset = { adapter, datasetId };
    sessionStorage.setItem('lastPocDataset', JSON.stringify(window.lastPocDataset));
  } catch (error) {
    show({ adapter, datasetId, error: error.message, name: error.name });
    $('status').textContent = '执行失败；请保留错误信息，不要将该用例记为通过。';
  } finally { setBusy(false); }
});

$('integrity').addEventListener('click', async () => {
  const current = window.lastPocDataset;
  if (!current) { $('status').textContent = '请先执行一次写入测试。'; return; }
  setBusy(true);
  try {
    const result = current.adapter === 'indexeddb'
      ? await checkIndexedDb(current.datasetId)
      : await checkSqlite(current.datasetId);
    show(result);
    $('status').textContent = result.integrity ? '完整性检查通过。' : '完整性检查失败。';
  } catch (error) {
    show({ error: error.message });
    $('status').textContent = '完整性检查失败。';
  } finally { setBusy(false); }
});
