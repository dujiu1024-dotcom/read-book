import test from "node:test";
import assert from "node:assert/strict";
import {
  createBookContentProvider,
  createDemoBookContentProvider,
  validateBookRevision,
} from "./book-content-provider.js";

const validRevision = {
  bookRevisionId: "revision-1",
  title: "测试书籍",
  author: "测试作者",
  initialMainlineUnitId: "unit-1",
  units: [{
    id: "unit-1",
    chapter: "第一章",
    title: "第一个论述单元",
    locator: "chapter:1/unit:1",
    text: "一段有意义的原文。",
  }],
};

test("provider loads a validated immutable BookRevision", async () => {
  const provider = createBookContentProvider({
    async loadBookRevision(id) {
      assert.equal(id, "revision-1");
      return validRevision;
    },
  });
  const loaded = await provider.loadBookRevision("revision-1");
  assert.equal(loaded.title, "测试书籍");
  assert.notEqual(loaded, validRevision);
  assert.notEqual(loaded.units, validRevision.units);
});

test("provider rejects a mismatched revision id", async () => {
  const provider = createBookContentProvider({
    async loadBookRevision() {
      return { ...validRevision, bookRevisionId: "another-revision" };
    },
  });
  await assert.rejects(() => provider.loadBookRevision("revision-1"), /different BookRevision/);
});

test("provider rejects missing, duplicate or malformed reading units", async () => {
  assert.throws(() => validateBookRevision({ ...validRevision, units: [] }, "revision-1"), /at least one/);
  assert.throws(() => validateBookRevision({
    ...validRevision,
    units: [validRevision.units[0], validRevision.units[0]],
  }, "revision-1"), /Duplicate/);
  assert.throws(() => validateBookRevision({
    ...validRevision,
    units: [{ ...validRevision.units[0], locator: " " }],
  }, "revision-1"), /locator/);
  assert.throws(() => validateBookRevision({
    ...validRevision,
    initialMainlineUnitId: "missing",
  }, "revision-1"), /initialMainlineUnitId/);
});

test("demo provider is explicitly limited to its fixture revision", async () => {
  const provider = createDemoBookContentProvider();
  const loaded = await provider.loadBookRevision("demo-book-revision-1");
  assert.equal(loaded.units.length, 5);
  await assert.rejects(() => provider.loadBookRevision("real-book-revision"), /does not contain/);
});
