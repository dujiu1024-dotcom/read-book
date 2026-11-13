import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright";

const server = spawn("python", ["-m", "http.server", "4173", "--bind", "127.0.0.1", "--directory", "prototypes/pc-reading"], {
  stdio: "ignore"
});
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4173/");
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  if (!ready) throw new Error("prototype static server did not start");

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:4173/", { waitUntil: "networkidle" });

  const sourceTop = await page.locator("#sourceCard").evaluate(el => el.getBoundingClientRect().top);
  const discussionTop = await page.locator(".conversation").evaluate(el => el.getBoundingClientRect().top);
  if (!(sourceTop < discussionTop)) throw new Error("source must stay above discussion");

  await page.getByRole("button", { name: "收起原文" }).click();
  if (await page.locator("#sourceBody").isVisible()) throw new Error("source did not collapse");
  await page.getByRole("button", { name: "展开原文" }).click();
  if (!(await page.locator("#sourceBody").isVisible())) throw new Error("source did not expand");

  await page.getByRole("button", { name: "临时查看其他章节" }).click();
  await page.locator('[data-unit="unit-3"]').click();
  if (!(await page.locator("#sourceHeading").textContent()).includes("接口契约")) throw new Error("temporary view did not open");
  if (!(await page.locator("#viewNoticeText").textContent()).includes("临时查看")) throw new Error("temporary mode not identified");
  await page.getByRole("button", { name: "回到当前主线" }).click();
  if (!(await page.locator("#sourceHeading").textContent()).includes("协同效率与沟通")) throw new Error("return to mainline failed");

  await page.getByRole("button", { name: "复习上一单元" }).click();
  if (!(await page.locator("#sourceHeading").textContent()).includes("共同目标")) throw new Error("review did not show previous unit");
  await page.getByRole("button", { name: "回到当前主线" }).click();
  if (!(await page.locator("#sourceHeading").textContent()).includes("协同效率与沟通")) throw new Error("review changed mainline");

  await page.locator("#messageList").evaluate(el => {
    for (let i = 0; i < 12; i += 1) {
      const item = document.createElement("article");
      item.className = "message";
      item.innerHTML = '<div class="message-avatar">测</div><div class="message-content"><p>用于验证历史滚动位置的测试消息。</p></div>';
      el.append(item);
    }
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await delay(100);
  await page.locator("#messageInput").fill("这是一次浏览器自动化测试消息。");
  await page.getByRole("button", { name: "发送" }).click();
  if (!(await page.locator(".saved-label").last().isVisible())) throw new Error("user message was not marked locally saved");
  await page.getByRole("button", { name: "停止生成" }).waitFor({ state: "visible" });
  await page.getByRole("button", { name: "停止生成" }).click();
  if (!(await page.locator("#generationStatus").textContent()).includes("已停止")) throw new Error("stop generation failed");
  const scrollAfterStop = await page.locator("#messageList").evaluate(el => el.scrollTop);
  if (scrollAfterStop > 80) throw new Error("new message forced history reader to bottom");

  await page.getByRole("button", { name: "模拟失败" }).click();
  await page.locator("#messageInput").fill("触发失败并重试。");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "重试" }).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "重试" }).last().click();
  await page.getByText("重试完成 · 演示状态").waitFor({ timeout: 3000 });

  await page.getByRole("button", { name: "演示状态切换" }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: /继续下一单元/ }).click();
  if (!(await page.locator("#sourceHeading").textContent()).includes("共同目标如何落地")) throw new Error("mainline did not advance after explicit confirmation");

  await page.getByRole("button", { name: "临时查看其他章节" }).click();
  await page.locator('[data-unit="unit-3"]').click();
  await page.locator("#messageInput").fill("这条消息属于临时查看上下文。");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText(/生成完成 · 演示状态/).waitFor({ timeout: 3000 });
  await page.getByRole("button", { name: "回到当前主线" }).click();
  let confirmWasShown = false;
  page.once("dialog", async dialog => { confirmWasShown = true; await dialog.dismiss(); });
  await page.getByRole("button", { name: /继续下一单元/ }).click();
  if (!confirmWasShown) throw new Error("temporary-view discussion incorrectly marked mainline as discussed");

  for (const width of [360, 390, 430, 683, 1366]) {
    await page.setViewportSize({ width, height: 900 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    if (overflow) throw new Error(`horizontal overflow at viewport width ${width}`);
  }
  await page.evaluate(() => { document.body.style.zoom = "2"; });
  const zoomOverflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  if (zoomOverflow) throw new Error("horizontal overflow at simulated 200% zoom");
  await page.evaluate(() => { document.body.style.zoom = "0.8"; });

  await page.getByRole("button", { name: "备份：已检查" }).click();
  if (errors.length) throw new Error("browser runtime errors: " + errors.join("; "));
  console.log("PC reading prototype browser smoke tests passed: source, fold, temporary view, review, local-save state, stop, failure/retry, mainline confirmation, no forced scroll, responsive widths and simulated zoom.");
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
