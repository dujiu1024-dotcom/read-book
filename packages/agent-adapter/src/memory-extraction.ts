import {
  evaluateMemoryCandidate,
  validateMemoryExtractionResult,
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

  const evaluated = candidates.map((candidate) => ({
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
