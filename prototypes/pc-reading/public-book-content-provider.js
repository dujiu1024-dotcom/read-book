import { createBookContentProvider } from "./book-content-provider.js";

export class PublicBookApiError extends Error {
  constructor(status, code, message, requestId = null, retryable = false) {
    super(message);
    this.name = "PublicBookApiError";
    this.status = status;
    this.code = code;
    this.requestId = requestId;
    this.retryable = retryable;
  }
}

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Public book API field "${field}" must be a non-empty string.`);
  }
  return value;
}

function object(value, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Public book API field "${field}" must be an object.`);
  }
  return value;
}

function formatLocator(locator, nodeId) {
  if (typeof locator?.display_label === "string" && locator.display_label.trim()) return locator.display_label;
  if (typeof locator?.page_label === "string" && locator.page_label.trim()) return locator.page_label;
  if (Number.isInteger(locator?.page_number) && locator.page_number > 0) return `第${locator.page_number}页`;
  if (Number.isInteger(locator?.physical_page) && locator.physical_page > 0) return `物理页 ${locator.physical_page}`;
  if (typeof locator?.cfi === "string" && locator.cfi.trim()) return `EPUB · ${locator.cfi}`;
  if (Number.isInteger(locator?.start_offset) && locator.start_offset >= 0) {
    const end = Number.isInteger(locator.end_offset) ? locator.end_offset : locator.start_offset;
    return `字符 ${locator.start_offset}–${end}`;
  }
  return `原文节点 ${nodeId}`;
}

function orderStructure(nodes, revisionId) {
  if (!Array.isArray(nodes) || nodes.length === 0) {
    throw new TypeError("Book structure must contain at least one node.");
  }
  const byId = new Map();
  for (const node of nodes) {
    object(node, "StructureNode");
    requiredText(node.id, "StructureNode.id");
    requiredText(node.title, "StructureNode.title");
    if (node.book_revision_id !== revisionId) throw new Error("StructureNode belongs to a different BookRevision.");
    if (!Number.isInteger(node.order_index) || node.order_index < 0) throw new TypeError("StructureNode.order_index is invalid.");
    if (!["part", "chapter", "section", "subsection", "argument_unit"].includes(node.node_type)) {
      throw new TypeError("StructureNode.node_type is unsupported.");
    }
    object(node.source_locator, "StructureNode.source_locator");
    if (byId.has(node.id)) throw new Error(`Duplicate StructureNode id: ${node.id}`);
    byId.set(node.id, node);
  }

  const children = new Map();
  for (const node of nodes) {
    const parentId = node.parent_id ?? null;
    if (parentId !== null && !byId.has(parentId)) throw new Error(`StructureNode parent is missing: ${parentId}`);
    const list = children.get(parentId) || [];
    list.push(node);
    children.set(parentId, list);
  }
  for (const list of children.values()) list.sort((a, b) => a.order_index - b.order_index);

  const ordered = [];
  const visiting = new Set();
  const visited = new Set();
  function walk(parentId) {
    for (const node of children.get(parentId) || []) {
      if (visiting.has(node.id)) throw new Error("Book structure contains a cycle.");
      if (visited.has(node.id)) throw new Error("Book structure contains a repeated node.");
      visiting.add(node.id);
      visited.add(node.id);
      ordered.push(node);
      walk(node.id);
      visiting.delete(node.id);
    }
  }
  walk(null);
  if (visited.size !== nodes.length) throw new Error("Book structure contains unreachable nodes.");
  return ordered;
}

function chapterPath(node, byId) {
  const ancestors = [];
  let current = node;
  while (current) {
    if (current.node_type !== "argument_unit") ancestors.push(current.title);
    current = current.parent_id ? byId.get(current.parent_id) : null;
  }
  return ancestors.reverse().join(" / ") || "正文";
}

async function mapLimit(items, limit, mapper) {
  const output = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      output[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return output;
}

/**
 * Public Book API adapter. The API origin and token provider are injected because
 * the OpenAPI server is still a placeholder and authentication is owned elsewhere.
 */
export function createPublicBookApiProvider({
  baseUrl,
  getAccessToken,
  fetchImpl = globalThis.fetch,
  contentConcurrency = 4,
} = {}) {
  requiredText(baseUrl, "baseUrl");
  if (typeof getAccessToken !== "function") throw new TypeError("getAccessToken must be a function.");
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function.");
  if (!Number.isInteger(contentConcurrency) || contentConcurrency < 1 || contentConcurrency > 8) {
    throw new RangeError("contentConcurrency must be an integer between 1 and 8.");
  }
  const root = baseUrl.replace(/\/+$/, "") + "/";

  async function getJson(path) {
    const token = requiredText(await getAccessToken(), "access token");
    const url = new URL(path.replace(/^\/+/, ""), root);
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    });
    if (!response.ok) {
      let payload = null;
      try { payload = await response.json(); } catch {}
      const error = payload?.error || {};
      throw new PublicBookApiError(
        response.status,
        typeof error.code === "string" ? error.code : "PUBLIC_BOOK_API_ERROR",
        typeof error.message === "string" ? error.message : `Public book API request failed (${response.status}).`,
        typeof payload?.request_id === "string" ? payload.request_id : null,
        error.retryable === true,
      );
    }
    return response.json();
  }

  return createBookContentProvider({
    async loadBookRevision(requestedRevisionId) {
      requiredText(requestedRevisionId, "requestedRevisionId");
      const encodedId = encodeURIComponent(requestedRevisionId);
      const [revision, structure] = await Promise.all([
        getJson(`v1/book-revisions/${encodedId}`),
        getJson(`v1/book-revisions/${encodedId}/structure`),
      ]);
      object(revision, "BookRevision");
      if (revision.id !== requestedRevisionId) throw new Error("Public API returned a different BookRevision.");
      if (revision.status !== "published") throw new Error("Only published BookRevision content can be loaded.");
      const title = requiredText(revision.title, "BookRevision.title");
      const author = requiredText(revision.author, "BookRevision.author");
      if (structure.book_revision_id !== requestedRevisionId) {
        throw new Error("Public API structure belongs to a different BookRevision.");
      }

      const orderedNodes = orderStructure(structure.nodes, requestedRevisionId);
      const nodeById = new Map(orderedNodes.map((node) => [node.id, node]));
      const units = orderedNodes.filter((node) => node.node_type === "argument_unit");
      if (units.length === 0) throw new Error("Published BookRevision has no argument_unit nodes.");

      const loadedUnits = await mapLimit(units, contentConcurrency, async (node) => {
        const content = object(
          await getJson(`v1/book-revisions/${encodedId}/nodes/${encodeURIComponent(node.id)}/content`),
          "NodeContent",
        );
        if (content.book_revision_id !== requestedRevisionId || content.structure_node_id !== node.id) {
          throw new Error("NodeContent identity does not match the requested revision and node.");
        }
        requiredText(content.content, "NodeContent.content");
        requiredText(content.content_hash, "NodeContent.content_hash");
        const locator = object(content.source_locator, "NodeContent.source_locator");
        return {
          id: node.id,
          chapter: chapterPath(node, nodeById),
          title: node.title,
          locator: formatLocator(locator, node.id),
          text: content.content,
        };
      });

      return {
        bookRevisionId: requestedRevisionId,
        bookId: requiredText(revision.book_id, "BookRevision.book_id"),
        language: requiredText(revision.language, "BookRevision.language"),
        title,
        author,
        initialMainlineUnitId: loadedUnits[0].id,
        units: loadedUnits,
      };
    },
  });
}
