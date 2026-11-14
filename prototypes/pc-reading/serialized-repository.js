/**
 * 同一标签页内多个 Repository 实例共享的写事务队列。
 *
 * SqliteOpfsRepository 的 transaction()/createConsistentSnapshot()/restoreSnapshot()
 * 都以 navigator.locks 的 ifAvailable 模式申请数据集写锁：同一标签页里只要有一个写
 * 事务尚未结束，第二个写事务会立刻拿到 null 并抛 WRITER_LOCK_UNAVAILABLE。
 * 阅读界面里 fire-and-forget 的 savePosition 与 renderSource/refreshNotes 等原因
 * 会产生并发写，所以这里从结构上把写操作串成一条队列：无论谁先调用，都排队执行，
 * 不会出现“第二个写锁立即失败”的情况。
 *
 * 队列放在模块级（全局共享），而不是每个实例各自排队：运行时可能同时存在多个
 * Repository 实例（正式运行时与本地语料降级运行时），它们争用的是同一把浏览器写锁，
 * 必须共享同一个队列才安全。写事务本身很短，串行化的代价可以接受。
 */

const queues = new Map();

function enqueue(key, task) {
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.catch(() => undefined).then(task);
  const tail = result.catch(() => undefined);
  queues.set(key, tail);
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
  return result;
}

const SERIALIZED_METHODS = new Set([
  "transaction",
  "createConsistentSnapshot",
  "restoreSnapshot",
  "acknowledgeBackup",
  "close",
]);

/**
 * 用共享写队列包装一个 Repository 实例。
 * @template T
 * @param {() => T} factory 创建底层 Repository 的工厂
 * @returns {T}
 */
export function createSerializedRepository(factory) {
  const repository = factory();
  return new Proxy(repository, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function") return value;
      if (!SERIALIZED_METHODS.has(property)) return value.bind(target);
      return (...args) => enqueue("repository-writes", () => value.apply(target, args));
    },
  });
}
