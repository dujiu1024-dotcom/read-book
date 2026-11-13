export async function acquireDatasetWriter(datasetId) {
  if (!navigator.locks?.request) {
    return { mode: 'readonly', reason: 'Web Locks API unavailable', release() {}, close() {} };
  }
  const channel = typeof BroadcastChannel === 'function'
    ? new BroadcastChannel('read-book-poc-a:' + datasetId)
    : null;
  let resolveRelease;
  let announce;
  const acquired = new Promise((resolve) => { announce = resolve; });
  const lockTask = navigator.locks.request(
    'read-book-poc-a:' + datasetId,
    { mode: 'exclusive', ifAvailable: true },
    async (lock) => {
      if (!lock) {
        announce(null);
        channel?.postMessage({ type: 'writer-unavailable', datasetId });
        return;
      }
      const hold = new Promise((resolve) => { resolveRelease = resolve; });
      announce({
        mode: 'writer',
        release() {
          channel?.postMessage({ type: 'writer-released', datasetId });
          resolveRelease();
        },
        close() { channel?.close(); }
      });
      channel?.postMessage({ type: 'writer-acquired', datasetId });
      await hold;
    }
  );
  lockTask.catch((error) => {
    if (!resolveRelease) announce({ mode: 'readonly', reason: error.message, release() {}, close() {} });
  });
  return (await acquired) || {
    mode: 'readonly',
    reason: 'Another tab owns the dataset writer lock',
    release() {},
    close() { channel?.close(); }
  };
}


export async function withDatasetWriter(datasetId, operation) {
  if (!navigator.locks?.request) {
    // Keep the adapter runnable for compatibility measurement, but report that
    // this browser cannot enforce the single-writer guarantee.
    return { result: await operation(), coordination: 'unsupported' };
  }
  const lease = await acquireDatasetWriter(datasetId);
  if (lease.mode !== 'writer') {
    lease.close();
    throw new Error('当前标签页未获得数据集写锁，已阻止写入并降级只读：' + lease.reason);
  }
  try {
    return { result: await operation(), coordination: 'web-locks-single-writer' };
  } finally {
    lease.release();
    lease.close();
  }
}
