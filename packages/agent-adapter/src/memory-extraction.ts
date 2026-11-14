import {
  evaluateMemoryCandidate,
  validateMemoryExtractionResult,
  validateMemoryEvolution,
  type MemoryVersion,
  type MemoryChangeKind,
  type MemoryCandidate,
  type MemoryCandidateEvaluation,
  type MemoryCandidatePolicy,
  type MemoryExtractionContext,
  type MemoryExtractionResult,
} from "../../domain-core/src/index.ts";

export interface MemoryExtractionMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

export interface MemoryExtractionProviderInput {
  instruction: string;
  context: MemoryExtractionContext;
  messages: readonly MemoryExtractionMessage[];
  outputSchema: Record<string, unknown>;
}

/** Provider implementations may wrap any model SDK; they must return structured JSON, not persist data. */
export interface MemoryExtractionProvider {
  extractStructured(input: MemoryExtractionProviderInput): Promise<unknown>;
}

export interface MemoryExtractionRequest {
  context: MemoryExtractionContext;
  messages: readonly MemoryExtractionMessage[];
  policy: MemoryCandidatePolicy;
  modelVersion: string;
}

export interface EvaluatedMemoryCandidate {
  candidate: MemoryCandidate;
  evaluation: MemoryCandidateEvaluation;
}

export interface MemoryExtractionPipelineResult {
  modelVersion: string;
  accepted: EvaluatedMemoryCandidate[];
  needsConfirmation: EvaluatedMemoryCandidate[];
  rejected: EvaluatedMemoryCandidate[];
}

export class MemoryExtractionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MemoryExtractionError";
  }
}

const EXTRACTION_INSTRUCTION = [
  "你是读书讨论中的认知候选抽取器，不是聊天摘要器。",
  "只输出结构化候选，不要直接写入或修改任何记忆。",
  "只依据本次提供的消息与书籍来源，不得补造消息 ID、书籍版本、结构节点或 locator。",
  "必须区分 user（用户明确表达）、author（原文作者观点）、assistant_inference（AI 推演）。不得把 AI 推演写成用户观点。",
  "普通寒暄、重复表达、低信息量内容不形成候选；不要为了凑数输出候选。",
  "每条候选必须引用至少一条本次提供的原始 user 消息；涉及作者或书籍内容时必须提供当前 BookRevision 的完整 Citation。",
  "confidence、ambiguity 和五项 value 维度均为 0 到 1 的数值。不要把讨论次数直接当作认知价值。",
  "sourceReferences 只能使用输入中明确提供的书籍版本、结构节点和定位信息。",
  "同一批次的重复候选必须合并。最多输出 10 条候选；没有值得沉淀的内容时返回空 candidates。",
  "输出 JSON 对象，形状为 { candidates: [...] }，不要附加 Markdown 或解释文本。",
].join("\n");

/**
 * Runs a provider-backed extraction pass and applies deterministic provenance/value gates.
 * This function deliberately has no Repository dependency: extraction failure cannot affect saved messages.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [
      key,
      canonicalize((value as Record<string, unknown>)[key]),
    ]));
  }
  return value;
}

async function stableCandidateId(context: MemoryExtractionContext, candidate: MemoryCandidate): Promise<string> {
  const { id: _providerId, ...identity } = candidate;
  const material = JSON.stringify(canonicalize({
    threadId: context.threadId,
    bookRevisionId: context.bookRevisionId,
    candidate: { ...identity, sourceMessageIds: [...candidate.sourceMessageIds].sort() },
  }));
  if (!globalThis.crypto?.subtle) throw new MemoryExtractionError("Web Crypto is required to assign stable memory candidate IDs.");
  const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(material)));
  return "candidate-" + [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function runMemoryExtraction(
  provider: MemoryExtractionProvider,
  request: MemoryExtractionRequest,
): Promise<MemoryExtractionPipelineResult> {
  if (!request || !request.context || !Array.isArray(request.messages)) {
    throw new MemoryExtractionError("Memory extraction requires a scoped context and message list.");
  }
  if (typeof request.modelVersion !== "string" || !request.modelVersion.trim()) {
    throw new MemoryExtractionError("Memory extraction modelVersion is required.");
  }
  if (request.messages.length === 0 || request.messages.length > 30) {
    throw new MemoryExtractionError("Memory extraction requires between 1 and 30 messages.");
  }

  const messageIds = new Set<string>();
  const userIds = new Set<string>();
  for (const message of request.messages) {
    if (!message || typeof message.id !== "string" || !message.id.trim() ||
        (message.role !== "user" && message.role !== "assistant") ||
        typeof message.content !== "string" || !message.content.trim()) {
      throw new MemoryExtractionError("Every extraction message requires an ID, role and non-empty content.");
    }
    if (messageIds.has(message.id)) throw new MemoryExtractionError("Extraction message IDs must be unique.");
    messageIds.add(message.id);
    if (message.role === "user") userIds.add(message.id);
  }

  const suppliedIds = new Set(request.context.availableMessageIds);
  const suppliedUserIds = new Set(request.context.availableUserMessageIds);
  if (messageIds.size !== suppliedIds.size || [...messageIds].some((id) => !suppliedIds.has(id))) {
    throw new MemoryExtractionError("Provider messages must exactly match the declared Thread message scope.");
  }
  if (userIds.size !== suppliedUserIds.size || [...userIds].some((id) => !suppliedUserIds.has(id))) {
    throw new MemoryExtractionError("Declared user-message scope must exactly match supplied user messages.");
  }

  const raw = await provider.extractStructured({
    instruction: EXTRACTION_INSTRUCTION,
    context: structuredClone(request.context),
    messages: structuredClone(request.messages),
    outputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["candidates"],
      properties: {
        candidates: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "title", "content", "viewpoint", "confidence", "ambiguity", "value", "sourceMessageIds", "sourceReferences", "requiresBookCitation"],
            properties: {
              id: { type: "string", minLength: 1 },
              title: { type: "string", minLength: 1 },
              content: { type: "string", minLength: 1 },
              viewpoint: { type: "string", enum: ["user", "author", "assistant_inference"] },
              confidence: { type: "number", minimum: 0, maximum: 1 },
              ambiguity: { type: "number", minimum: 0, maximum: 1 },
              value: {
                type: "object",
                additionalProperties: false,
                required: ["novelty", "stability", "explanatoryPower", "discussionDepth", "relationStrength"],
                properties: {
                  novelty: { type: "number", minimum: 0, maximum: 1 },
                  stability: { type: "number", minimum: 0, maximum: 1 },
                  explanatoryPower: { type: "number", minimum: 0, maximum: 1 },
                  discussionDepth: { type: "number", minimum: 0, maximum: 1 },
                  relationStrength: { type: "number", minimum: 0, maximum: 1 },
                },
              },
              sourceMessageIds: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
              sourceReferences: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["bookRevisionId", "structureNodeId", "locator"],
                  properties: {
                    bookRevisionId: { type: "string", minLength: 1 },
                    structureNodeId: { type: "string", minLength: 1 },
                    locator: { type: "string", minLength: 1 },
                  },
                },
              },
              requiresBookCitation: { type: "boolean" },
            },
          },
        },
      },
    },
  });

  let output: unknown = raw;
  if (typeof raw === "string") {
    try {
      output = JSON.parse(raw);
    } catch {
      throw new MemoryExtractionError("Provider returned invalid JSON.");
    }
  }
  let candidates: MemoryCandidate[];
  try {
    candidates = validateMemoryExtractionResult(output as MemoryExtractionResult, request.context);
  } catch (error) {
    throw new MemoryExtractionError(error instanceof Error ? error.message : "Provider output failed provenance validation.");
  }

  const identified = await Promise.all(candidates.map(async (candidate) => ({
    ...candidate,
    // Model-provided IDs are not stable across batches; derive identity from Thread, source and candidate semantics.
    id: await stableCandidateId(request.context, candidate),
  })));
  const evaluated = identified.map((candidate) => ({
    candidate,
    evaluation: evaluateMemoryCandidate(candidate, request.policy),
  }));
  return {
    modelVersion: request.modelVersion,
    accepted: evaluated.filter((item) => item.evaluation.decision === "accept"),
    needsConfirmation: evaluated.filter((item) => item.evaluation.decision === "needs_confirmation"),
    rejected: evaluated.filter((item) => item.evaluation.decision === "reject"),
  };
}

/** A caller must explicitly classify cross-batch evolution; extraction never guesses which memory to overwrite. */
export interface MemoryVersionPlan {
  candidateId: string;
  memoryId: string;
  version: number;
  previousVersionId: string | null;
  /** Required for every non-first version so the domain evolution rules can be re-evaluated. */
  previousVersion?: MemoryVersion;
  /** A cross-memory target is used for duplicate_of; it is not part of the new memory's version chain. */
  relationTargetVersion?: MemoryVersion;
  /** Set only when a user explicitly confirms a persisted low-confidence candidate. */
  resolveCandidateId?: string;
  changeKind: MemoryChangeKind;
  relation?: {
    id: string;
    toVersionId: string;
    relationType: "supports" | "contradicts" | "extends" | "supersedes" | "retracts" | "duplicate_of";
    createdAt: string;
  };
}

export interface MemoryEvolutionProposal {
  candidateId: string;
  changeKind: MemoryChangeKind;
  /** Required for supplement/correction/conflict/rejection/extension; null for a new memory. */
  targetMemoryId: string | null;
  /** Optional cross-memory duplicate target, valid only for changeKind=new. */
  duplicateOfMemoryId?: string;
  rationale: string;
}

export interface MemoryEvolutionPlannerInput {
  candidates: readonly MemoryCandidate[];
  existingLatestVersions: readonly MemoryVersion[];
}

export interface MemoryEvolutionPlanner {
  propose(input: MemoryEvolutionPlannerInput): Promise<readonly MemoryEvolutionProposal[]>;
}

export interface MemoryEvolutionPlanningRepository {
  createConsistentSnapshot(datasetId: string): Promise<{ memoryVersions: MemoryVersion[] }>;
}

export interface MemoryEvolutionPlanningResult {
  plans: MemoryVersionPlan[];
  alreadyPersistedCandidateIds: string[];
}

/**
 * Build safe immutable-version plans across batches. Exact duplicates are linked
 * deterministically; semantic changes require an injected planner. The model may
 * propose a target, but code derives version numbers, previous IDs and relation types.
 */
export async function planAcceptedMemoryCandidates(
  repository: MemoryEvolutionPlanningRepository,
  datasetId: string,
  result: MemoryExtractionPipelineResult,
  planner?: MemoryEvolutionPlanner,
  now: () => string = () => new Date().toISOString(),
  idFactory: () => string = () => crypto.randomUUID(),
): Promise<MemoryEvolutionPlanningResult> {
  if (result.accepted.length === 0) return { plans: [], alreadyPersistedCandidateIds: [] };
  const snapshot = await repository.createConsistentSnapshot(datasetId);
  const allVersions = snapshot.memoryVersions || [];
  const existingIds = new Set(allVersions.map((version) => version.id));
  const latestByMemoryId = new Map<string, MemoryVersion>();
  for (const version of allVersions) {
    const current = latestByMemoryId.get(version.memoryId);
    if (!current || version.version > current.version) latestByMemoryId.set(version.memoryId, version);
  }
  const alreadyPersistedCandidateIds = result.accepted
    .filter(({ candidate }) => existingIds.has(candidate.id))
    .map(({ candidate }) => candidate.id);
  const pending = result.accepted.filter(({ candidate }) => !existingIds.has(candidate.id));
  const usedIds = new Set([...existingIds, ...pending.map(({ candidate }) => candidate.id)]);
  const nextId = () => {
    const id = idFactory();
    if (typeof id !== "string" || !id.trim() || usedIds.has(id)) {
      throw new MemoryExtractionError("The evolution planner ID factory returned an empty or duplicate ID.");
    }
    usedIds.add(id);
    return id;
  };
  const latestVersions = [...latestByMemoryId.values()];
  const fingerprint = (title: string | undefined, content: string, viewpoint: string | undefined) =>
    JSON.stringify([
      (title || "").trim().toLocaleLowerCase(),
      content.replace(/\s+/g, " ").trim().toLocaleLowerCase(),
      viewpoint || null,
    ]);
  const plans: MemoryVersionPlan[] = [];
  const toPropose: typeof pending = [];
  for (const item of pending) {
    const key = fingerprint(item.candidate.title, item.candidate.content, item.candidate.viewpoint);
    const matches = latestVersions.filter((version) =>
      fingerprint(version.title, version.content, version.viewpoint) === key && version.viewpoint !== undefined
    );
    if (matches.length !== 1) {
      toPropose.push(item);
      continue;
    }
    const target = matches[0];
    plans.push({
      candidateId: item.candidate.id,
      memoryId: nextId(),
      version: 1,
      previousVersionId: null,
      changeKind: "new",
      relationTargetVersion: target,
      relation: {
        id: nextId(),
        toVersionId: target.id,
        relationType: "duplicate_of",
        createdAt: now(),
      },
    });
  }
  if (toPropose.length > 0 && !planner) {
    throw new MemoryExtractionError("A semantic MemoryEvolutionPlanner is required when no exact duplicate match exists.");
  }
  if (toPropose.length > 0) {
    const proposals = await planner!.propose({
      candidates: toPropose.map((item) => item.candidate),
      existingLatestVersions: latestVersions,
    });
    const proposalIds = proposals.map((proposal) => proposal.candidateId);
    if (new Set(proposalIds).size !== proposalIds.length ||
        proposalIds.length !== toPropose.length ||
        toPropose.some((item) => !proposalIds.includes(item.candidate.id))) {
      throw new MemoryExtractionError("The evolution planner must return exactly one proposal for every pending candidate.");
    }
    const usedTargets = new Set<string>();
    const candidatesById = new Map(toPropose.map((item) => [item.candidate.id, item.candidate]));
    for (const proposal of proposals) {
      if (typeof proposal.rationale !== "string" || !proposal.rationale.trim()) {
        throw new MemoryExtractionError("Every evolution proposal requires a rationale.");
      }
      const candidate = candidatesById.get(proposal.candidateId)!;
      if (proposal.changeKind === "new") {
        if (proposal.targetMemoryId !== null) throw new MemoryExtractionError("A new memory cannot have a version-chain target.");
        const duplicateTarget = proposal.duplicateOfMemoryId
          ? latestByMemoryId.get(proposal.duplicateOfMemoryId)
          : undefined;
        if (proposal.duplicateOfMemoryId && !duplicateTarget) {
          throw new MemoryExtractionError("A duplicate_of proposal must target an existing memory.");
        }
        plans.push({
          candidateId: candidate.id,
          memoryId: nextId(),
          version: 1,
          previousVersionId: null,
          changeKind: "new",
          ...(duplicateTarget ? { relationTargetVersion: duplicateTarget, relation: {
            id: nextId(), toVersionId: duplicateTarget.id, relationType: "duplicate_of" as const, createdAt: now()
          } } : {}),
        });
        continue;
      }
      if (proposal.duplicateOfMemoryId || typeof proposal.targetMemoryId !== "string" || !proposal.targetMemoryId.trim()) {
        throw new MemoryExtractionError("A non-new evolution proposal must target exactly one existing memory.");
      }
      if (usedTargets.has(proposal.targetMemoryId)) {
        throw new MemoryExtractionError("One batch cannot append multiple competing versions to the same memory.");
      }
      usedTargets.add(proposal.targetMemoryId);
      const previousVersion = latestByMemoryId.get(proposal.targetMemoryId);
      if (!previousVersion) throw new MemoryExtractionError("Evolution proposal targets an unknown memory.");
      const relationType = ({
        supplement: "supports",
        correction: "supersedes",
        conflict: "contradicts",
        rejection: "retracts",
        extension: "extends",
      } as const)[proposal.changeKind];
      plans.push({
        candidateId: candidate.id,
        memoryId: previousVersion.memoryId,
        version: previousVersion.version + 1,
        previousVersionId: previousVersion.id,
        previousVersion,
        relationTargetVersion: previousVersion,
        changeKind: proposal.changeKind,
        relation: {
          id: nextId(),
          toVersionId: previousVersion.id,
          relationType,
          createdAt: now(),
        },
      });
    }
  }
  return { plans, alreadyPersistedCandidateIds };
}

export interface MemoryCandidatePersistenceRepository {
  transaction<T>(datasetId: string, operation: (tx: {
    appendMemoryVersion(version: import("../../domain-core/src/index.ts").MemoryVersion): Promise<unknown>;
    appendMemoryRelation(relation: import("../../domain-core/src/index.ts").MemoryRelation): Promise<unknown>;
    resolveMemoryCandidate(candidateId: string, status: "accepted" | "rejected", updatedAt: string): Promise<boolean>;
  }) => Promise<T>): Promise<T>;
}

/**
 * Persist only accepted candidates. Every accepted item needs an explicit version plan;
 * needsConfirmation/rejected candidates are never written. The repository transaction
 * appends immutable versions and their typed cross-memory relations atomically.
 */
export async function persistAcceptedMemoryCandidates(
  repository: MemoryCandidatePersistenceRepository,
  datasetId: string,
  result: MemoryExtractionPipelineResult,
  plans: readonly MemoryVersionPlan[],
  now: () => string = () => new Date().toISOString(),
): Promise<string[]> {
  const acceptedIds = new Set(result.accepted.map(({ candidate }) => candidate.id));
  if (new Set(plans.map((plan) => plan.candidateId)).size !== plans.length) {
    throw new MemoryExtractionError("A candidate may have only one persistence plan.");
  }
  if (plans.some((plan) => !acceptedIds.has(plan.candidateId)) || plans.length !== acceptedIds.size) {
    throw new MemoryExtractionError("Every accepted candidate needs exactly one plan; unaccepted candidates cannot be persisted.");
  }
  const byId = new Map(result.accepted.map((item) => [item.candidate.id, item]));
  return repository.transaction(datasetId, async (tx) => {
    const persisted: string[] = [];
    for (const plan of plans) {
      const item = byId.get(plan.candidateId)!;
      const candidate = item.candidate;
      const version = {
        id: candidate.id,
        memoryId: plan.memoryId,
        version: plan.version,
        previousVersionId: plan.previousVersionId,
        changeKind: plan.changeKind,
        content: candidate.content,
        title: candidate.title,
        viewpoint: candidate.viewpoint,
        confidence: candidate.confidence,
        ambiguity: candidate.ambiguity,
        evaluationScore: item.evaluation.score,
        sourceMessageIds: [...candidate.sourceMessageIds],
        sourceReferences: structuredClone(candidate.sourceReferences),
        createdAt: now(),
      } as const;
      if (plan.previousVersionId !== (plan.previousVersion?.id ?? null)) {
        throw new MemoryExtractionError("The supplied previous version does not match previousVersionId.");
      }
      if (plan.relation) {
        const relationTarget = plan.relationTargetVersion ?? plan.previousVersion;
        if (!relationTarget || plan.relation.toVersionId !== relationTarget.id) {
          throw new MemoryExtractionError("An evolution relation must point to an explicitly supplied existing version.");
        }
      }
      const relation = plan.relation ? {
        id: plan.relation.id,
        fromVersionId: candidate.id,
        toVersionId: plan.relation.toVersionId,
        relationType: plan.relation.relationType,
        sourceMessageIds: [...candidate.sourceMessageIds],
        sourceReferences: structuredClone(candidate.sourceReferences),
        createdAt: plan.relation.createdAt,
      } : null;
      let validated;
      try {
        validated = validateMemoryEvolution(plan.previousVersion ?? null, version, relation);
      } catch (error) {
        throw new MemoryExtractionError(error instanceof Error ? error.message : "Memory evolution plan failed domain validation.");
      }
      await tx.appendMemoryVersion(validated.version);
      if (validated.relation) await tx.appendMemoryRelation(validated.relation);
      if (plan.resolveCandidateId) {
        const resolved = await tx.resolveMemoryCandidate(plan.resolveCandidateId, "accepted", now());
        if (!resolved) throw new MemoryExtractionError("The pending candidate no longer exists or has already been resolved.");
      }
      persisted.push(candidate.id);
    }
    return persisted;
  });
}
