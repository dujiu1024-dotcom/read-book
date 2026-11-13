const DEMO_BOOK_REVISION_ID = "demo-book-revision-1";

function requiredText(value, field) {
  if (typeof value !== "string" || !value.trim()) {
    throw new TypeError(`Book revision field "${field}" must be a non-empty string.`);
  }
  return value;
}

export function validateBookRevision(value, requestedRevisionId) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("BookContentProvider must return a book revision object.");
  }
  const bookRevisionId = requiredText(value.bookRevisionId, "bookRevisionId");
  if (bookRevisionId !== requestedRevisionId) {
    throw new Error("BookContentProvider returned a different BookRevision than requested.");
  }
  requiredText(value.title, "title");
  requiredText(value.author, "author");
  requiredText(value.initialMainlineUnitId, "initialMainlineUnitId");
  if (!Array.isArray(value.units) || value.units.length === 0) {
    throw new TypeError("A book revision must contain at least one reading unit.");
  }
  const ids = new Set();
  for (const [index, unit] of value.units.entries()) {
    for (const field of ["id", "chapter", "title", "locator", "text"]) {
      requiredText(unit?.[field], `units[${index}].${field}`);
    }
    if (ids.has(unit.id)) throw new Error(`Duplicate reading unit id: ${unit.id}`);
    ids.add(unit.id);
  }
  if (!ids.has(value.initialMainlineUnitId)) {
    throw new Error("initialMainlineUnitId must reference a unit in this BookRevision.");
  }
  return structuredClone(value);
}

/**
 * UI-facing contract. Production adapters can load from the public book API or
 * an imported local book package without changing the reader page.
 */
export function createBookContentProvider(adapter) {
  if (!adapter || typeof adapter.loadBookRevision !== "function") {
    throw new TypeError("BookContentProvider requires loadBookRevision().");
  }
  return Object.freeze({
    async loadBookRevision(bookRevisionId) {
      requiredText(bookRevisionId, "requested bookRevisionId");
      const value = await adapter.loadBookRevision(bookRevisionId);
      return validateBookRevision(value, bookRevisionId);
    },
  });
}

/** Explicit demo-only provider; never represents a real imported book or production source. */
export function createDemoBookContentProvider() {
  const revision = {
    bookRevisionId: DEMO_BOOK_REVISION_ID,
    title: "协同系统设计",
    author: "林间 · 示例作者",
    initialMainlineUnitId: "unit-1",
    units: [
      {
        id: "unit-0", chapter: "第一章 / 协同的基础", title: "共同目标", locator: "第一章 · 论述单元 00",
        text: "协作开始之前，参与者需要先明确共同目标。目标应说明要解决的问题和期望产生的结果，而不是把某项活动本身当成目标。",
      },
      {
        id: "unit-1", chapter: "第一章 / 协同的基础", title: "协同效率与沟通", locator: "第一章 · 论述单元 01",
        text: "协同效率并不等于沟通次数增加。它取决于参与者是否围绕同一目标行动，以及关键交接是否清楚。沟通频繁但目标不一致，只会更快放大分歧。",
      },
      {
        id: "unit-2", chapter: "第一章 / 协同的基础", title: "共同目标如何落地", locator: "第一章 · 论述单元 02",
        text: "共同目标需要被转化为可观察的阶段结果。每个参与者应知道自己负责的输入、输出和完成条件。目标不能只停留在口号，也不能用单一活动量代替结果。",
      },
      {
        id: "unit-3", chapter: "第二章 / 接口与交接", title: "接口契约", locator: "第二章 · 论述单元 01",
        text: "接口契约至少说明输入、输出、责任人、时限和异常处理方式。交接双方应对完成条件有共同定义。缺少契约时，问题容易在部门边界反复传递。",
      },
      {
        id: "unit-4", chapter: "第二章 / 接口与交接", title: "异常闭环", locator: "第二章 · 论述单元 02",
        text: "异常闭环包括发现、归属、处理、验证和复盘。仅仅把问题转交给另一个团队不算闭环；必须有人确认结果，并把重复发生的原因反馈到流程设计。",
      },
    ],
  };
  return createBookContentProvider({
    async loadBookRevision(bookRevisionId) {
      if (bookRevisionId !== DEMO_BOOK_REVISION_ID) {
        throw new Error(`Demo provider does not contain BookRevision: ${bookRevisionId}`);
      }
      return revision;
    },
  });
}
