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
