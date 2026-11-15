import {
  groupChunksByChapter,
  planKnowledgeBatches,
  validateKnowledgeItems,
} from "./knowledge-extraction.js";

/**
 * 知识抽取运行时：按章分批调用服务端代理，逐批落库并记录进度。
 *
 * 失败处理：每章、每批独立记录；某章失败不影响其他章，重新运行从上次成功的批次继续。
 * 去重：写库按 content_hash 冲突跳过，重复抽取不会覆盖人工审核或编辑结果。
 */
export function createKnowledgeRuntime({
  repository,
  datasetId,
  bookRevision,
  chunksProvider,
  provider,
  now = () => new Date().toISOString(),
  onProgress = null,
}) {
  const bookRevisionId = bookRevision.bookRevisionId;

  function toPayload(chunk) {
    return {
      chunk_id: chunk.id,
      structure_node_id: chunk.structureNodeId,
      locator: chunk.locator,
      title: chunk.title || "",
      text: String(chunk.text || "").slice(0, 4000),
    };
  }

  async function loadChunks() {
    const chunks = await chunksProvider();
    return Array.isArray(chunks) ? chunks : [];
  }

  async function stateMap() {
    if (typeof repository.listKnowledgeExtractionState !== "function") return new Map();
    const states = await repository.listKnowledgeExtractionState(datasetId, bookRevisionId);
    return new Map((states || []).map((state) => [state.chapter, state]));
  }

  async function saveState(chapter, status, doneBatches, totalBatches, itemCount, error) {
    if (typeof repository.saveKnowledgeExtractionState !== "function") return;
    await repository.saveKnowledgeExtractionState(datasetId, {
      bookRevisionId,
      chapter,
      status,
      doneBatches,
      totalBatches,
      itemCount,
      error: error || null,
      updatedAt: now(),
    });
  }

  /** 章节列表来自切块结果，保证与检索索引同一套原文切片。 */
  async function chapters() {
    return [...groupChunksByChapter(await loadChunks()).keys()];
  }

  async function extractChapter(chapter, { force = false, onProgress: report = onProgress } = {}) {
    if (!provider || typeof provider.extract !== "function") {
      throw new Error("尚未配置知识抽取服务，无法抽取。");
    }
    const all = await loadChunks();
    const group = groupChunksByChapter(all).get(chapter) || [];
    if (!group.length) throw new Error("「" + chapter + "」没有可抽取的原文切片。");
    const batches = planKnowledgeBatches(group);
    const existing = (await stateMap()).get(chapter);
    let done = 0;
    let itemCount = 0;
    let skipped = false;
    if (!force && existing && existing.totalBatches === batches.length) {
      if (existing.status === "completed") {
        const intents = await repository.listBookKnowledge(datasetId, {
          bookRevisionId,
          chapter,
          itemType: "chapter_intent",
          limit: 5,
        });
        // 已完成且章节意图齐全才跳过；缺意图时只补意图，不重复跑各批。
        if (intents.length) {
          return { chapter, done: batches.length, total: batches.length, itemCount: existing.itemCount, skipped: true, dropped: 0 };
        }
        done = batches.length;
        itemCount = Math.max(existing.itemCount, 0);
      } else {
        done = Math.min(Math.max(existing.doneBatches, 0), batches.length);
        itemCount = Math.max(existing.itemCount, 0);
        skipped = done > 0;
      }
    }
    await saveState(chapter, "running", done, batches.length, itemCount, null);
    report?.({ chapter, done, total: batches.length, itemCount, status: "running", skipped });
    let dropped = 0;
    for (let index = done; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const response = await provider.extract({
          bookRevisionId,
          chapter,
          chunks: batch.chunks.map(toPayload),
        });
        const validated = await validateKnowledgeItems(response?.items, batch.chunks, {
          bookRevisionId,
          chapter,
          modelVersion: response?.model || provider.model || "knowledge-proxy",
          extractionMethod: "llm",
          now: now(),
        });
        dropped += validated.dropped;
        let batchItems = validated.items;
        // 一章只保留一条章节意图：分批抽取时，后续批次不再重复记录。
        if (batchItems.some((item) => item.itemType === "chapter_intent")) {
          const existingIntent = await repository.listBookKnowledge(datasetId, {
            bookRevisionId,
            chapter,
            itemType: "chapter_intent",
            limit: 5,
          });
          if (existingIntent.length) {
            dropped += batchItems.filter((item) => item.itemType === "chapter_intent").length;
            batchItems = batchItems.filter((item) => item.itemType !== "chapter_intent");
          }
        }
        let saved = 0;
        if (batchItems.length && typeof repository.saveBookKnowledge === "function") {
          const result = await repository.saveBookKnowledge(datasetId, { bookRevisionId, items: batchItems });
          saved = Number(result?.saved || 0);
        }
        itemCount += saved;
        await saveState(chapter, "running", index + 1, batches.length, itemCount, null);
        report?.({
          chapter,
          done: index + 1,
          total: batches.length,
          itemCount,
          status: "running",
          dropped,
        });
      } catch (error) {
        await saveState(chapter, "failed", index, batches.length, itemCount, String(error?.message || error));
        throw error;
      }
    }
    // 概念单独补一遍：主抽取以主张为主，术语定义容易漏。
    for (let index = 0; index < batches.length; index += 1) {
      const batch = batches[index];
      try {
        const response = await provider.extract({
          bookRevisionId,
          chapter,
          chunks: batch.chunks.map(toPayload),
          focus: "concept",
        });
        const validated = await validateKnowledgeItems(response?.items, batch.chunks, {
          bookRevisionId,
          chapter,
          modelVersion: response?.model || provider.model || "knowledge-proxy",
          extractionMethod: "llm",
          now: now(),
        });
        dropped += validated.dropped;
        const concepts = validated.items.filter((item) => item.itemType === "concept");
        let saved = 0;
        if (concepts.length) {
          const result = await repository.saveBookKnowledge(datasetId, { bookRevisionId, items: concepts });
          saved = Number(result?.saved || 0);
        }
        itemCount += saved;
        report?.({ chapter, done: index + 1, total: batches.length, itemCount, status: "running", stage: "concept", dropped });
      } catch (error) {
        await saveState(chapter, "failed", batches.length, batches.length, itemCount, String(error?.message || error));
        throw error;
      }
    }
    // 章节意图单独补一次：分批抽取时模型很难从单批片段概括整章。
    const intents = await repository.listBookKnowledge(datasetId, {
      bookRevisionId,
      chapter,
      itemType: "chapter_intent",
      limit: 5,
    });
    if (!intents.length) {
      const representatives = batches.slice(0, 6).map((batch) => batch.chunks[0]);
      try {
        const response = await provider.extract({
          bookRevisionId,
          chapter,
          chunks: representatives.map(toPayload),
          focus: "chapter_intent",
        });
        const validated = await validateKnowledgeItems(response?.items, representatives, {
          bookRevisionId,
          chapter,
          modelVersion: response?.model || provider.model || "knowledge-proxy",
          extractionMethod: "llm",
          now: now(),
        });
        dropped += validated.dropped;
        const intent = validated.items.find((item) => item.itemType === "chapter_intent");
        if (intent) {
          const saved = await repository.saveBookKnowledge(datasetId, { bookRevisionId, items: [intent] });
          itemCount += Number(saved?.saved || 0);
        }
        report?.({ chapter, done: batches.length, total: batches.length, itemCount, status: "running", stage: "intent", dropped });
      } catch (error) {
        await saveState(chapter, "failed", batches.length, batches.length, itemCount, String(error?.message || error));
        throw error;
      }
    }
    await saveState(chapter, "completed", batches.length, batches.length, itemCount, null);
    report?.({ chapter, done: batches.length, total: batches.length, itemCount, status: "completed", dropped });
    return { chapter, done: batches.length, total: batches.length, itemCount, skipped, dropped };
  }

  /** 逐章抽取：某章失败只记录失败，继续处理其他章节。 */
  async function extractAll(options = {}) {
    const results = [];
    const failures = [];
    for (const chapter of await chapters()) {
      try {
        results.push(await extractChapter(chapter, options));
      } catch (error) {
        failures.push({ chapter, error: String(error?.message || error) });
        if (options.continueOnError === false) throw error;
      }
    }
    return { results, failures };
  }

  function list(query = {}) {
    if (typeof repository.listBookKnowledge !== "function") return Promise.resolve([]);
    return repository.listBookKnowledge(datasetId, { bookRevisionId, ...query });
  }

  function review(id, patch) {
    if (typeof repository.updateBookKnowledgeReview !== "function") {
      throw new Error("当前存储不支持知识审核。");
    }
    return repository.updateBookKnowledgeReview(datasetId, { id, updatedAt: now(), ...patch });
  }

  async function state() {
    return [...(await stateMap()).values()];
  }

  /** 只有已接受的知识才允许进入 prompt。 */
  async function acceptedKnowledge() {
    if (typeof repository.listBookKnowledge !== "function") return [];
    return repository.listBookKnowledge(datasetId, { bookRevisionId, reviewStatus: "accepted", limit: 500 });
  }

  return {
    chapters,
    extractChapter,
    extractAll,
    list,
    review,
    state,
    stateMap,
    acceptedKnowledge,
  };
}
