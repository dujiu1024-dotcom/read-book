import test from "node:test";
import assert from "node:assert/strict";
import { verifyAnswerQuotes } from "./answer-quotes.mjs";

const sources = [
  { excerpt: "祖師道：「你今有緣，我亦喜說。即取個姓來。」祖師笑道：「你是個猢猻，我與你就身上取個姓氏。」" },
  { excerpt: "玉帝傳旨道：「就除他做個弼馬溫罷。」眾臣叫謝恩，他也只朝上唱個大喏。" },
];

test("正文引文能在原文逐字找到时保持原样", () => {
  const answer = "祖师给他取姓，说「你是個猢猻，我與你就身上取個姓氏」（原文 1）。";
  const result = verifyAnswerQuotes(answer, sources);
  assert.equal(result.blocked, 0);
  assert.equal(result.checked, 1);
  assert.equal(result.content, answer);
});

test("伪造引文会被去掉引号并计数", () => {
  const answer = "三个徒弟分别是「第一个姓孙，名悟空行者」「第二个姓猪」「第三个姓沙」（原文 2）。";
  const result = verifyAnswerQuotes(answer, sources);
  assert.equal(result.blocked, 3);
  assert.equal(result.checked, 3);
  assert.ok(!result.content.includes("「第一个姓孙"));
  assert.ok(result.content.includes("第一个姓孙，名悟空行者"));
  assert.match(result.content, /有 3 处引文未能/);
});

test("引文标注了来源时不能借用其他片段过关", () => {
  const answer = "「就除他做個弼馬溫罷」（原文 1）。";
  const result = verifyAnswerQuotes(answer, sources);
  assert.equal(result.blocked, 1);
});

test("省略号拆段后必须每段都逐字命中", () => {
  const ok = verifyAnswerQuotes("「你是個猢猻……就身上取個姓氏」", sources);
  assert.equal(ok.blocked, 0);
  const bad = verifyAnswerQuotes("「你是個猢猻……他本是石猴」", sources);
  assert.equal(bad.blocked, 1);
});

test("空白差异（原文换行）不算改动", () => {
  const result = verifyAnswerQuotes("「玉帝傳旨道\n就除他做個弼馬溫罷」", [
    { excerpt: "玉帝傳旨道\n就除他做個弼馬溫罷。" },
  ]);
  assert.equal(result.blocked, 0);
});
