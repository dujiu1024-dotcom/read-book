export const DEFAULT_MEMORY_CANDIDATE_POLICY = {
  weights: { novelty: 0.2, stability: 0.2, explanatoryPower: 0.2, discussionDepth: 0.2, relationStrength: 0.2 },
  minimumValueScore: 0.55,
  minimumConfidence: 0.6,
  maximumAmbiguity: 0.45,
  minimumSourceMessages: 1,
};

const CHANGE_KINDS = ["new", "supplement", "correction", "conflict", "rejection", "extension"];
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createMemoryProxyProvider({ baseUrl, getAccessToken, fetchImpl = fetch }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");

  async function postOnce(path, payload) {
    const token = typeof getAccessToken === "function" ? await getAccessToken() : "";
    if (!token) throw new Error("缺少本地访问令牌，无法调用认知代理。");
    let response;
    try {
      response = await fetchImpl(root + path, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      const error = new Error("认知服务连接失败，请检查网络后重试");
      error.retryable = true;
      error.cause = cause;
      throw error;
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const code = body?.error?.code || "proxy_error";
      const error = new Error("认知服务返回 " + response.status + "（" + code + "）：" + (body?.error?.message || "未知错误"));
      error.status = response.status;
      error.retryable = RETRYABLE_STATUS.has(response.status);
      throw error;
    }
    return body;
  }

  async function post(path, payload) {
    let lastError;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      try {
        return await postOnce(path, payload);
      } catch (error) {
        lastError = error;
        if (!error.retryable || attempt === MAX_ATTEMPTS - 1) throw error;
        await delay(300 * (attempt + 1));
      }
    }
    throw lastError;
  }

  /**
   * 按契约校验模型返回的演变计划，而不是把 change_kind / target_memory_id 原样透传。
   * 非法值必须在前端被拦截并给出可读提示，否则会写入错误的记忆版本链。
   */
  function validateProposals(body, acceptedIds, latestByMemoryId) {
    if (!body || !Array.isArray(body.proposals)) {
      throw new Error("认知演变服务没有返回 proposals 数组，请重试");
    }
    const seenCandidates = new Set();
    return body.proposals.map((proposal, index) => {
      const position = "第 " + (index + 1) + " 条演变计划";
      if (!proposal || typeof proposal !== "object") throw new Error(position + "不是对象，请重试");
      const candidateId = proposal.candidate_id;
      if (typeof candidateId !== "string" || !candidateId.trim()) {
        throw new Error(position + "缺少 candidate_id，请重试");
      }
      if (!acceptedIds.has(candidateId)) {
        throw new Error(position + "引用了本轮不存在的候选认知，请重试");
      }
      if (seenCandidates.has(candidateId)) {
        throw new Error(position + "重复规划了同一个候选认知，请重试");
      }
      seenCandidates.add(candidateId);
      const changeKind = proposal.change_kind;
      if (!CHANGE_KINDS.includes(changeKind)) {
        throw new Error(position + "返回了不支持的变更类型「" + String(changeKind ?? "空") + "」，请重试");
      }
      const targetMemoryId = proposal.target_memory_id;
      if (changeKind === "new") {
        if (targetMemoryId) throw new Error(position + "为新认知指定了版本链目标，请重试");
      } else {
        if (typeof targetMemoryId !== "string" || !targetMemoryId.trim()) {
          throw new Error(position + "缺少 target_memory_id，请重试");
        }
        if (!latestByMemoryId.has(targetMemoryId)) {
          throw new Error(position + "指向了当前已加载认知中不存在的记忆，请重试");
        }
      }
      const duplicateOf = proposal.duplicate_of_memory_id;
      if (duplicateOf && (typeof duplicateOf !== "string" || !latestByMemoryId.has(duplicateOf))) {
        throw new Error(position + "指向了不存在的重复记忆，请重试");
      }
      return { ...proposal, candidate_id: candidateId, change_kind: changeKind };
    });
  }

  return {
    async extractStructured(input) {
      return post("/v1/memory/extract", {
        instruction: input.instruction,
        context: input.context,
        messages: input.messages,
        outputSchema: input.outputSchema,
      });
    },
    async propose(input) {
      const body = await post("/v1/memory/plan", {
        candidates: input.accepted.map(({ candidate }) => ({
          id: candidate.id,
          title: candidate.title,
          content: candidate.content,
          viewpoint: candidate.viewpoint,
          confidence: candidate.confidence,
          ambiguity: candidate.ambiguity,
          source_references: candidate.sourceReferences,
        })),
        existingVersions: input.existingVersions.map((version) => ({
          id: version.id,
          memory_id: version.memoryId,
          version: version.version,
          title: version.title,
          content: version.content,
          viewpoint: version.viewpoint,
          confidence: version.confidence,
          ambiguity: version.ambiguity,
        })),
      });
      const now = () => new Date().toISOString();
      const latestByMemoryId = new Map(input.existingVersions.map((version) => [version.memoryId, version]));
      const acceptedIds = new Set(input.accepted.map(({ candidate }) => candidate.id));
      const proposals = validateProposals(body, acceptedIds, latestByMemoryId);
      if (proposals.length !== acceptedIds.size) {
        throw new Error("认知演变服务返回的计划数量与候选认知不一致，请重试");
      }
      const relationTypes = {
        supplement: "supports",
        correction: "supersedes",
        conflict: "contradicts",
        rejection: "retracts",
        extension: "extends",
      };
      return proposals.map((proposal) => {
        if (proposal.change_kind === "new") {
          const duplicateTarget = proposal.duplicate_of_memory_id ? latestByMemoryId.get(proposal.duplicate_of_memory_id) : undefined;
          return {
            candidateId: proposal.candidate_id,
            memoryId: crypto.randomUUID(),
            version: 1,
            previousVersionId: null,
            changeKind: "new",
            ...(duplicateTarget ? {
              relationTargetVersion: duplicateTarget,
              relation: { id: crypto.randomUUID(), toVersionId: duplicateTarget.id, relationType: "duplicate_of", createdAt: now() },
            } : {}),
          };
        }
        const previousVersion = latestByMemoryId.get(proposal.target_memory_id);
        return {
          candidateId: proposal.candidate_id,
          memoryId: previousVersion.memoryId,
          version: previousVersion.version + 1,
          previousVersionId: previousVersion.id,
          previousVersion,
          relationTargetVersion: previousVersion,
          changeKind: proposal.change_kind,
          relation: {
            id: crypto.randomUUID(),
            toVersionId: previousVersion.id,
            relationType: relationTypes[proposal.change_kind],
            createdAt: now(),
          },
        };
      });
    },
  };
}
