import { SqliteOpfsRepository } from "../../packages/local-repository-sqlite/src/index.ts";
import { createAgentGenerationTurnRepository } from "../../packages/local-repository-contract/src/index.ts";
import {
  createGenerationClient,
  createGenerationTurnController,
} from "../../packages/agent-adapter/src/index.ts";
import { createHttpGenerationTransport } from "../../packages/agent-adapter/src/http-transport.ts";
import { createHttpEncryptedBackupPort } from "../../poc/encrypted-backup/src/http-backup-port.js";
import { runMemoryExtraction, persistAcceptedMemoryCandidates } from "../../packages/agent-adapter/src/memory-extraction.ts";

function uuid() {
  return crypto.randomUUID();
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " 未配置。");
  return value.trim();
}

function getOrCreateLocalDataSetId() {
  const key = "read-book:local-dataset-id";
  try {
    const existing = window.localStorage.getItem(key);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(key, created);
    return created;
  } catch {
    throw new Error("无法持久化本地数据集标识；请允许当前站点使用本地存储后重试。");
  }
}

export async function createProductionReaderRuntime(config, bookRevision) {
  const localOnly = config.localOnly === true;
  let datasetId = required(config.localDataSetId || (localOnly ? getOrCreateLocalDataSetId() : ""), "READ_BOOK_CONFIG.localDataSetId");
  const getAccessToken = config.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken;
  const generationApiBaseUrl = config.generationApiBaseUrl || config.apiBaseUrl;
  if (!localOnly && typeof getAccessToken !== "function") throw new Error("缺少登录令牌提供器。");
  if (!localOnly && (typeof generationApiBaseUrl !== "string" || !generationApiBaseUrl.trim())) {
    throw new Error("缺少生成服务地址，请配置 READ_BOOK_CONFIG.generationApiBaseUrl（或复用 apiBaseUrl）。");
  }

  const repository = new SqliteOpfsRepository();
  await repository.initialize();
  const makeBackupPort = (targetDatasetId) => {
    if (typeof config.createEncryptedBackupPort === "function") return config.createEncryptedBackupPort(targetDatasetId);
    if (config.encryptedBackupPort && targetDatasetId === config.localDataSetId) return config.encryptedBackupPort;
    return createHttpEncryptedBackupPort({
      baseUrl: config.apiBaseUrl,
      datasetId: targetDatasetId,
      getAccessToken,
      onRecoveryCredential: config.onRecoveryCredential,
      keyStore: config.backupKeyStore,
      kdfIterations: config.backupKdfIterations,
      chunkBytes: config.backupChunkBytes,
      checkpointInterval: config.backupCheckpointInterval,
    });
  };
  let encryptedBackupPort = localOnly ? null : makeBackupPort(datasetId);
  let backupStatus = localOnly
    ? { label: "备份：未配置", detail: "当前仅使用本地阅读模式；配置加密备份服务后可启用云端备份。" }
    : { label: "备份：检查中", detail: "正在检查本地数据与云端备份状态。" };

  let initialSnapshot = await repository.createConsistentSnapshot(datasetId);
  const hasLocalData = initialSnapshot.threads.length > 0 || initialSnapshot.messages.length > 0 || initialSnapshot.dirtySequence > 0;
  if (!localOnly && !hasLocalData) {
    if (typeof encryptedBackupPort.listBackups !== "function") {
      throw new Error("新设备首次打开必须支持查询云端备份清单，不能在未知远端状态下直接创建新数据。");
    }
    const remoteBackups = await encryptedBackupPort.listBackups();
    if (remoteBackups.length) {
      const shouldRestore = typeof config.confirmRestore === "function"
        ? await config.confirmRestore({ datasetId, backups: remoteBackups })
        : window.confirm("检测到该数据集已有 " + remoteBackups.length + " 份云端备份。是否恢复阅读记录和认知数据？");
      if (shouldRestore) {
        const recoveryCredential = typeof config.getRecoveryCredential === "function"
          ? await config.getRecoveryCredential()
          : window.prompt("请输入独立恢复凭证。该凭证只用于本地解密，不会发送给服务器。");
        if (!recoveryCredential) throw new Error("恢复已取消；为避免误建空数据，暂不打开此数据集。");
        if (typeof encryptedBackupPort.restoreToRepository !== "function") {
          throw new Error("当前备份端口不支持将备份恢复到本地 Repository。");
        }
        await encryptedBackupPort.restoreToRepository(repository, recoveryCredential);
        initialSnapshot = await repository.createConsistentSnapshot(datasetId);
        backupStatus = { label: "备份：已恢复", detail: "已从云端备份恢复本地数据和设备密钥。" };
      } else {
        if (typeof config.createNewDataSet !== "function") {
          throw new Error("已选择不恢复。要开始全新数据集，宿主必须先创建新的数据集 ID；不会覆盖原有云端备份。");
        }
        const newDatasetId = required(await config.createNewDataSet({ previousDatasetId: datasetId }), "createNewDataSet result");
        if (newDatasetId === datasetId) throw new Error("全新数据集必须使用新的 datasetId。");
        datasetId = newDatasetId;
        encryptedBackupPort = makeBackupPort(datasetId);
        initialSnapshot = await repository.createConsistentSnapshot(datasetId);
      }
    }
  }

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

  let controller = null;
  if (!localOnly) {
    const transport = createHttpGenerationTransport({
      baseUrl: generationApiBaseUrl,
      getAccessToken,
    });
    const client = createGenerationClient(transport);
    const turnRepository = createAgentGenerationTurnRepository(repository, datasetId);
    controller = createGenerationTurnController(turnRepository, client, datasetId);
  }

  async function loadMessages() {
    return repository.getMessages(datasetId, thread.id);
  }

  async function loadMemoryState() {
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    return {
      memories: snapshot.memories.filter((item) => item.threadId === thread.id),
      versions: snapshot.memoryVersions,
      relations: snapshot.memoryRelations,
      pendingCandidates: snapshot.memoryCandidates.filter((item) => item.threadId === thread.id),
      providerConfigured: Boolean(config.memoryExtractionProvider && config.memoryCandidatePolicy),
      plannerConfigured: typeof config.planMemoryEvolution === "function",
    };
  }

  async function extractMemories() {
    if (!config.memoryExtractionProvider || !config.memoryCandidatePolicy) {
      return { ...(await loadMemoryState()), extractionStatus: "provider_not_configured", persistedIds: [], acceptedNotPersisted: [] };
    }
    const persisted = await loadMessages();
    const eligible = persisted
      .map((item) => item.message)
      .filter((message) => message.content?.trim() && (message.role === "user" || message.status === "completed"))
      .slice(-40);
    const userMessages = eligible.filter((message) => message.role === "user");
    if (!userMessages.length) return { ...(await loadMemoryState()), extractionStatus: "no_user_messages", persistedIds: [], acceptedNotPersisted: [] };
    const context = {
      threadId: thread.id,
      bookRevisionId: bookRevision.bookRevisionId,
      availableMessageIds: eligible.map((message) => message.id),
      availableUserMessageIds: userMessages.map((message) => message.id),
      availableStructureNodeIds: bookRevision.units.map((unit) => unit.id),
    };
    const result = await runMemoryExtraction(config.memoryExtractionProvider, {
      context,
      messages: eligible.map((message) => ({ id: message.id, role: message.role, content: message.content })),
      policy: config.memoryCandidatePolicy,
      modelVersion: config.memoryModelVersion || "configured-provider",
    });
    const now = new Date().toISOString();
    if (result.needsConfirmation.length) {
      await repository.transaction(datasetId, async (tx) => {
        for (const item of result.needsConfirmation) {
          await tx.saveMemoryCandidate({
            id: item.candidate.id,
            datasetId,
            threadId: thread.id,
            candidate: item.candidate,
            evaluationScore: item.evaluation.score,
            status: "needs_confirmation",
            createdAt: now,
            updatedAt: now,
          });
        }
      });
    }
    let persistedIds = [];
    if (result.accepted.length && typeof config.planMemoryEvolution === "function") {
      const existing = await repository.createConsistentSnapshot(datasetId);
      const plans = await config.planMemoryEvolution({
        accepted: result.accepted,
        existingMemories: existing.memories.filter((item) => item.threadId === thread.id),
        existingVersions: existing.memoryVersions,
        existingRelations: existing.memoryRelations,
        threadId: thread.id,
        bookRevisionId: bookRevision.bookRevisionId,
      });
      persistedIds = await persistAcceptedMemoryCandidates(repository, datasetId, result, plans);
    }
    const state = await loadMemoryState();
    return {
      ...state,
      extractionStatus: "completed",
      persistedIds,
      acceptedNotPersisted: result.accepted.filter((item) => !persistedIds.includes(item.candidate.id)),
      needsConfirmation: result.needsConfirmation,
      rejectedCount: result.rejected.length,
    };
  }

  async function resolveMemoryCandidate(candidateId, resolution) {
    const pending = await repository.getMemoryCandidates(datasetId, thread.id);
    const record = pending.find((item) => item.id === candidateId);
    if (!record) throw new Error("这条待确认认知已不存在或已经处理。");
    if (resolution === "rejected") {
      await repository.transaction(datasetId, (tx) => tx.resolveMemoryCandidate(candidateId, "rejected", new Date().toISOString()));
      return loadMemoryState();
    }
    if (resolution !== "accepted") throw new Error("未知的认知确认操作。");
    if (typeof config.planMemoryEvolution !== "function") throw new Error("尚未配置认知演变规划器，不能安全确认并写入。");
    const existing = await repository.createConsistentSnapshot(datasetId);
    const acceptedItem = {
      candidate: record.candidate,
      evaluation: { decision: "accept", score: record.evaluationScore, reasons: ["user_confirmed"] },
    };
    const extractionResult = {
      modelVersion: "user-confirmed",
      accepted: [acceptedItem],
      needsConfirmation: [],
      rejected: [],
    };
    const plans = await config.planMemoryEvolution({
      accepted: [acceptedItem],
      existingMemories: existing.memories.filter((item) => item.threadId === thread.id),
      existingVersions: existing.memoryVersions,
      existingRelations: existing.memoryRelations,
      threadId: thread.id,
      bookRevisionId: bookRevision.bookRevisionId,
      userConfirmedCandidateId: candidateId,
    });
    if (!Array.isArray(plans) || plans.length !== 1) throw new Error("演变规划器必须为已确认候选返回且仅返回一个版本计划。");
    await persistAcceptedMemoryCandidates(repository, datasetId, extractionResult, [{
      ...plans[0],
      candidateId: record.candidate.id,
      resolveCandidateId: record.id,
    }]);
    return loadMemoryState();
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

  function createSourceBundle(currentUnit, additionalUnits = []) {
    const canonicalCurrent = bookRevision.units.find((item) => item.id === currentUnit?.id);
    if (!canonicalCurrent) throw new Error("当前原文不属于已加载的 BookRevision。");
    const selected = [canonicalCurrent];
    const seen = new Set([canonicalCurrent.id]);
    for (const candidate of Array.isArray(additionalUnits) ? additionalUnits : []) {
      if (selected.length > 8) break;
      const unit = bookRevision.units.find((item) => item.id === candidate?.id);
      if (!unit || seen.has(unit.id) || !unit.locator || typeof unit.text !== "string") continue;
      seen.add(unit.id);
      selected.push(unit);
    }
    let remainingCharacters = 120000;
    const sources = selected.map((item, index) => {
      const excerpt = item.text.slice(0, Math.min(30000, remainingCharacters));
      remainingCharacters -= excerpt.length;
      return {
        unit: item,
        source: {
          structure_node_id: item.id,
          locator: item.locator,
          excerpt,
        },
      };
    }).filter((item) => item.source.excerpt.trim());
    const current = sources[0];
    if (!current) throw new Error("当前原文没有可用于引用核验的内容。");
    return {
      units: sources.map((item) => item.unit),
      current_source: current.source,
      additional_sources: sources.slice(1).map((item) => item.source),
    };
  }

  function createSourceBundleFromReferences(references) {
    const refs = Array.isArray(references) ? references : [];
    const currentReference = refs[0];
    if (!currentReference || currentReference.bookRevisionId !== bookRevision.bookRevisionId) {
      throw new Error("原始消息缺少当前书籍版本的来源引用。");
    }
    const currentUnit = bookRevision.units.find((item) =>
      item.id === currentReference.structureNodeId && item.locator === currentReference.locator);
    if (!currentUnit) throw new Error("原始消息关联的主来源原文已不可用。");
    const additionalUnits = refs.slice(1).map((reference) => {
      if (reference.bookRevisionId !== bookRevision.bookRevisionId) return null;
      return bookRevision.units.find((item) =>
        item.id === reference.structureNodeId && item.locator === reference.locator) || null;
    }).filter(Boolean);
    return createSourceBundle(currentUnit, additionalUnits);
  }

  async function loadCitations() {
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    return snapshot.citations.filter((item) => item.threadId === thread.id);
  }

  async function send(content, unit, callbacks = {}) {
    if (!controller) throw new Error("真实 Agent 服务尚未配置；当前仅支持本地阅读与历史查看。");
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
    const sourceBundle = createSourceBundle(unit, callbacks.additionalUnits);
    const sourceReferences = sourceBundle.units.map((sourceUnit) => ({
      bookRevisionId: bookRevision.bookRevisionId,
      structureNodeId: sourceUnit.id,
      locator: sourceUnit.locator,
    }));
    const request = {
      client_generation_id: clientGenerationId,
      thread_id: thread.id,
      book_revision_id: bookRevision.bookRevisionId,
      user_message: { local_message_id: userMessageId, content },
      context: {
        current_source: sourceBundle.current_source,
        ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
        recent_messages: recentMessages,
        response_preferences: { language: "zh-CN" },
      },
    };
    const result = await controller.send({
      datasetId,
      userMessage: { id: userMessageId, threadId: thread.id, content },
      assistantMessageId,
      request,
      idempotencyKey,
      sourceReferences,
      onPersisted: callbacks.onPersisted,
      onDelta: callbacks.onDelta,
    });
    if (config.memoryExtractionProvider && config.memoryCandidatePolicy) {
      void extractMemories().then((memoryState) => callbacks.onMemoryUpdate?.(memoryState)).catch((error) => callbacks.onMemoryError?.(error));
    }
    return result;
  }

  async function retryFailedGeneration(assistantMessageId, callbacks = {}) {
    if (!controller) throw new Error("真实 Agent 服务尚未配置；当前无法重试生成。");
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    const delivery = snapshot.generationDeliveries.find((item) => item.assistantMessageId === assistantMessageId);
    if (!delivery || !["failed", "expired", "cancelled"].includes(delivery.status)) {
      throw new Error("找不到可重试的失败生成记录。");
    }
    const messages = await loadMessages();
    const user = messages.find((item) => item.message.id === delivery.userMessageId)?.message;
    if (!user) throw new Error("原始用户消息不存在，不能重试。");
    const sourceBundle = createSourceBundleFromReferences(user.sourceReferences);
    const unit = sourceBundle.units[0];
    const priorMessages = messages
      .filter((item) => item.message.sequence < user.sequence)
      .slice(-12)
      .map(({ message }) => ({ role: message.role, content: message.content }));
    const userMessageId = user.id;
    const clientGenerationId = uuid();
    const idempotencyKey = uuid() + "-" + uuid();
    const request = {
      client_generation_id: clientGenerationId,
      thread_id: thread.id,
      book_revision_id: bookRevision.bookRevisionId,
      user_message: { local_message_id: userMessageId, content: user.content },
      context: {
        current_source: sourceBundle.current_source,
        ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
        recent_messages: priorMessages,
        response_preferences: { language: "zh-CN" },
      },
    };
    const result = await controller.send({
      datasetId,
      userMessage: { id: user.id, threadId: thread.id, content: user.content },
      assistantMessageId: uuid(),
      request,
      idempotencyKey,
      sourceReferences: sourceBundle.units.map((sourceUnit) => ({
        bookRevisionId: bookRevision.bookRevisionId,
        structureNodeId: sourceUnit.id,
        locator: sourceUnit.locator,
      })),
      reuseExistingUserMessage: true,
      onPersisted: callbacks.onPersisted,
      onDelta: callbacks.onDelta,
    });
    if (config.memoryExtractionProvider && config.memoryCandidatePolicy) {
      void extractMemories().then((memoryState) => callbacks.onMemoryUpdate?.(memoryState)).catch((error) => callbacks.onMemoryError?.(error));
    }
    return result;
  }

  async function resumePending(callbacks = {}) {
    if (!controller) return [];
    const results = await controller.resumePending(async (delivery) => {
      const messages = await repository.getMessages(datasetId, delivery.threadId);
      const user = messages.find((item) => item.message.id === delivery.userMessageId)?.message;
      if (!user) throw new Error("待恢复任务关联的用户消息不存在，已保留本地记录。");
      const sourceBundle = createSourceBundleFromReferences(user.sourceReferences);
      const unit = sourceBundle.units[0];
      return {
        client_generation_id: delivery.clientGenerationId,
        thread_id: thread.id,
        book_revision_id: bookRevision.bookRevisionId,
        user_message: { local_message_id: user.id, content: user.content },
        context: {
          current_source: sourceBundle.current_source,
          ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
          recent_messages: messages.slice(-12).map(({ message }) => ({ role: message.role, content: message.content })),
          response_preferences: { language: "zh-CN" },
        },
      };
    }, {
      onDelta: callbacks.onDelta,
      onStatus: callbacks.onStatus,
    });
    if (results.length && config.memoryExtractionProvider && config.memoryCandidatePolicy) {
      void extractMemories().then((memoryState) => callbacks.onMemoryUpdate?.(memoryState)).catch((error) => callbacks.onMemoryError?.(error));
    }
    return results;
  }

  const snapshot = await repository.createConsistentSnapshot(datasetId);
  if (!localOnly && encryptedBackupPort && typeof encryptedBackupPort.uploadSnapshot === "function") {
    try {
      const receipt = await encryptedBackupPort.uploadSnapshot(snapshot);
      if (!receipt || typeof receipt.backupId !== "string" || !receipt.backupId.trim()) {
        throw new Error("加密备份服务未返回有效 backupId，不能确认备份成功。");
      }
      const backedUpAt = new Date().toISOString();
      await repository.acknowledgeBackup(datasetId, snapshot.dirtySequence, receipt.backupId, backedUpAt);
      backupStatus = { label: "备份：已完成", detail: "启动前快照已由远端加密备份端确认。" };
    } catch (error) {
      backupStatus = { label: "备份：失败", detail: "启动前加密备份失败，数据仍保留在本地，未确认备份序号：" + error.message };
    }
  }

  return {
    repository,
    thread,
    readingPosition,
    backupStatus,
    generationConfigured: Boolean(controller),
    loadMessages,
    loadCitations,
    loadMemoryState,
    extractMemories,
    resolveMemoryCandidate,
    savePosition,
    send,
    retryFailedGeneration,
    stop: () => controller?.stop(),
    resumePending,
    close: () => repository.close(),
  };
}
