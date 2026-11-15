import {
  assessKeywordSpecificity,
  buildChunks,
  cosineSimilarity,
  evaluateEvidence,
  keywordTerms,
  rrfFuse,
  selectRetrievalPassages,
} from "./book-retrieval.js";

const EMBED_BATCH_SIZE = 16;
const KEYWORD_CANDIDATES = 30;
const VECTOR_CANDIDATES = 30;

function errorText(error) {
  return String(error?.message || error || "未知错误").replace(/[。．.!！]+$/, "");
}

/** 向量客户端：只经由本地宿主代理访问 Ollama，浏览器不直连 11434。 */
export function createEmbeddingClient({ baseUrl, getAccessToken, model = "bge-m3" } = {}) {
  if (typeof baseUrl !== "string" || !baseUrl.trim()) return null;
  const endpoint = baseUrl.replace(/\/+$/, "") + "/v1/embeddings";
  return Object.freeze({
    model,
    async embed(inputs) {
      const list = Array.isArray(inputs) ? inputs : [inputs];
      if (!list.length) return { model, dimensions: 0, embeddings: [] };
      const headers = { "content-type": "application/json" };
      if (typeof getAccessToken === "function") {
        const token = await getAccessToken();
        if (token) headers.authorization = "Bearer " + token;
      }
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify({ model, input: list }),
        });
      } catch (error) {
        throw Object.assign(new Error("连接本机向量服务失败：" + errorText(error)), { code: "EMBEDDING_UNAVAILABLE" });
      }
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload) {
        const detail = payload?.error?.message || "HTTP " + response.status;
        throw Object.assign(new Error("本机向量服务不可用：" + detail), {
          code: payload?.error?.code || "EMBEDDING_FAILED",
        });
      }
      if (!Array.isArray(payload.embeddings) || payload.embeddings.length !== list.length) {
        throw Object.assign(new Error("向量服务返回的向量数量不匹配"), { code: "EMBEDDING_INVALID" });
      }
      return { model: payload.model || model, dimensions: payload.dimensions, embeddings: payload.embeddings };
    },
  });
}

function toVectorBytes(values) {
  const floats = new Float32Array(values.length);
  for (let index = 0; index < values.length; index += 1) floats[index] = values[index];
  return new Uint8Array(floats.buffer);
}

function fromVectorBytes(bytes) {
  if (bytes instanceof Uint8Array) {
    return new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  }
  return new Float32Array(bytes);
}

function fingerprintOf(bookRevision) {
  // 覆盖 unit id、章节与正文长度：语料修正后即使 unit 数量不变，也必须重建切片索引。
  let hash = 0;
  for (const unit of bookRevision.units) {
    const signature = unit.id + "|" + unit.chapter + "|" + String(unit.text || "").length;
    for (let index = 0; index < signature.length; index += 1) {
      hash = (Math.imul(hash, 31) + signature.charCodeAt(index)) | 0;
    }
  }
  return bookRevision.bookRevisionId + ":" + bookRevision.units.length + ":" + (hash >>> 0).toString(16);
}

/**
 * 全书检索运行时：索引属于可重建缓存，不参与备份快照。
 * 向量索引未就绪或模型/维度不匹配时，只用关键词通道，并由界面提示重建。
 */
export function createBookRetriever({
  repository,
  datasetId,
  bookRevision,
  embeddingClient = null,
  onStatus = () => {},
} = {}) {
  if (!repository || !datasetId || !bookRevision) throw new Error("检索运行时缺少 Repository 或 BookRevision。");
  const revisionId = bookRevision.bookRevisionId;
  const unitsById = new Map(bookRevision.units.map((unit) => [unit.id, unit]));
  const fingerprint = fingerprintOf(bookRevision);
  let state = null;
  let chunks = null;
  let chunksById = new Map();
  let vectors = null;
  let vectorModel = null;
  let vectorDimensions = 0;
  let indexing = null;
  let lastError = null;

  function status() {
    const modelMismatch = Boolean(state && embeddingClient && state.status === "ready" && state.model !== embeddingClient.model);
    return {
      ready: Boolean(state),
      phase: indexing ? "indexing" : state?.status === "ready" ? "ready" : state?.status === "keyword_only" ? "keyword_only" : "missing",
      chunkCount: chunks?.length || 0,
      model: vectorModel || state?.model || embeddingClient?.model || "",
      dimensions: vectorDimensions || state?.dimensions || 0,
      needsRebuild: Boolean(state && embeddingClient && (state.status !== "ready" || modelMismatch)),
      modelMismatch,
      lastError,
    };
  }

  function emit(extra = {}) {
    onStatus({ ...status(), ...extra });
  }

  async function writeKeywordIndex() {
    const builtChunks = await buildChunks(bookRevision.units, { bookRevisionId: revisionId });
    await repository.replaceRetrievalIndex(datasetId, {
      bookRevisionId: revisionId,
      chunks: builtChunks,
      state: {
        bookRevisionId: revisionId,
        model: embeddingClient?.model || "none",
        dimensions: 0,
        chunkCount: builtChunks.length,
        sourceFingerprint: fingerprint,
        status: "keyword_only",
      },
    });
    chunks = builtChunks;
    chunksById = new Map(builtChunks.map((chunk) => [chunk.id, chunk]));
    state = {
      bookRevisionId: revisionId,
      model: embeddingClient?.model || "none",
      dimensions: 0,
      chunkCount: builtChunks.length,
      sourceFingerprint: fingerprint,
      status: "keyword_only",
      updatedAt: new Date().toISOString(),
    };
    return builtChunks;
  }

  async function loadVectors() {
    const records = await repository.getRetrievalEmbeddings(datasetId, revisionId);
    if (!records.length) { vectors = null; return; }
    const expected = state?.dimensions || records[0].dimensions;
    if (records.length !== chunks.length || records.some((record) => record.dimensions !== expected)) {
      vectors = null;
      return;
    }
    if (embeddingClient && (state.model !== embeddingClient.model || expected <= 0)) {
      // 模型或维度与当前配置不一致：禁止混用，回退关键词并等待重建。
      vectors = null;
      return;
    }
    vectors = new Map(records.map((record) => [record.chunkId, fromVectorBytes(record.vector)]));
    vectorModel = state?.model || embeddingClient?.model || "";
    vectorDimensions = expected;
  }

  async function vectorize() {
    if (!embeddingClient || !chunks?.length) return;
    const total = chunks.length;
    let done = 0;
    let model = null;
    let dimensions = 0;
    try {
      for (let offset = 0; offset < total; offset += EMBED_BATCH_SIZE) {
        const batch = chunks.slice(offset, offset + EMBED_BATCH_SIZE);
        const result = await embeddingClient.embed(batch.map((chunk) => chunk.text));
        if (!model) {
          model = result.model;
          dimensions = result.dimensions;
          if (!Number.isSafeInteger(dimensions) || dimensions <= 0) throw new Error("向量维度非法");
        }
        if (result.dimensions !== dimensions || result.model !== model) {
          throw new Error("同一轮向量化返回了不一致的模型或维度");
        }
        await repository.saveRetrievalEmbeddings(datasetId, {
          bookRevisionId: revisionId,
          model,
          dimensions,
          embeddings: batch.map((chunk, index) => ({
            chunkId: chunk.id,
            vector: toVectorBytes(result.embeddings[index]),
          })),
        });
        done += batch.length;
        emit({ phase: "embedding", done, total });
      }
      state = {
        ...state,
        model,
        dimensions,
        chunkCount: total,
        status: "ready",
        updatedAt: new Date().toISOString(),
      };
      await loadVectors();
      emit({ phase: "ready", done: total, total });
    } catch (error) {
      lastError = errorText(error);
      state = { ...state, status: "keyword_only" };
      vectors = null;
      emit({ phase: "keyword_only", done, total, error: lastError });
    }
  }

  function startVectorization() {
    if (indexing) return indexing;
    indexing = vectorize().finally(() => { indexing = null; });
    return indexing;
  }

  async function ensureIndex({ allowVector = true } = {}) {
    if (chunks) {
      if (allowVector && embeddingClient && state?.status !== "ready" && !indexing) void startVectorization();
      return;
    }
    state = await repository.getRetrievalIndexState(datasetId, revisionId) || null;
    const reusable = state && state.sourceFingerprint === fingerprint && state.chunkCount > 0;
    if (reusable) {
      chunks = await repository.getRetrievalChunks(datasetId, revisionId);
      if (chunks.length !== state.chunkCount) {
        chunks = null;
      } else {
        chunksById = new Map(chunks.map((chunk) => [chunk.id, chunk]));
        await loadVectors();
        if (allowVector && embeddingClient && (!vectors || state.status !== "ready")) void startVectorization();
        emit();
        return;
      }
    }
    await writeKeywordIndex();
    emit({ phase: "keyword_only" });
    if (allowVector && embeddingClient) void startVectorization();
  }

  async function rebuild() {
    if (indexing) await indexing;
    state = null;
    chunks = null;
    vectors = null;
    await writeKeywordIndex();
    emit({ phase: "keyword_only" });
    if (embeddingClient) await startVectorization();
    return status();
  }

  async function search(question, { limit = 8 } = {}) {
    await ensureIndex();
    const terms = keywordTerms(question);
    const keywordHits = await repository.searchRetrievalKeyword(datasetId, revisionId, terms, KEYWORD_CANDIDATES);
    let vectorHits = [];
    let notice = null;

    const modelMismatch = Boolean(state && embeddingClient && state.status === "ready" && state.model !== embeddingClient.model);
    if (modelMismatch) {
      notice = "向量模型与索引不一致（索引 " + state.model + " / 当前 " + embeddingClient.model + "），本次只用关键词检索；请重建全书索引。";
    } else if (vectors && embeddingClient) {
      try {
        const result = await embeddingClient.embed([question]);
        if (result.model !== state.model || result.dimensions !== state.dimensions) {
          notice = "向量模型或维度与索引不一致，本次只用关键词检索；请重建全书索引。";
        } else {
          const queryVector = result.embeddings[0];
          vectorHits = [...vectors.entries()]
            .map(([chunkId, vector]) => ({ chunkId, score: cosineSimilarity(queryVector, vector) }))
            .sort((left, right) => right.score - left.score)
            .slice(0, VECTOR_CANDIDATES);
        }
      } catch (error) {
        notice = "语义向量暂不可用，本次回退关键词检索：" + errorText(error) + "。";
      }
    } else if (embeddingClient && state?.status !== "ready") {
      notice = indexing
        ? "全书向量索引仍在建立中，本次先用关键词检索。"
        : "全书向量索引尚未建立，本次先用关键词检索。";
    } else if (!embeddingClient) {
      notice = "当前未配置向量服务，本次只用关键词检索。";
    }

    // 只用“具体词”命中作为关键词证据：高频通用 2-gram 不能把无关问题误判为书里有依据。
    const specificity = assessKeywordSpecificity(question, chunks || [], terms);
    const specificKeywordHits = keywordHits.filter((hit) =>
      specificity.strongTerms.some((term) => String(hit.chunk.text || "").includes(term)));
    const evidence = evaluateEvidence({
      keywordHits: specificKeywordHits.map((hit) => hit.chunk),
      vectorHits,
    });
    if (!evidence.hasEvidence) {
      return {
        hasEvidence: false,
        hits: [],
        keywordCount: 0,
        vectorTopScore: evidence.topVectorScore,
        notice,
        reason: evidence.reason,
        status: status(),
      };
    }

    const fused = rrfFuse([
      specificKeywordHits.map((hit) => hit.chunk.id),
      vectorHits.map((hit) => hit.chunkId),
    ]);
    const hits = [...fused.entries()]
      .map(([chunkId, score]) => ({ chunk: chunksById.get(chunkId), score }))
      .filter((hit) => hit.chunk)
      .sort((left, right) => right.score - left.score)
      .map((hit) => ({
        ...hit,
        unit: unitsById.get(hit.chunk.structureNodeId) || null,
        chapter: hit.chunk.chapter,
        locator: hit.chunk.locator,
      }));
    const selection = selectRetrievalPassages(hits, { limit });
    return {
      hasEvidence: true,
      hits,
      passages: selection.passages,
      omitted: selection.omitted,
      keywordCount: specificKeywordHits.length,
      vectorTopScore: vectorHits[0]?.score ?? 0,
      notice,
      reason: evidence.reason,
      status: status(),
    };
  }

  return Object.freeze({
    revisionId,
    ensureIndex,
    rebuild,
    search,
    status,
    isIndexing: () => Boolean(indexing),
    getChunks: () => chunks || [],
  });
}
