import { SqliteOpfsRepository } from "../../packages/local-repository-sqlite/src/index.ts";
import { createSerializedRepository } from "./serialized-repository.js";
import { createAgentGenerationTurnRepository } from "../../packages/local-repository-contract/src/index.ts";
import {
  createGenerationClient,
  createGenerationTurnController,
  withRelevantMemory,
} from "../../packages/agent-adapter/src/index.ts";
import { createHttpGenerationTransport } from "../../packages/agent-adapter/src/http-transport.ts";
import { createHttpEncryptedBackupPort } from "../../poc/encrypted-backup/src/http-backup-port.js";
import { runMemoryExtraction, persistAcceptedMemoryCandidates } from "../../packages/agent-adapter/src/memory-extraction.ts";
import { selectThreadMemoryState } from "./memory-thread-scope.js";
import { hasEncryptedBackupService } from "./reader-capabilities.js";
import { planPromptBudget } from "./book-retrieval.js";
import { createBookRetriever, createEmbeddingClient } from "./retrieval-runtime.js";

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

  // 写事务统一排队，避免同标签页内 fire-and-forget 写入与初始化流程争抢写锁。
  const repository = createSerializedRepository(() => new SqliteOpfsRepository());
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
  const backupConfigured = !localOnly && hasEncryptedBackupService(config);
  let encryptedBackupPort = backupConfigured ? makeBackupPort(datasetId) : null;
  let backupStatus = !backupConfigured
    ? {
        label: "备份：未配置",
        detail: localOnly
          ? "当前仅使用本地阅读模式；配置加密备份服务后可启用云端备份。"
          : "Agent 与本地阅读可用；尚未配置加密备份服务，私人数据仅保存在本地。",
      }
    : { label: "备份：检查中", detail: "正在检查本地数据与云端备份状态。" };

  let initialSnapshot = await repository.createConsistentSnapshot(datasetId);
  const hasLocalData = initialSnapshot.threads.length > 0 || initialSnapshot.messages.length > 0 || initialSnapshot.dirtySequence > 0;
  if (backupConfigured && encryptedBackupPort && !hasLocalData) {
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

  // 全书检索：向量服务经本地宿主代理，浏览器不直连 Ollama。
  const embeddingBaseUrl = config.embeddingApiBaseUrl || generationApiBaseUrl || config.memoryProxyUrl || "";
  const embeddingClient = config.embeddingClient || (
    typeof getAccessToken === "function" && embeddingBaseUrl
      ? createEmbeddingClient({
          baseUrl: embeddingBaseUrl,
          getAccessToken,
          model: config.embeddingModel || "bge-m3",
        })
      : null
  );
  const retriever = createBookRetriever({
    repository,
    datasetId,
    bookRevision,
    embeddingClient,
    onStatus: (status) => config.onRetrievalStatus?.(status),
  });
  // 老库没有索引时惰性补齐；向量化在后台进行，不阻塞阅读。
  if (controller) {
    void retriever.ensureIndex().catch((error) => {
      console.warn("[retrieval] ensureIndex failed", error);
      config.onRetrievalStatus?.({
        ready: false,
        phase: "error",
        chunkCount: 0,
        error: String(error?.message || error),
      });
    });
  }

  async function loadMessages() {
    return repository.getMessages(datasetId, thread.id);
  }

  async function loadMemoryState() {
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    const memoryState = selectThreadMemoryState(snapshot, thread.id);
    const sourceMessageIds = new Set([
      ...memoryState.versions.flatMap((version) => version.sourceMessageIds || []),
      ...memoryState.pendingCandidates.flatMap((record) => record.candidate?.sourceMessageIds || []),
    ]);
    const sourceMessages = sourceMessageIds.size
      ? (await loadMessages())
          .filter(({ message }) => sourceMessageIds.has(message.id))
          .map(({ message }) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
          }))
      : [];
    return {
      ...memoryState,
      sourceMessages,
      providerConfigured: Boolean(config.memoryExtractionProvider && config.memoryCandidatePolicy),
      plannerConfigured: typeof config.planMemoryEvolution === "function",
    };
  }

  let extractionInFlight = null;

  function extractMemories() {
    if (extractionInFlight) return extractionInFlight;
    extractionInFlight = runMemoryExtractionPass().finally(() => { extractionInFlight = null; });
    return extractionInFlight;
  }

  async function runMemoryExtractionPass() {
    if (!config.memoryExtractionProvider || !config.memoryCandidatePolicy) {
      return { ...(await loadMemoryState()), extractionStatus: "provider_not_configured", persistedIds: [], acceptedNotPersisted: [] };
    }
    const persisted = await loadMessages();
    const eligible = persisted
      .map((item) => item.message)
      .filter((message) => message.content?.trim() && (message.role === "user" || message.status === "completed"))
      // 记忆抽取接口只接受 1–30 条消息，超出会被整批拒绝。
      .slice(-30);
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
      const existing = selectThreadMemoryState(
        await repository.createConsistentSnapshot(datasetId),
        thread.id,
      );
      const plans = await config.planMemoryEvolution({
        accepted: result.accepted,
        existingMemories: existing.memories,
        existingVersions: existing.versions,
        existingRelations: existing.relations,
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
    const existing = selectThreadMemoryState(
      await repository.createConsistentSnapshot(datasetId),
      thread.id,
    );
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
      existingMemories: existing.memories,
      existingVersions: existing.versions,
      existingRelations: existing.relations,
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

  function chunkIdForUnit(unitId, excerpt = "") {
    const candidates = (retriever.getChunks() || []).filter((chunk) => chunk.structureNodeId === unitId);
    if (!candidates.length) return null;
    if (!excerpt) return candidates[0].id;
    // 只有切片内容确实落在本次引用的原文里，才把该切片 id 挂上去，避免“真实 id + 不相干切片”。
    const normalizedExcerpt = String(excerpt).replace(/\s+/g, "");
    const matched = candidates.find((chunk) =>
      normalizedExcerpt.includes(chunk.text.replace(/\s+/g, "").slice(0, 60)));
    return (matched || candidates[0]).id;
  }

  /**
   * 组织一次性生成的原文来源。
   * - currentExcerpt 允许预算层按句末截断当前段；
   * - passages 是全书检索命中的真实切片，chunk_id 必须随请求发给服务端，
   *   这样落库的引用才是真实切片 id，而不是服务端临时派生的哈希。
   */
  function createSourceBundle(currentUnit, options = {}) {
    const canonicalCurrent = bookRevision.units.find((item) => item.id === currentUnit?.id);
    if (!canonicalCurrent) throw new Error("当前原文不属于已加载的 BookRevision。");
    const seen = new Set([canonicalCurrent.id + ":" + canonicalCurrent.locator]);
    const currentExcerpt = typeof options.currentExcerpt === "string" && options.currentExcerpt.trim()
      ? options.currentExcerpt
      : canonicalCurrent.text;
    const currentChunkId = chunkIdForUnit(canonicalCurrent.id, currentExcerpt);
    const sources = [{
      unit: canonicalCurrent,
      source: {
        structure_node_id: canonicalCurrent.id,
        locator: canonicalCurrent.locator,
        excerpt: currentExcerpt.slice(0, 30000),
        ...(currentChunkId ? { chunk_id: currentChunkId } : {}),
      },
    }];
    for (const passage of Array.isArray(options.passages) ? options.passages : []) {
      if (sources.length >= 8) break;
      const chunk = passage?.chunk;
      if (!chunk || typeof chunk.structureNodeId !== "string") continue;
      const key = chunk.structureNodeId + ":" + chunk.locator;
      if (seen.has(key)) continue;
      seen.add(key);
      const unit = bookRevision.units.find((item) => item.id === chunk.structureNodeId);
      const excerpt = String(passage.excerpt || chunk.text || "").trim();
      if (!excerpt) continue;
      sources.push({
        unit: unit || { id: chunk.structureNodeId, locator: chunk.locator, text: chunk.text, chapter: chunk.chapter },
        source: {
          structure_node_id: chunk.structureNodeId,
          locator: chunk.locator,
          excerpt: excerpt.slice(0, 30000),
          chunk_id: chunk.id,
        },
      });
    }
    for (const candidate of Array.isArray(options.additionalUnits) ? options.additionalUnits : []) {
      if (sources.length >= 8) break;
      const unit = bookRevision.units.find((item) => item.id === candidate?.id);
      if (!unit || !unit.locator || typeof unit.text !== "string") continue;
      const key = unit.id + ":" + unit.locator;
      if (seen.has(key)) continue;
      seen.add(key);
      const chunkId = chunkIdForUnit(unit.id, unit.text);
      sources.push({
        unit,
        source: {
          structure_node_id: unit.id,
          locator: unit.locator,
          excerpt: unit.text.slice(0, 30000),
          ...(chunkId ? { chunk_id: chunkId } : {}),
        },
      });
    }
    const current = sources[0];
    if (!current || !current.source.excerpt.trim()) throw new Error("当前原文没有可用于引用核验的内容。");
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
    return createSourceBundle(currentUnit, { additionalUnits });
  }

  async function loadCitations() {
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    return snapshot.citations.filter((item) => item.threadId === thread.id);
  }

  /**
   * 记忆召回接到真实请求上：优先按当前段召回，不足 5 条时用最近认知补齐。
   * 只发送有效的当前版本，并按预算截断，绝不把整份记忆档案塞进 prompt。
   */
  async function recallRelevantMemories(unitId) {
    if (typeof repository.recallMemoryVersions !== "function") return [];
    const seen = new Set();
    const versions = [];
    const collect = async (query) => {
      let records = [];
      try { records = await repository.recallMemoryVersions(datasetId, query); } catch { records = []; }
      for (const record of records) {
        if (!record?.id || seen.has(record.id)) continue;
        seen.add(record.id);
        versions.push(record);
        if (versions.length >= 5) break;
      }
    };
    if (unitId) await collect({ threadId: thread.id, structureNodeId: unitId, limit: 5 });
    if (versions.length < 5) await collect({ threadId: thread.id, limit: 5 - versions.length });
    return versions.map((version) => ({
      memory_id: version.memoryId,
      version_id: version.id,
      title: version.title || "长期认知",
      viewpoint: version.viewpoint || "user",
      content: version.content,
      change_kind: version.changeKind || "new",
    }));
  }

  function attachMemory(request, memories) {
    if (!memories.length) return request;
    try {
      return withRelevantMemory(request, memories);
    } catch {
      // 记忆只是辅助证据，格式不合法时宁可不带，也不阻断本轮回答。
      return request;
    }
  }

  /**
   * 检索摘要随消息保存，刷新后仍能重现“命中 N 段 / 带入 M 段”。
   * 它是可重建的界面元数据，不写 backup journal。
   */
  async function persistRetrievalSummary(assistantMessageId, userContent, retrieval) {
    if (!assistantMessageId || typeof repository.saveMessageRetrieval !== "function") return;
    const passages = (retrieval.passages || []).map((passage) => ({
      chunk: {
        id: passage.chunk.id,
        structureNodeId: passage.chunk.structureNodeId,
        locator: passage.chunk.locator,
        chapter: passage.chunk.chapter,
        title: passage.chunk.title,
      },
      excerpt: passage.excerpt,
      truncated: Boolean(passage.truncated),
      score: Number(passage.score || 0),
    }));
    try {
      await repository.saveMessageRetrieval(datasetId, {
        messageId: assistantMessageId,
        threadId: thread.id,
        query: userContent,
        scope: retrieval.scope?.mode || (retrieval.hasEvidence ? "book" : "none"),
        hasEvidence: Boolean(retrieval.hasEvidence),
        hitCount: Number(retrieval.hitCount ?? retrieval.hits?.length ?? 0),
        includedCount: passages.length,
        keywordCount: Number(retrieval.keywordCount || 0),
        vectorTopScore: Number(retrieval.vectorTopScore || 0),
        omitted: Number(retrieval.omitted || 0),
        notice: retrieval.notice || null,
        budgetNotices: Array.isArray(retrieval.budgetNotices) ? retrieval.budgetNotices : [],
        passages,
      });
    } catch (error) {
      console.warn("[retrieval] 检索摘要保存失败", error);
    }
  }

  async function loadMessageRetrieval() {
    if (typeof repository.listMessageRetrieval !== "function") return new Map();
    const records = await repository.listMessageRetrieval(datasetId, thread.id);
    return new Map(records.map((record) => [record.messageId, record]));
  }

  /**
   * 全书检索无命中时，不调用模型：直接落一条“书里没找到”的明确回答。
   * 这样不会让模型用先验知识硬答。
   */
  async function persistNoEvidenceAnswer(content, unit, retrieval) {
    const userId = uuid();
    const assistantId = uuid();
    const now = new Date().toISOString();
    const references = unit
      ? [{ bookRevisionId: bookRevision.bookRevisionId, structureNodeId: unit.id, locator: unit.locator }]
      : [];
    const notice = retrieval.notice ? "（" + retrieval.notice + "）" : "";
    const answer = "我在《" + bookRevision.title + "》全书中没有检索到与这个问题相关的原文段落。" +
      "为避免脱离原文作答，本轮不给出推测性回答。可以换一个更贴近书中概念的关键词，或先在当前段确认讨论范围。" + notice;
    await repository.transaction(datasetId, async (tx) => {
      await tx.appendUserMessage({
        id: userId,
        threadId: thread.id,
        content,
        createdAt: now,
        sourceReferences: references,
        idempotencyKey: uuid() + "-" + uuid(),
      });
      await tx.appendAssistantMessage({
        id: assistantId,
        threadId: thread.id,
        content: answer,
        status: "completed",
        createdAt: new Date().toISOString(),
        sourceReferences: [],
      });
    });
    await persistRetrievalSummary(assistantId, content, retrieval);
    return {
      assistantMessageId: assistantId,
      snapshot: { status: "completed", result: { content: answer, citations: [] } },
      retrieval: { ...retrieval, noEvidence: true },
    };
  }

  async function send(content, unit, callbacks = {}) {
    if (!controller) throw new Error("真实 Agent 服务尚未配置；当前仅支持本地阅读与历史查看。");
    if (!unit) throw new Error("当前没有可关联的原文单元。");
    const messages = await loadMessages();
    // 默认先做一次全书检索，再由证据强度决定：全书 / 当前段 / 书里没有。
    let retrieval = await retriever.search(content, { limit: 8, currentUnit: unit });
    callbacks.onRetrieval?.(retrieval);
    if (retrieval.scope?.mode === "none") {
      const result = await persistNoEvidenceAnswer(content, unit, retrieval);
      callbacks.onPersisted?.();
      return result;
    }
    const includePassages = retrieval.scope?.mode === "book" ? (retrieval.passages || []) : [];
    const recentMessages = messages.slice(-12).map(({ message }) => ({
      role: message.role,
      content: message.content,
    }));
    const memories = await recallRelevantMemories(unit.id);
    const budget = planPromptBudget({
      currentUnit: unit,
      passages: includePassages,
      messages: recentMessages,
      memories,
    });
    retrieval = { ...retrieval, budgetNotices: budget.notices, passages: budget.passages };
    callbacks.onRetrieval?.(retrieval);
    const userMessageId = uuid();
    const assistantMessageId = uuid();
    const clientGenerationId = uuid();
    const idempotencyKey = uuid() + "-" + uuid();
    const sourceBundle = createSourceBundle(unit, {
      passages: budget.passages,
      additionalUnits: retrieval.scope?.mode === "book" ? [] : callbacks.additionalUnits,
      currentExcerpt: budget.currentExcerpt.text,
    });
    const sourceReferences = sourceBundle.units.map((sourceUnit) => ({
      bookRevisionId: bookRevision.bookRevisionId,
      structureNodeId: sourceUnit.id,
      locator: sourceUnit.locator,
    }));
    const request = attachMemory({
      client_generation_id: clientGenerationId,
      thread_id: thread.id,
      book_revision_id: bookRevision.bookRevisionId,
      user_message: { local_message_id: userMessageId, content },
      context: {
        current_source: sourceBundle.current_source,
        ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
        recent_messages: budget.messages,
        response_preferences: { language: "zh-CN" },
        ...(retrieval ? {
          retrieval: {
            mode: retrieval.scope?.mode || "book",
            scope: retrieval.scope?.reason || "",
            hit_count: retrieval.hitCount ?? retrieval.hits?.length ?? 0,
            keyword_hits: retrieval.keywordCount,
            vector_top_score: Number((retrieval.vectorTopScore || 0).toFixed(4)),
          },
        } : {}),
      },
    }, budget.memories);
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
    await persistRetrievalSummary(result.assistantMessageId, content, retrieval);
    return { ...result, retrieval };
  }

  async function retryFailedGeneration(assistantMessageId, callbacks = {}) {
    if (!controller) throw new Error("真实 Agent 服务尚未配置；当前无法重试生成。");
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    let delivery = snapshot.generationDeliveries.find((item) => item.assistantMessageId === assistantMessageId);
    if (!delivery) throw new Error("找不到这条回复的生成记录，无法重试。");
    if (!["failed", "expired", "cancelled"].includes(delivery.status)) {
      // 刷新/断网/限流可能留下仍处于 queued/running 的投递记录与 generating 消息。
      // 用户显式点“重试”时，若当前没有进行中的生成，就把这条残留标记为失败再重试，
      // 避免消息永久停在“正在生成…”。
      if (!["queued", "running"].includes(delivery.status)) throw new Error("这条回复当前不可重试。");
      if (controller.isBusy()) throw new Error("当前仍有生成任务在进行，请等待结束后再重试。");
      const messages = await loadMessages();
      const assistant = messages.find((item) => item.message.id === assistantMessageId)?.message;
      await repository.transaction(datasetId, async (tx) => {
        if (assistant?.status === "generating") {
          await tx.transitionAssistantMessage(assistantMessageId, "failed");
        }
        await tx.saveGenerationDelivery({ ...delivery, status: "failed", updatedAt: new Date().toISOString() });
      });
      delivery = { ...delivery, status: "failed" };
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
    const memories = await recallRelevantMemories(unit.id);
    const budget = planPromptBudget({
      currentUnit: unit,
      passages: [],
      messages: priorMessages,
      memories,
    });
    const request = attachMemory({
      client_generation_id: clientGenerationId,
      thread_id: thread.id,
      book_revision_id: bookRevision.bookRevisionId,
      user_message: { local_message_id: userMessageId, content: user.content },
      context: {
        current_source: sourceBundle.current_source,
        ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
        recent_messages: budget.messages,
        response_preferences: { language: "zh-CN" },
      },
    }, budget.memories);
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
      if (delivery.threadId !== thread.id) {
        throw new Error("待恢复任务不属于当前书籍 Thread，已阻止跨书籍恢复。");
      }
      const messages = await repository.getMessages(datasetId, delivery.threadId);
      const user = messages.find((item) => item.message.id === delivery.userMessageId)?.message;
      if (!user) throw new Error("待恢复任务关联的用户消息不存在，已保留本地记录。");
      const sourceBundle = createSourceBundleFromReferences(user.sourceReferences);
      if (!sourceBundle.current_source ||
          user.sourceReferences?.[0]?.bookRevisionId !== bookRevision.bookRevisionId) {
        throw new Error("待恢复任务的原文证据不属于当前书籍版本，已阻止错误恢复。");
      }
      const priorMessages = messages
        .filter((item) => item.message.sequence < user.sequence)
        .slice(-12)
        .map(({ message }) => ({ role: message.role, content: message.content }));
      const memories = await recallRelevantMemories(sourceBundle.units[0]?.id);
      const budget = planPromptBudget({
        currentUnit: sourceBundle.units[0],
        passages: [],
        messages: priorMessages,
        memories,
      });
      return attachMemory({
        client_generation_id: delivery.clientGenerationId,
        thread_id: delivery.threadId,
        book_revision_id: bookRevision.bookRevisionId,
        user_message: { local_message_id: user.id, content: user.content },
        context: {
          current_source: sourceBundle.current_source,
          ...(sourceBundle.additional_sources.length ? { additional_sources: sourceBundle.additional_sources } : {}),
          recent_messages: budget.messages,
          response_preferences: { language: "zh-CN" },
        },
      }, budget.memories);
    }, {
      threadId: thread.id,
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

  async function loadNotes() {
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    return (snapshot.notes || [])
      .filter((note) => note.threadId === thread.id)
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  }

  async function createNote({ content, unitId, unitLocator }) {
    const text = String(content || "").trim();
    if (!text) throw new Error("笔记内容不能为空。");
    const now = new Date().toISOString();
    const note = {
      id: uuid(),
      datasetId,
      threadId: thread.id,
      readingRoundId: null,
      content: text,
      sourceMessageIds: [],
      sourceReferences: unitId && unitLocator
        ? [{ bookRevisionId: bookRevision.bookRevisionId, structureNodeId: unitId, locator: unitLocator }]
        : [],
      createdAt: now,
      updatedAt: now,
      revision: 1,
    };
    await repository.transaction(datasetId, async (tx) => {
      await tx.saveNote(note);
    });
    return note;
  }

  async function updateNote({ id, content, baseRevision }) {
    const text = String(content || "").trim();
    if (!text) throw new Error("笔记内容不能为空。");
    const existing = (await loadNotes()).find((note) => note.id === id);
    if (!existing) throw new Error("笔记不存在或已被删除。");
    if (existing.revision !== baseRevision) {
      throw new Error("这条笔记已被更新，请刷新后再编辑；你的修改没有被覆盖，也没有覆盖别人的内容。");
    }
    const updated = {
      ...existing,
      content: text,
      updatedAt: new Date().toISOString(),
      revision: existing.revision + 1,
    };
    await repository.transaction(datasetId, async (tx) => {
      await tx.saveNote(updated);
    });
    return updated;
  }

  // 本地书库用它区分多个 revision：按 bookRevisionId 统计消息与笔记数量。
  async function getRevisionActivity(revisionIds) {
    const wanted = new Set((revisionIds || []).filter(Boolean));
    const result = {};
    for (const id of wanted) result[id] = { messages: 0, notes: 0 };
    if (!wanted.size) return result;
    const snapshot = await repository.createConsistentSnapshot(datasetId);
    const revisionByThread = new Map(snapshot.threads.map((thread) => [thread.id, thread.bookRevisionId]));
    for (const record of snapshot.messages) {
      const revisionId = revisionByThread.get(record.message.threadId);
      if (revisionId && result[revisionId]) result[revisionId].messages += 1;
    }
    for (const note of snapshot.notes || []) {
      const revisionId = revisionByThread.get(note.threadId);
      if (revisionId && result[revisionId]) result[revisionId].notes += 1;
    }
    return result;
  }

  return {
    repository,
    thread,
    readingPosition,
    backupStatus,
    generationConfigured: Boolean(controller),
    loadMessages,
    loadCitations,
    loadNotes,
    createNote,
    updateNote,
    loadMemoryState,
    extractMemories,
    resolveMemoryCandidate,
    savePosition,
    send,
    retryFailedGeneration,
    getRevisionActivity,
    retrievalStatus: () => retriever.status(),
    loadMessageRetrieval,
    ensureRetrievalIndex: () => retriever.ensureIndex(),
    rebuildRetrievalIndex: () => retriever.rebuild(),
    searchBook: (question, options) => retriever.search(question, options),
    debugRetrievalChunks: () => retriever.getChunks(),
    stop: () => controller?.stop(),
    resumePending,
    close: () => repository.close(),
  };
}
