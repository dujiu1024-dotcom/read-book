import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, devices } from "playwright";

// 静态文件服务器无法解析 TypeScript 包导入与 vite 别名，这里用项目自带的 Vite dev server。
// stdout/stderr 必须落盘：否则 npm ci / 平台二进制缺失时启动失败原因会被吞掉。
const serverLog = { text: "" };
const appendServerLog = (chunk) => {
  serverLog.text = (serverLog.text + chunk.toString()).slice(-40000);
};
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", "4173", "--strictPort"], {
  cwd: "prototypes/pc-reading",
  stdio: ["ignore", "pipe", "pipe"]
});
server.stdout.on("data", appendServerLog);
server.stderr.on("data", appendServerLog);
let serverExited = false;
server.on("exit", (code, signal) => {
  serverExited = true;
  serverLog.text += `\n[vite exited early code=${code} signal=${signal}]\n`;
});
let browser;

async function waitHeading(page, includes) {
  await page.waitForFunction((expected) => {
    const heading = document.querySelector("#sourceHeading")?.textContent || "";
    if (!heading || heading.includes("正在加载")) return false;
    return expected ? heading.includes(expected) : true;
  }, includes || null, { timeout: 30000 });
}

try {
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch("http://127.0.0.1:4173/");
      if (response.ok) { ready = true; break; }
    } catch {}
    await delay(250);
  }
  if (!ready) {
    throw new Error("prototype static server did not start" + (serverExited ? "（vite 进程已退出）" : ""));
  }

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));

  // 演示书籍：验证阅读区、章节导航、引用回跳与讨论交互。
  await page.goto("http://127.0.0.1:4173/?book=demo", { waitUntil: "domcontentloaded" });
  await waitHeading(page, "协同效率与沟通");

  const sourceTop = await page.locator("#sourceCard").evaluate(el => el.getBoundingClientRect().top);
  const discussionTop = await page.locator("#conversationSection").evaluate(el => el.getBoundingClientRect().top);
  if (!(sourceTop < discussionTop)) throw new Error("source must stay above discussion");
  await page.setViewportSize({ width: 1366, height: 900 });
  await delay(300);

  await page.getByRole("button", { name: "收起原文" }).click();
  if (await page.locator("#sourceBody").isVisible()) throw new Error("source did not collapse");
  await page.getByRole("button", { name: "展开原文" }).click();
  if (!(await page.locator("#sourceBody").isVisible())) throw new Error("source did not expand");

  await page.getByRole("button", { name: "临时查看其他章节" }).click();
  await page.locator(".chapter-option", { hasText: "接口契约" }).click();
  await waitHeading(page, "接口契约");
  if (!(await page.locator("#viewNoticeText").textContent()).includes("临时查看")) throw new Error("temporary mode not identified");
  await page.getByRole("button", { name: "回到当前主线" }).click();
  await waitHeading(page, "协同效率与沟通");

  await page.locator(".citation-card .citation-link").first().click();
  if (!(await page.locator("#viewNoticeText").textContent()).includes("引用")) throw new Error("citation view was not identified");
  await page.getByRole("button", { name: "回到当前主线" }).click();

  await page.getByRole("button", { name: "复习上一单元" }).click();
  await waitHeading(page, "共同目标");
  await page.getByRole("button", { name: "回到当前主线" }).click();
  await waitHeading(page, "协同效率与沟通");

  // 用户主动上翻后，新消息不能把阅读位置强行拉回底部。
  await page.locator("#messageList").evaluate(el => {
    for (let i = 0; i < 12; i += 1) {
      const item = document.createElement("article");
      item.className = "message";
      item.innerHTML = '<div class="message-avatar">测</div><div class="message-content"><p>用于验证历史滚动位置的测试消息。</p></div>';
      el.append(item);
    }
  });
  await page.locator(".panel-stack").evaluate(el => {
    el.scrollTop = 0;
    el.dispatchEvent(new Event("scroll"));
  });
  await delay(100);
  await page.locator("#messageInput").fill("这是一次浏览器自动化测试消息。");
  await page.getByRole("button", { name: "发送" }).click();
  if (!(await page.locator(".saved-label").last().isVisible())) throw new Error("user message was not marked locally saved");
  await page.getByRole("button", { name: "停止生成" }).waitFor({ state: "visible" });
  await delay(700);
  await page.getByRole("button", { name: "停止生成" }).click();
  await page.waitForFunction(() => (document.querySelector("#generationStatus")?.textContent || "").includes("已停止"));
  const scrollAfterStop = await page.locator(".panel-stack").evaluate(el => el.scrollTop);
  if (scrollAfterStop > 80) throw new Error("new message forced history reader to bottom");

  await delay(800);
  await page.getByRole("button", { name: "模拟失败" }).click();
  await page.locator("#messageInput").fill("触发失败并重试。");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByRole("button", { name: "重试" }).waitFor({ timeout: 5000 });
  await delay(800);
  await page.getByRole("button", { name: "重试" }).last().click();
  await page.getByText("重试完成 · 演示状态").waitFor({ timeout: 5000 });

  await delay(800);
  await page.locator("#messageInput").fill("键盘快捷发送测试。");
  await page.locator("#messageInput").press("Control+Enter");
  await page.getByText("生成完成 · 演示状态").waitFor({ timeout: 5000 });

  await page.getByRole("button", { name: /切换当前单元讨论状态/ }).click();
  page.once("dialog", dialog => dialog.accept());
  await page.getByRole("button", { name: /继续下一单元/ }).click();
  await waitHeading(page, "共同目标如何落地");

  await page.getByRole("button", { name: "临时查看其他章节" }).click();
  await page.locator(".chapter-option", { hasText: "接口契约" }).click();
  await delay(800);
  await page.locator("#messageInput").fill("这条消息属于临时查看上下文。");
  await page.getByRole("button", { name: "发送" }).click();
  await page.getByText(/生成完成 · 演示状态/).waitFor({ timeout: 5000 });
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

  // 内置读物：不依赖 GitHub 配额，静态服务器也能直接打开。
  const bundled = await browser.newPage({ viewport: { width: 390, height: 844 } });
  const bundledErrors = [];
  bundled.on("pageerror", error => bundledErrors.push(error.message));
  await bundled.goto("http://127.0.0.1:4173/?book=bundled", { waitUntil: "domcontentloaded" });
  await waitHeading(bundled, "先生于大学格物诸说");
  const bundledFacts = await bundled.evaluate(() => ({
    title: document.querySelector("#bookTitle")?.textContent || "",
    status: document.querySelector("#generationStatus")?.textContent || "",
    textLength: document.querySelector("#sourceText")?.textContent?.length || 0,
    sourceTag: document.querySelector("#sourceTag")?.textContent || "",
    overflow: document.documentElement.scrollWidth > window.innerWidth,
  }));
  if (!bundledFacts.title.includes("传习录")) throw new Error("bundled book did not open: " + bundledFacts.title);
  if (!bundledFacts.sourceTag.includes("内置")) throw new Error("bundled source tag missing");
  if (!bundledFacts.status.includes("内置")) throw new Error("bundled status not explained: " + bundledFacts.status);
  if (bundledFacts.textLength < 30) throw new Error("bundled book has no readable text");
  if (bundledFacts.overflow) throw new Error("bundled page has horizontal overflow at 390");
  if (bundledErrors.length) throw new Error("bundled page runtime errors: " + bundledErrors.join("; "));
  await bundled.close();

  // Device-profile emulation exercises touch input and narrow mobile viewports.
  // It is not a substitute for testing on physical iOS/Android hardware.
  for (const [profileName, profile] of [
    ["iPhone 13", devices["iPhone 13"]],
    ["Pixel 7", devices["Pixel 7"]]
  ]) {
    const context = await browser.newContext({ ...profile });
    const mobilePage = await context.newPage();
    const mobileErrors = [];
    mobilePage.on("pageerror", error => mobileErrors.push(error.message));
    await mobilePage.goto("http://127.0.0.1:4173/?book=demo", { waitUntil: "domcontentloaded" });
    await waitHeading(mobilePage, "协同效率与沟通");

    const deviceFacts = await mobilePage.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
      touchPoints: navigator.maxTouchPoints,
      horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
      inputFontSize: Number.parseFloat(getComputedStyle(document.querySelector("#messageInput")).fontSize)
    }));
    if (!deviceFacts.touchPoints) throw new Error(`${profileName}: touch input is not enabled in device profile`);
    if (deviceFacts.horizontalOverflow) throw new Error(`${profileName}: horizontal overflow at initial viewport`);
    if (deviceFacts.inputFontSize < 16) throw new Error(`${profileName}: composer font size may trigger iOS focus zoom`);

    const undersized = await mobilePage.locator("button:visible").evaluateAll(buttons =>
      buttons.map(button => {
        const rect = button.getBoundingClientRect();
        return { label: (button.innerText || button.getAttribute("aria-label") || "").trim(), width: rect.width, height: rect.height };
      }).filter(item => item.width < 44 || item.height < 44)
    );
    if (undersized.length) throw new Error(`${profileName}: touch targets below 44 CSS px: ${JSON.stringify(undersized)}`);

    await mobilePage.getByRole("button", { name: "收起原文" }).tap();
    if (await mobilePage.locator("#sourceBody").isVisible()) throw new Error(`${profileName}: touch collapse failed`);
    await mobilePage.getByRole("button", { name: "展开原文" }).tap();
    await mobilePage.getByRole("button", { name: "临时查看其他章节" }).tap();
    await mobilePage.locator(".chapter-option", { hasText: "接口契约" }).tap();
    await waitHeading(mobilePage, "接口契约");
    await mobilePage.getByRole("button", { name: "回到当前主线" }).tap();

    await mobilePage.locator("#messageInput").tap();
    await mobilePage.locator("#messageInput").fill("移动设备触控发送测试。");
    await mobilePage.getByRole("button", { name: "发送" }).tap();
    await mobilePage.getByRole("button", { name: "停止生成" }).waitFor({ state: "visible" });
    await delay(700);
    await mobilePage.getByRole("button", { name: "停止生成" }).tap();
    await mobilePage.waitForFunction(() => (document.querySelector("#generationStatus")?.textContent || "").includes("已停止"));
    if (mobileErrors.length) throw new Error(`${profileName}: browser runtime errors: ${mobileErrors.join("; ")}`);
    await context.close();
    console.log(`${profileName} touch-emulation passed: viewport ${deviceFacts.width}x${deviceFacts.height}, touch points ${deviceFacts.touchPoints}, 44px targets, fold, chapter selection, composer send and stop.`);
  }

  if (errors.length) throw new Error("browser runtime errors: " + errors.join("; "));
  console.log("PC reading prototype browser smoke tests passed: demo reading, temporary view, review, bundled offline book, local-save state, stop, failure/retry, mainline confirmation, no forced scroll, responsive widths, simulated zoom and mobile touch profiles.");
} catch (error) {
  console.error("smoke test failed: " + (error?.stack || error));
  console.error("--- vite log (tail) ---");
  console.error(serverLog.text.slice(-8000) || "(vite produced no output)");
  process.exitCode = 1;
} finally {
  if (browser) await browser.close();
  server.kill("SIGTERM");
}
