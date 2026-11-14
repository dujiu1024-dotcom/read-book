import {
  MemoryExtractionError,
  type MemoryEvolutionPlanner,
  type MemoryEvolutionPlannerInput,
  type MemoryEvolutionProposal,
  type MemoryExtractionProvider,
  type MemoryExtractionProviderInput,
} from "./memory-extraction.ts";

export interface OpenAICompatibleMemoryProviderConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

type ChatMessage = { role: "system" | "user"; content: string };

function endpointFor(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new MemoryExtractionError("Memory model baseUrl must be a valid HTTP(S) URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new MemoryExtractionError("Memory model baseUrl must use HTTP or HTTPS.");
  }
  const base = baseUrl.replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return base.endsWith("/v1") ? base + "/chat/completions" : base + "/v1/chat/completions";
}

function parseStructuredContent(response: unknown): unknown {
  if (!response || typeof response !== "object") throw new MemoryExtractionError("Memory model returned an invalid response object.");
  const root = response as Record<string, unknown>;
  const choices = root.choices;
  if (!Array.isArray(choices) || !choices[0] || typeof choices[0] !== "object") {
    throw new MemoryExtractionError("Memory model response did not contain a first choice.");
  }
  const message = (choices[0] as Record<string, unknown>).message;
  if (!message || typeof message !== "object") throw new MemoryExtractionError("Memory model response did not contain a message.");
  const record = message as Record<string, unknown>;
  if (record.refusal) throw new MemoryExtractionError("Memory model refused the structured memory operation.");
  if (record.parsed && typeof record.parsed === "object") return record.parsed;
  const content = record.content;
  const text = typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((part) => part && typeof part === "object" && typeof (part as Record<string, unknown>).text === "string" ? (part as Record<string, unknown>).text : "").join("")
      : "";
  if (!text.trim()) throw new MemoryExtractionError("Memory model returned empty structured content.");
  try {
    return JSON.parse(text);
  } catch {
    throw new MemoryExtractionError("Memory model returned malformed JSON content.");
  }
}

export class OpenAICompatibleMemoryProvider implements MemoryExtractionProvider, MemoryEvolutionPlanner {
  private readonly endpoint: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(private readonly config: OpenAICompatibleMemoryProviderConfig) {
    if (!config.apiKey.trim() || !config.model.trim()) {
      throw new MemoryExtractionError("Memory model apiKey and model are required.");
    }
    this.endpoint = endpointFor(config.baseUrl);
    this.fetchImpl = config.fetchImpl || fetch;
    this.timeoutMs = config.timeoutMs ?? 30000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 120000) {
      throw new MemoryExtractionError("Memory model timeoutMs must be between 1000 and 120000.");
    }
  }

  private async completeStructured(
    name: string,
    instruction: string,
    payload: unknown,
    schema: Record<string, unknown>,
  ): Promise<unknown> {
    const messages: ChatMessage[] = [
      { role: "system", content: instruction },
      { role: "user", content: JSON.stringify(payload) },
    ];
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + this.config.apiKey,
        },
        body: JSON.stringify({
          model: this.config.model,
          temperature: 0,
          messages,
          response_format: {
            type: "json_schema",
            json_schema: { name, strict: true, schema },
          },
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new MemoryExtractionError(error instanceof Error ? "Memory model request failed: " + error.message : "Memory model request failed.");
    }
    if (!response.ok) {
      throw new MemoryExtractionError("Memory model request failed with HTTP " + response.status + ".");
    }
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new MemoryExtractionError("Memory model returned a non-JSON HTTP response.");
    }
    return parseStructuredContent(body);
  }

  async extractStructured(input: MemoryExtractionProviderInput): Promise<unknown> {
    return this.completeStructured(
      "read_book_memory_extraction",
      input.instruction,
      { context: input.context, messages: input.messages },
      input.outputSchema,
    );
  }

  async propose(input: MemoryEvolutionPlannerInput): Promise<readonly MemoryEvolutionProposal[]> {
    const schema: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      required: ["proposals"],
      properties: {
        proposals: {
          type: "array",
          maxItems: 10,
          items: {
            type: "object",
            additionalProperties: false,
            required: ["candidate_id", "change_kind", "target_memory_id", "duplicate_of_memory_id", "rationale"],
            properties: {
              candidate_id: { type: "string", minLength: 1 },
              change_kind: { type: "string", enum: ["new", "supplement", "correction", "conflict", "rejection", "extension"] },
              target_memory_id: { type: ["string", "null"] },
              duplicate_of_memory_id: { type: ["string", "null"] },
              rationale: { type: "string", minLength: 1, maxLength: 1000 },
            },
          },
        },
      },
    };
    const result = await this.completeStructured(
      "read_book_memory_evolution",
      "你是认知版本演变规划器。只比较候选认知与已存在的最新版本。不得改写候选正文，不得自行生成或猜测 memory ID。新认知使用 change_kind=new 且 target_memory_id=null；补充、修正、冲突、撤回、延伸必须选择 existing_latest_versions 中真实存在的 memory_id。只有明确重复时才设置 duplicate_of_memory_id，且 change_kind 必须为 new。证据不足或无法判断时，仍返回 new，不得虚构关系。每项必须给出简短、可审阅的 rationale。",
      {
        candidates: input.candidates.map((candidate) => ({
          candidate_id: candidate.id,
          title: candidate.title,
          content: candidate.content,
          viewpoint: candidate.viewpoint,
          confidence: candidate.confidence,
          ambiguity: candidate.ambiguity,
          source_references: candidate.sourceReferences,
        })),
        existing_latest_versions: input.existingLatestVersions.map((version) => ({
          id: version.id,
          memory_id: version.memoryId,
          version: version.version,
          title: version.title,
          content: version.content,
          viewpoint: version.viewpoint,
          confidence: version.confidence,
          ambiguity: version.ambiguity,
        })),
      },
      schema,
    ) as { proposals?: unknown };
    if (!result || !Array.isArray(result.proposals)) {
      throw new MemoryExtractionError("Memory evolution response must contain a proposals array.");
    }
    return result.proposals.map((value) => {
      if (!value || typeof value !== "object") throw new MemoryExtractionError("Memory evolution proposal must be an object.");
      const proposal = value as Record<string, unknown>;
      if (typeof proposal.candidate_id !== "string" ||
          typeof proposal.change_kind !== "string" ||
          (proposal.target_memory_id !== null && typeof proposal.target_memory_id !== "string") ||
          (proposal.duplicate_of_memory_id !== null && typeof proposal.duplicate_of_memory_id !== "string") ||
          typeof proposal.rationale !== "string") {
        throw new MemoryExtractionError("Memory evolution proposal fields are invalid.");
      }
      return {
        candidateId: proposal.candidate_id,
        changeKind: proposal.change_kind as MemoryEvolutionProposal["changeKind"],
        targetMemoryId: proposal.target_memory_id as string | null,
        ...(proposal.duplicate_of_memory_id ? { duplicateOfMemoryId: proposal.duplicate_of_memory_id as string } : {}),
        rationale: proposal.rationale,
      };
    });
  }
}
