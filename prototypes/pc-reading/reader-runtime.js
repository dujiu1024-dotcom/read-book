import { SqliteOpfsRepository } from "../../packages/local-repository-sqlite/src/index.ts";
import { createAgentGenerationTurnRepository } from "../../packages/local-repository-contract/src/index.ts";
import {
  createGenerationClient,
  createGenerationTurnController,
} from "../../packages/agent-adapter/src/index.ts";
import { createHttpGenerationTransport } from "../../packages/agent-adapter/src/http-transport.ts";

function uuid() {
  return crypto.randomUUID();
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " 未配置。");
  return value.trim();
}

export async function createProductionReaderRuntime(config, bookRevision) {
  const datasetId = required(config.localDataSetId, "READ_BOOK_CONFIG.localDataSetId");
  const apiBaseUrl = required(config.generationApiBaseUrl || config.apiBaseUrl, "READ_BOOK_CONFIG.generationApiBaseUrl");
  const getAccessToken = config.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken;
  if (typeof getAccessToken !== "function") throw new Error("缺少登录令牌提供器。");

  const repository = new SqliteOpfsRepository();
  await repository.initialize();

  let thread;
  let readingPosition = null;
  await repository.transaction(datasetId, async (tx) => {
    thread = await tx.getThreadByRevision(bookRevision.bookRevisionId);
    if (!thread) {
      thread = await tx.createThread({
        id: uuid(),
        datasetId,
        bookRevisionId: bookRevision.bookRevisionId,
        createdAt: new Date().toISOString(),
      });
    }
    const snapshot = await tx.createConsistentSnapshot();
    readingPosition = snapshot.readingPositions.find((item) => item.threadId === thread.id) || null;
    if (!readingPosition) {
      readingPosition = {
        threadId: thread.id,
        mainlineNodeId: bookRevision.initialMainlineUnitId,
        displayedNodeId: bookRevision.initialMainlineUnitId,
        viewMode: "mainline",
        currentUnitDiscussed: false,
        updatedAt: new Date().toISOString(),
      };
      await tx.saveReadingPosition(readingPosition);
    }
  });

  const transport = createHttpGenerationTransport({
    baseUrl: apiBaseUrl,
    getAccessToken,
  });
  const client = createGenerationClient(transport);
  const turnRepository = createAgentGenerationTurnRepository(repository, datasetId);
  const controller = createGenerationTurnController(turnRepository, client, datasetId);

  async function loadMessages() {
    return repository.getMessages(datasetId, thread.id);
  }

  async function savePosition(state, units) {
    const current = units[state.mainlineIndex];
    const displayed = state.displayedUnit;
    if (!current || !displayed) return;
    await repository.transaction(datasetId, (tx) => tx.saveReadingPosition({
      threadId: thread.id,
      mainlineNodeId: current.id,
      displayedNodeId: displayed.id,
      viewMode: state.viewMode,
      currentUnitDiscussed: Boolean(state.discussed),
      updatedAt: new Date().toISOString(),
    }));
  }

  async function send(content, unit, callbacks = {}) {
    if (!unit) throw new Error("当前没有可关联的原文单元。");
    const messages = await loadMessages();
    const recentMessages = messages.slice(-12).map(({ message }) => ({
      role: message.role,
      content: message.content,
    }));
    const userMessageId = uuid();
    const assistantMessageId = uuid();
    const clientGenerationId = uuid();
    const idempotencyKey = uuid() + "-" + uuid();
    const sourceReferences = [{
      bookRevisionId: bookRevision.bookRevisionId,
      structureNodeId: unit.id,
      locator: unit.locator,
    }];
    const request = {
      client_generation_id: clientGenerationId,
      thread_id: thread.id,
      book_revision_id: bookRevision.bookRevisionId,
      user_message: { local_message_id: userMessageId, content },
      context: {
        current_source: { structure_node_id: unit.id, excerpt: unit.text },
        recent_messages: recentMessages,
        response_preferences: { language: "zh-CN" },
      },
    };
    return controller.send({
      datasetId,
      userMessage: { id: userMessageId, threadId: thread.id, content },
      assistantMessageId,
      request,
      idempotencyKey,
      sourceReferences,
      onPersisted: callbacks.onPersisted,
      onDelta: callbacks.onDelta,
    });
  }

  async function resumePending(callbacks = {}) {
    return controller.resumePending(async (delivery) => {
      const messages = await repository.getMessages(datasetId, delivery.threadId);
      const user = messages.find((item) => item.message.id === delivery.userMessageId)?.message;
      if (!user) throw new Error("待恢复任务关联的用户消息不存在，已保留本地记录。");
      const source = user.sourceReferences?.[0];
      const unit = bookRevision.units.find((item) => item.id === source?.structureNodeId)
        || bookRevision.units.find((item) => item.id === bookRevision.initialMainlineUnitId);
      if (!unit) throw new Error("无法为待恢复任务重建原文上下文。");
      return {
        client_generation_id: delivery.clientGenerationId,
        thread_id: thread.id,
        book_revision_id: bookRevision.bookRevisionId,
        user_message: { local_message_id: user.id, content: user.content },
        context: {
          current_source: { structure_node_id: unit.id, excerpt: unit.text },
          recent_messages: messages.slice(-12).map(({ message }) => ({ role: message.role, content: message.content })),
          response_preferences: { language: "zh-CN" },
        },
      };
    }, {
      onDelta: callbacks.onDelta,
      onStatus: callbacks.onStatus,
    });
  }

  let backupStatus = {
    label: "备份：未配置",
    detail: "本地数据已保存在浏览器 OPFS。云端加密备份尚未配置；没有上传明文数据。",
  };
  const snapshot = await repository.createConsistentSnapshot(datasetId);
  if (config.encryptedBackupPort && typeof config.encryptedBackupPort.uploadSnapshot === "function") {
    const receipt = await config.encryptedBackupPort.uploadSnapshot(snapshot);
    if (!receipt || typeof receipt.backupId !== "string" || !receipt.backupId.trim()) {
      throw new Error("加密备份服务未返回有效 backupId，不能确认备份成功。");
    }
    const backedUpAt = new Date().toISOString();
    await repository.acknowledgeBackup(datasetId, snapshot.dirtySequence, receipt.backupId, backedUpAt);
    backupStatus = { label: "备份：已完成", detail: "启动前快照已由外部加密备份端确认。" };
  }

  return {
    repository,
    thread,
    readingPosition,
    backupStatus,
    loadMessages,
    savePosition,
    send,
    stop: () => controller.stop(),
    resumePending,
    close: () => repository.close(),
  };
}
