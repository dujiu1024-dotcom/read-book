import { createDemoBookContentProvider } from "./book-content-provider.js";
import { createPublicBookApiProvider } from "./public-book-content-provider.js";
import { createGithubCorpusProvider } from "./github-corpus-provider.js";
import { createLocalCorpusRuntime } from "./local-corpus-runtime.js";
import { createProductionReaderRuntime } from "./reader-runtime.js";
import { createLocalBookPackageProvider, importBookPackageFile, listImportedBookPackages } from "./local-book-package-provider.js";
import { createBundledBookContentProvider, BUNDLED_BOOK_REVISION_ID } from "./bundled-book-content-provider.js";
import { createSourceRetriever } from "./source-retriever.js";
import { hasGenerationService } from "./reader-capabilities.js";
import { createMemoryProxyProvider, DEFAULT_MEMORY_CANDIDATE_POLICY } from "./memory-proxy-provider.js";

(() => {
  let units = [];
  let bookRevision = null;
  let sourceRetriever = null;
  const readerConfig = window.READ_BOOK_CONFIG || {};
  const queryParams = new URLSearchParams(window.location.search);
  const explicitBookId = queryParams.get("book");
  const queryLocalBookId = queryParams.get("localBookRevision");
  const activeLocalBookPackageId = readerConfig.localBookPackageId || queryLocalBookId || (() => {
    try { return window.localStorage.getItem("read-book:active-local-book") || ""; } catch { return ""; }
  })();
  const preferLocalBookPackage = Boolean(readerConfig.localBookPackageId || queryLocalBookId) || (() => {
    try { return window.localStorage.getItem("read-book:prefer-local-book") === "true"; } catch { return false; }
  })();
  const useLocalBookPackage = Boolean(activeLocalBookPackageId && !explicitBookId && (preferLocalBookPackage || !readerConfig.bookRevisionId));
  const queryBookId = explicitBookId || (!useLocalBookPackage && !readerConfig.apiBaseUrl && !readerConfig.bookRevisionId ? "chuanxilu" : null);
  const isBundledMode = queryBookId === "bundled";
  const isGithubCorpusMode = Boolean(queryBookId && queryBookId !== "demo" && !isBundledMode);
  const isDemoProvider = queryBookId === "demo" || (!isGithubCorpusMode && !isBundledMode && !useLocalBookPackage && !readerConfig.apiBaseUrl && !readerConfig.bookRevisionId);
  let activeSource = isBundledMode ? "bundled" : isGithubCorpusMode ? "github" : useLocalBookPackage ? "local" : isDemoProvider ? "demo" : "service";
  const isCorpusSourceActive = () => activeSource === "github" || activeSource === "bundled";
  let bookContentProvider = null;
  let productionRuntime = null;
  const requestedBookRevisionId = isBundledMode
    ? BUNDLED_BOOK_REVISION_ID
    : isGithubCorpusMode
      ? "github-corpus-" + queryBookId
      : isDemoProvider ? "demo-book-revision-1"
        : useLocalBookPackage ? activeLocalBookPackageId
          : (readerConfig.bookRevisionId || "");

  const state = {
    mainlineIndex: 1,
    displayedUnit: null,
    viewMode: "mainline",
    discussed: true,
    generating: false,
    failNext: false,
    timer: null,
    lastFailedText: "",
    messages: [
      { role: "user", text: "我觉得沟通频率高不一定代表协同好，关键还是目标是不是一致。", time: "09:32", saved: true },
      { role: "agent", text: "你的判断和作者这里的区分是一致的：沟通只是动作，协同结果取决于共同目标和交接是否清楚。可以进一步区分“信息同步充分”和“行动方向一致”，两者并不等同。", time: "09:33", citation: "unit-1" }
    ]
  };

  const $ = (id) => document.getElementById(id);
  const messageList = $("messageList");
  const panelStack = document.querySelector(".panel-stack");
  let nearBottom = true;
  let toastTimer = null;
  let notes = [];
  let lastSendAt = 0;
  let stopArmedAt = 0;
  let stopRequested = false;

  /** 把底层错误转成可读中文，并去掉重复句号。 */
  function errorText(error) {
    const raw = String(error?.message || error || "未知错误").trim();
    if (/failed to fetch|networkerror|load failed|fetch failed|network request failed/i.test(raw)) {
      return "网络连接失败，请检查网络后重试";
    }
    return raw.replace(/[。．.!！]+$/, "");
  }

  /**
   * 桌面端真正的滚动容器是 .panel-stack（#messageList 本身不滚动）；
   * 窄屏下 .panel-stack 改为 overflow:visible，由窗口滚动。
   */
  function scrollContainer() {
    if (!panelStack) return null;
    if (panelStack.scrollHeight <= panelStack.clientHeight + 2) return null;
    const overflowY = getComputedStyle(panelStack).overflowY;
    return overflowY === "visible" ? null : panelStack;
  }

  function scrollToLatest(behavior = "auto") {
    const scroller = scrollContainer();
    if (scroller) {
      scroller.scrollTo({ top: scroller.scrollHeight, behavior });
      return;
    }
    window.scrollTo({ top: document.documentElement.scrollHeight, behavior });
  }

  function followingLatest() {
    const scroller = scrollContainer();
    if (scroller) return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 64;
    return window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 96;
  }

  function accessTokenProvider(config = readerConfig) {
    return config.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken;
  }

  function runtimeConfigFor(baseConfig) {
    const config = { ...baseConfig };
    const getAccessToken = accessTokenProvider(baseConfig);
    if (typeof getAccessToken === "function" && !config.getAccessToken) config.getAccessToken = getAccessToken;
    if (readerConfig.memoryProxyUrl && typeof getAccessToken === "function") {
      const provider = createMemoryProxyProvider({ baseUrl: readerConfig.memoryProxyUrl, getAccessToken });
      config.memoryExtractionProvider = provider;
      config.planMemoryEvolution = (input) => provider.propose(input);
      config.memoryCandidatePolicy = readerConfig.memoryCandidatePolicy || DEFAULT_MEMORY_CANDIDATE_POLICY;
      config.memoryModelVersion = readerConfig.memoryModelVersion || "sensenova-proxy";
    }
    return config;
  }

  function toast(message) {
    const el = $("toast");
    el.textContent = message;
    el.classList.add("visible");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("visible"), 2200);
  }

  function renderSource() {
    const unit = state.displayedUnit;
    if (!unit || !bookRevision) return;
    $("bookTitle").textContent = bookRevision.title;
    $("topbarBookTitle").textContent = bookRevision.title;
    $("bookAuthor").textContent = bookRevision.author;
    $("sourceTag").textContent = activeSource === "github" ? "GitHub 公开语料" : activeSource === "bundled" ? "内置读物 · 离线可用" : useLocalBookPackage ? "本地书籍包" : "原书内容";
    const sourceLink = $("sourceSourceLink");
    if (sourceLink && unit.source?.url) {
      sourceLink.href = unit.source.url;
      sourceLink.hidden = false;
    } else if (sourceLink) {
      sourceLink.hidden = true;
      sourceLink.removeAttribute("href");
    }
    $("sourceHeading").textContent = unit.title;
    $("sourceText").textContent = unit.text;
    $("sourceLocator").textContent = unit.chapter + " · 第 " + (units.indexOf(unit) + 1) + " / " + units.length + " 段";
    $("chapterPath").textContent = unit.chapter;
    const labels = {
      mainline: "当前主线原文",
      temporary: "临时查看 · 不改变主线",
      review: "复习原文 · 不改变主线",
      citation: "引用原文 · 不改变主线"
    };
    $("sourceMode").textContent = labels[state.viewMode];
    $("viewNotice").hidden = state.viewMode === "mainline";
    if (! $("viewNotice").hidden) {
      const descriptions = {
        temporary: "正在临时查看其他章节，主线位置保持不变。",
        review: "正在复习已读内容，主线位置保持不变。",
        citation: "正在查看讨论引用，主线位置保持不变。"
      };
      $("viewNoticeText").textContent = descriptions[state.viewMode];
    }
    if (productionRuntime) productionRuntime.savePosition(state, units).catch((error) => setGenerationStatus("阅读位置保存失败：" + errorText(error) + "。"));
    refreshReadingChrome();
  }

  function refreshReadingChrome() {
    const unit = state.displayedUnit;
    if (!unit) return;
    const total = units.length || 1;
    const current = state.mainlineIndex + 1;
    $("progressText").textContent = "第 " + current + " / " + total + " 段";
    $("progressBar").style.width = Math.max(2, Math.round((current / total) * 100)) + "%";
    $("railLocator").textContent = unit.locator;
    $("topbarLocator").textContent = "第 " + current + " / " + total + " 段 · " + (unit.chapter || "");
    $("railChapterCount").textContent = new Set(units.map((item) => item.chapter)).size + " 章";
    for (const button of document.querySelectorAll(".rail-chapter")) {
      button.classList.toggle("active", button.dataset.chapter === unit.chapter);
    }
    $("conversationHeading").textContent = "和 Agent 讨论「" + (unit.chapter || "当前单元") + "」";
  }

  function renderRailChapters() {
    const container = $("railChapters");
    if (!container) return;
    container.replaceChildren();
    const firstUnitByChapter = new Map();
    for (const unit of units) {
      if (!firstUnitByChapter.has(unit.chapter)) firstUnitByChapter.set(unit.chapter, unit);
    }
    for (const [chapter, unit] of firstUnitByChapter) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "rail-chapter";
      button.dataset.chapter = chapter;
      button.textContent = chapter;
      button.title = chapter;
      button.addEventListener("click", () => {
        state.displayedUnit = unit;
        state.viewMode = "temporary";
        renderSource();
        toast("已临时查看该章节，主线位置保持不变。");
      });
      container.append(button);
    }
    const toc = container.closest(".rail-toc");
    if (toc) toc.hidden = firstUnitByChapter.size < 2;
  }

  function updateCount() {
    $("messageCount").textContent = state.messages.length + " 条消息";
    const empty = $("conversationEmpty");
    if (empty) empty.hidden = state.messages.length > 0;
  }

  function scrollIfFollowing(force = false) {
    if (force || nearBottom) requestAnimationFrame(() => scrollToLatest("auto"));
  }

  function appendMessage(message) {
    state.messages.push(message);
    const article = document.createElement("article");
    article.className = "message " + (message.role === "user" ? "user-message" : "agent-message");
    const avatar = document.createElement("div");
    avatar.className = "message-avatar" + (message.role === "agent" ? " agent-avatar" : "");
    avatar.textContent = message.role === "user" ? "我" : "知";
    const content = document.createElement("div");
    content.className = "message-content";
    const meta = document.createElement("div");
    meta.className = "message-meta";
    const name = document.createElement("strong");
    name.textContent = message.role === "user" ? "我" : "知行";
    const time = document.createElement("time");
    time.textContent = message.time || "刚刚";
    meta.append(name, time);
    if (message.saving || message.saved) {
      const saved = document.createElement("span");
      saved.className = "saved-label";
      saved.textContent = message.saved ? "本地已保存" : "正在保存";
      meta.append(saved);
    }
    const body = document.createElement("p");
    body.textContent = message.text;
    content.append(meta, body);
    const citations = Array.isArray(message.citations)
      ? message.citations
      : message.citation ? [{ structureNodeId: message.citation }] : [];
    for (const record of citations) {
      const citation = document.createElement("div");
      citation.className = "citation-card";
      const label = document.createElement("div");
      label.className = "citation-label";
      const citedUnit = units.find(item => item.id === record.structureNodeId);
      label.textContent = "引用 · " + (citedUnit ? unitLabel(citedUnit) : (record.locator || "原文来源"));
      const quote = document.createElement("p");
      const excerpt = record.excerpt || citedUnit?.text || "";
      quote.textContent = excerpt ? "“" + excerpt.slice(0, 120) + (excerpt.length > 120 ? "……”" : "”") : "引用来源暂不可用。";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "text-button citation-link";
      link.textContent = "查看原文位置 ↗";
      link.disabled = !citedUnit;
      link.addEventListener("click", () => showCitation(record.structureNodeId));
      citation.append(label, quote, link);
      content.append(citation);
    }
    if (message.failed) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = message.interrupted ? "重新生成" : "重试";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        if (productionRuntime) {
          setGenerating(true);
          setGenerationStatus("正在使用原始输入重新发起生成…");
          try {
            await productionRuntime.retryFailedGeneration(message.id);
            await refreshPersistedMessages({ forceScroll: true });
            setGenerationStatus("重试完成，原始用户消息未重复写入。");
          } catch (error) {
            setGenerationStatus("重试失败：" + errorText(error) + "。原始输入仍保留在本地。");
            retry.disabled = false;
          } finally {
            setGenerating(false);
          }
        } else {
          retry.disabled = false;
          retryLast();
        }
      });
      content.append(retry);
    }
    article.append(avatar, content);
    messageList.append(article);
    updateCount();
    scrollIfFollowing();
  }

  function showCitation(unitId) {
    const unit = units.find(item => item.id === unitId);
    if (!unit) {
      toast("原文单元在当前书籍版本中不可用，未跳转到其他内容。");
      return;
    }
    state.displayedUnit = unit;
    state.viewMode = "citation";
    renderSource();
    $("sourceCard").scrollIntoView?.({ block: "start", behavior: "smooth" });
  }

  function returnToMainline() {
    state.displayedUnit = units[state.mainlineIndex];
    state.viewMode = "mainline";
    renderSource();
  }

  function setGenerationStatus(message) {
    const el = $("generationStatus");
    el.textContent = message;
    el.classList.toggle("is-error", /失败|未完成|错误|不可用|无法/.test(message));
    el.classList.toggle("is-ok", /已完成|已保存|已导入|已配置/.test(message) && !/失败|未完成/.test(message));
  }

  function setGenerating(value) {
    state.generating = value;
    if (value) stopArmedAt = performance.now();
    $("sendButton").hidden = value;
    $("stopButton").hidden = !value;
    $("simulateFailure").disabled = value;
  }

  function generateReply(text, isRetry = false) {
    if (state.generating) return;
    setGenerating(true);
    setGenerationStatus("正在生成 · 演示状态");
    state.timer = setTimeout(() => {
      setGenerating(false);
      if (state.failNext) {
        state.failNext = false;
        state.lastFailedText = text;
        setGenerationStatus("生成失败，原始输入已保留。可以重试。");
        appendMessage({ role: "agent", text: "这次生成没有完成。你的输入仍然保留在本地，可以重试。", failed: true });
        return;
      }
      const reply = "你提出的重点可以拆成两个判断：一是目标是否一致，二是交接是否有明确完成条件。作者在当前单元强调的是两者共同作用，而不是单纯增加沟通动作。";
      appendMessage({ role: "agent", text: reply, citation: state.displayedUnit.id });
      if (state.viewMode === "mainline") state.discussed = true;
      setGenerationStatus(isRetry ? "重试完成 · 演示状态" : "生成完成 · 演示状态");
    }, 1500);
  }

  async function sendMessage() {
    if (state.generating) return;
    // 发送后按钮会在原位变成“停止生成”，双击的第二次点击很容易误取消回答。
    // 这里对连续发送做防抖，停止按钮另有独立的最小可用时间。
    if (Date.now() - lastSendAt < 600) return;
    const input = $("messageInput");
    const value = input.value.trim();
    if (!value) {
      toast("先输入一段想法再发送。");
      input.focus();
      return;
    }
    input.value = "";
    lastSendAt = Date.now();
    stopRequested = false;
    const sentWhileNearBottom = nearBottom;
    if (productionRuntime) {
      const userBubble = { role: "user", text: value, time: "刚刚", saving: true };
      appendMessage(userBubble);
      const userArticle = messageList.lastElementChild;
      const assistantBubble = { role: "agent", text: "", time: "刚刚" };
      appendMessage(assistantBubble);
      const assistantArticle = messageList.lastElementChild;
      if (window.matchMedia("(max-width: 900px)").matches) {
        activatePanel("discussion");
        setTimeout(() => scrollToLatest("auto"), 80);
      }
      const assistantText = assistantArticle.querySelector(".message-content > p");
      setGenerating(true);
      setGenerationStatus("正在将消息保存到本地…");
      try {
        const additionalUnits = sourceRetriever?.retrieve(value, state.displayedUnit?.id, 7) || [];
        const result = await productionRuntime.send(value, state.displayedUnit, {
          additionalUnits,
          onPersisted() {
            userBubble.saving = false;
            userBubble.saved = true;
            const label = userArticle.querySelector(".saved-label");
            if (label) label.textContent = "本地已保存";
            setGenerationStatus("本地已保存 · 已附带 " + additionalUnits.length + " 条关联原文证据 · Agent 正在生成");
          },
          onDelta(text) {
            assistantText.textContent += text;
            scrollIfFollowing();
          },
          onMemoryUpdate(memoryState) { renderMemoryState(memoryState); },
          onMemoryError(error) { setGenerationStatus("回复已保存，但自动认知抽取失败：" + errorText(error) + "。"); },
        });
        assistantText.textContent = result.snapshot.result?.content || assistantText.textContent;
        await refreshPersistedMessages({ forceScroll: sentWhileNearBottom });
        // Do not infer an Assistant citation from the user's current reading position.
        // Only persisted, service-verified sourceReferences may render a citation card.
        state.discussed = true;
        const terminalStatus = result.snapshot?.status;
        if (stopRequested || terminalStatus === "cancelled" || terminalStatus === "cancel_requested") {
          setGenerationStatus("已取消，可重试：原始输入已保存，可对这条回复点“重试”重新生成。");
        } else {
          setGenerationStatus("回复已完成并保存。");
        }
        productionRuntime.savePosition(state, units).catch((error) => setGenerationStatus("阅读位置保存失败：" + errorText(error) + "。"));
      } catch (error) {
        if (stopRequested) {
          setGenerationStatus("已取消，可重试：原始输入已保留在本地，可对这条回复点“重试”重新生成。");
        } else {
          setGenerationStatus("生成未完成：" + errorText(error) + "。原始输入保留在本地，可稍后重试。");
        }
        await refreshPersistedMessages({ forceScroll: sentWhileNearBottom });
      } finally {
        setGenerating(false);
        if (window.matchMedia("(max-width: 900px)").matches && sentWhileNearBottom) {
          setTimeout(() => scrollToLatest("auto"), 60);
        }
      }
      return;
    }
    appendMessage({ role: "user", text: value, saved: true });
    if (state.viewMode === "mainline") state.discussed = true;
    generateReply(value);
  }

  function retryLast() {
    if (!state.lastFailedText) return;
    const text = state.lastFailedText;
    state.lastFailedText = "";
    generateReply(text, true);
  }

  $("toggleSource").addEventListener("click", () => {
    const body = $("sourceBody");
    const collapsed = body.hidden;
    body.hidden = !collapsed;
    $("toggleSource").textContent = collapsed ? "收起原文" : "展开原文";
    $("toggleSource").setAttribute("aria-expanded", String(collapsed));
  });

  $("reviewButton").addEventListener("click", () => {
    if (state.mainlineIndex === 0) {
      toast("当前已是第一条主线内容，没有更早的单元。");
      return;
    }
    state.displayedUnit = units[state.mainlineIndex - 1];
    state.viewMode = "review";
    renderSource();
  });

  function renderChapterOptions() {
    const container = $("chapterOptions");
    if (!container) return;
    container.replaceChildren();
    const firstUnitByChapter = new Map();
    for (const unit of units) {
      if (!firstUnitByChapter.has(unit.chapter)) firstUnitByChapter.set(unit.chapter, unit);
    }
    for (const [chapter, unit] of firstUnitByChapter) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chapter-option";
      const heading = document.createElement("strong");
      heading.textContent = chapter;
      const detail = document.createElement("span");
      detail.textContent = unit.title;
      button.append(heading, detail);
      button.addEventListener("click", () => {
        state.displayedUnit = unit;
        state.viewMode = "temporary";
        $("temporaryDialog").close();
        renderSource();
      });
      container.append(button);
    }
  }

  $("temporaryButton").addEventListener("click", () => {
    renderChapterOptions();
    $("temporaryDialog").showModal();
  });

  $("returnMainline").addEventListener("click", returnToMainline);

  $("continueButton").addEventListener("click", () => {
    if (state.viewMode !== "mainline") {
      toast("先回到当前主线，再继续阅读。");
      return;
    }
    if (!state.discussed && !isCorpusSourceActive()) {
      const confirmed = window.confirm("当前论述单元还没有讨论。是否略读当前单元并继续？");
      if (!confirmed) return;
    }
    if (state.mainlineIndex >= units.length - 1) {
      toast(isCorpusSourceActive() ? "当前书籍已到最后一个阅读单元。" : "演示主线已到最后一个单元。");
      return;
    }
    state.mainlineIndex += 1;
    state.displayedUnit = units[state.mainlineIndex];
    state.viewMode = "mainline";
    state.discussed = isCorpusSourceActive();
    renderSource();
    toast("已按主线顺序展示下一单元。");
  });

  $("messageInput").addEventListener("keydown", event => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      sendMessage();
    }
  });
  $("sendButton").addEventListener("click", sendMessage);
  $("stopButton").addEventListener("click", () => {
    if (!state.generating) return;
    // 发送按钮与停止按钮占用同一位置：刚发出后的极短窗口内忽略停止，
    // 避免双击发送的第二次点击把回答直接取消。
    if (performance.now() - stopArmedAt < 500) {
      toast("刚发送，请稍候再停止生成，避免误触取消回答。");
      return;
    }
    stopRequested = true;
    if (productionRuntime) {
      productionRuntime.stop();
      setGenerationStatus("已取消，可重试：原始输入已保留在本地。");
      return;
    }
    clearTimeout(state.timer);
    setGenerating(false);
    setGenerationStatus("已停止生成 · 用户输入仍保留");
    toast("已停止本次演示生成。");
  });
  $("simulateFailure").addEventListener("click", () => {
    state.failNext = true;
    if ($("messageInput").value.trim()) {
      sendMessage();
    } else {
      toast("已设置下一次发送模拟失败。");
      $("messageInput").focus();
    }
  });

  $("backupButton").addEventListener("click", () => toast(productionRuntime ? productionRuntime.backupStatus.detail : "演示状态：启动备份检查已完成，没有真实上传。"));
  $("menuButton").addEventListener("click", () => {
    state.discussed = !state.discussed;
    toast(state.discussed ? "演示状态：当前单元标记为已讨论。" : "演示状态：当前单元标记为未讨论，可测试继续前确认。");
  });

  $("importBookButton").addEventListener("click", () => $("bookPackageFile").click());
  $("bookPackageFile").addEventListener("change", async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const button = $("importBookButton");
    button.disabled = true;
    setGenerationStatus("正在校验并导入标准书籍包…");
    try {
      const imported = await importBookPackageFile(file);
      setGenerationStatus("已导入《" + imported.title + "》，共 " + imported.unitCount + " 个原文单元。正在打开…");
      const params = new URLSearchParams(window.location.search);
      params.delete("book");
      params.set("localBookRevision", imported.bookRevisionId);
      const query = params.toString();
      window.history.replaceState({}, "", window.location.pathname + (query ? "?" + query : ""));
      window.location.reload();
    } catch (error) {
      setGenerationStatus("书籍导入失败：" + errorText(error) + "。");
      button.disabled = false;
      event.target.value = "";
    }
  });

  panelStack?.addEventListener("scroll", () => { nearBottom = followingLatest(); }, { passive: true });
  window.addEventListener("scroll", () => { nearBottom = followingLatest(); }, { passive: true });
  document.querySelectorAll("[data-citation]").forEach(button => {
    button.addEventListener("click", () => showCitation(button.dataset.citation));
  });

  function renderMemoryState(data) {
    const panel = $("memoryPanel");
    const status = $("memoryStatus");
    const list = $("memoryList");
    const pending = $("pendingMemoryList");
    panel.hidden = false;
    list.replaceChildren();
    pending.replaceChildren();
    if (!data.providerConfigured) {
      status.textContent = "自动认知抽取 Provider 尚未由宿主环境配置；现有认知记录仍可查看。";
    } else if (data.extractionStatus === "completed") {
      const persistedCount = data.persistedIds?.length || 0;
      const waitingCount = data.acceptedNotPersisted?.length || 0;
      status.textContent = persistedCount
        ? "本轮自动沉淀 " + persistedCount + " 条认知。"
        : waitingCount
          ? "识别到 " + waitingCount + " 条候选，但缺少跨批次演变规划器，暂不写入，避免重复或错误覆盖。"
          : "本轮未发现需要新增或演变的长期认知。";
    } else if (data.extractionStatus === "provider_not_configured") {
      status.textContent = "自动认知抽取尚未配置。";
    } else {
      status.textContent = "认知记录来自当前 Thread 的本地持久化数据。";
    }

    const viewpointLabel = (value) => ({
      user: "用户观点",
      author: "作者观点",
      assistant_inference: "AI 推演",
    }[value] || "观点来源未标注");
    const relationLabel = (value) => ({
      supports: "补充支持",
      contradicts: "观点冲突",
      extends: "延伸",
      supersedes: "修正替代",
      retracts: "撤回",
      duplicate_of: "重复关联",
    }[value] || value || "关联");
    const sourceMessageById = new Map((data.sourceMessages || []).map((item) => [item.id, item]));
    const versionById = new Map((data.versions || []).map((item) => [item.id, item]));
    const appendProvenance = (container, item) => {
      const sourceIds = item.sourceMessageIds || [];
      const references = (item.sourceReferences || []).filter((reference) =>
        reference.bookRevisionId === bookRevision?.bookRevisionId);
      const sourceBox = document.createElement("div");
      sourceBox.className = "memory-provenance";
      const heading = document.createElement("strong");
      heading.textContent = "来源追溯";
      sourceBox.append(heading);
      if (sourceIds.length) {
        const messages = document.createElement("ul");
        for (const id of sourceIds) {
          const source = sourceMessageById.get(id);
          const line = document.createElement("li");
          line.textContent = source
            ? (source.role === "user" ? "用户原话：" : "AI 回复：") + source.content
            : "原始消息 ID：" + id + "（当前 Thread 中暂不可读取）";
          messages.append(line);
        }
        sourceBox.append(messages);
      } else {
        const missing = document.createElement("p");
        missing.textContent = "未记录来源消息。";
        sourceBox.append(missing);
      }
      if (references.length) {
        const refs = document.createElement("ul");
        for (const reference of references) {
          const line = document.createElement("li");
          line.textContent = "原文定位：" + reference.locator;
          const targetUnit = units.find((unit) =>
            unit.id === reference.structureNodeId && unit.locator === reference.locator);
          if (targetUnit) {
            const jump = document.createElement("button");
            jump.type = "button";
            jump.className = "text-button";
            jump.textContent = "回到原文";
            jump.addEventListener("click", () => showCitation(reference.structureNodeId));
            line.append(" ", jump);
          } else {
            line.append("（当前版本中无法定位该原文单元）");
          }
          refs.append(line);
        }
        sourceBox.append(refs);
      } else {
        const missingReference = document.createElement("p");
        missingReference.textContent = "未记录当前书籍版本的原文定位。";
        sourceBox.append(missingReference);
      }
      container.append(sourceBox);
    };

    for (const memory of data.memories || []) {
      const versions = (data.versions || []).filter((item) => item.memoryId === memory.id).sort((a, b) => a.version - b.version);
      const current = versions[versions.length - 1];
      if (!current) continue;
      const card = document.createElement("article");
      card.className = "memory-card";
      const heading = document.createElement("h3");
      heading.textContent = current.title || "认知记录";
      const meta = document.createElement("div");
      meta.className = "memory-meta";
      meta.textContent = viewpointLabel(current.viewpoint) + " · v" + current.version + " · 置信度 " + Math.round((current.confidence ?? 1) * 100) + "%";
      const content = document.createElement("p");
      content.textContent = current.content;
      card.append(heading, meta, content);
      appendProvenance(card, current);
      if (versions.length > 1) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "查看认知演变历史（" + versions.length + " 个版本）";
        details.append(summary);
        for (const version of versions) {
          const versionBox = document.createElement("section");
          versionBox.className = "memory-history-item";
          const item = document.createElement("p");
          item.textContent = "v" + version.version + " · " + version.changeKind + " · " + version.content;
          versionBox.append(item);
          appendProvenance(versionBox, version);
          details.append(versionBox);
        }
        card.append(details);
      }
      const versionIds = new Set(versions.map((item) => item.id));
      const relations = (data.relations || []).filter((relation) =>
        versionIds.has(relation.fromVersionId) || versionIds.has(relation.toVersionId));
      if (relations.length) {
        const relationBox = document.createElement("div");
        relationBox.className = "memory-relations";
        const relationHeading = document.createElement("strong");
        relationHeading.textContent = "认知关联";
        relationBox.append(relationHeading);
        for (const relation of relations) {
          const from = versionById.get(relation.fromVersionId);
          const to = versionById.get(relation.toVersionId);
          const line = document.createElement("p");
          line.textContent = relationLabel(relation.relationType) + "：" +
            (from?.title || from?.content || relation.fromVersionId) + " ↔ " +
            (to?.title || to?.content || relation.toVersionId);
          relationBox.append(line);
        }
        card.append(relationBox);
      }
      list.append(card);
    }
    for (const record of data.pendingCandidates || []) {
      const card = document.createElement("article");
      card.className = "memory-card pending-memory";
      const heading = document.createElement("h3");
      heading.textContent = record.candidate.title;
      const meta = document.createElement("div");
      meta.className = "memory-meta";
      meta.textContent = "待确认 · " + viewpointLabel(record.candidate.viewpoint) + " · 置信度 " + Math.round(record.candidate.confidence * 100) + "%";
      const content = document.createElement("p");
      content.textContent = record.candidate.content;
      const actions = document.createElement("div");
      actions.className = "memory-actions";
      const confirm = document.createElement("button");
      confirm.type = "button";
      confirm.className = "soft-button primary-soft";
      confirm.textContent = "确认沉淀";
      confirm.disabled = !data.plannerConfigured;
      confirm.title = data.plannerConfigured ? "确认后按演变规划追加一个新版本" : "需要先配置认知演变规划器";
      confirm.addEventListener("click", async () => {
        confirm.disabled = true;
        try {
          renderMemoryState(await productionRuntime.resolveMemoryCandidate(record.id, "accepted"));
          toast("已确认，认知版本已追加。");
        } catch (error) {
          confirm.disabled = false;
          setGenerationStatus("认知确认失败：" + errorText(error) + "。");
        }
      });
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "text-button";
      reject.textContent = "不保留";
      reject.addEventListener("click", async () => {
        reject.disabled = true;
        try {
          renderMemoryState(await productionRuntime.resolveMemoryCandidate(record.id, "rejected"));
        } catch (error) {
          reject.disabled = false;
          setGenerationStatus("处理待确认认知失败：" + errorText(error) + "。");
        }
      });
      actions.append(confirm, reject);
      card.append(heading, meta, content);
      appendProvenance(card, record.candidate);
      card.append(actions);
      pending.append(card);
    }
    if (!(data.memories || []).length && !(data.pendingCandidates || []).length) {
      const empty = document.createElement("p");
      empty.className = "memory-empty";
      empty.textContent = "暂时没有沉淀的认知。系统只保留经过价值判断且有来源依据的内容。";
      list.append(empty);
    }
    if (!(data.pendingCandidates || []).length) pending.hidden = true;
    else pending.hidden = false;
  }

  async function refreshPersistedMessages({ forceScroll = false } = {}) {
    if (!productionRuntime) return;
    const [persisted, citationRecords] = await Promise.all([
      productionRuntime.loadMessages(),
      productionRuntime.loadCitations(),
    ]);
    const citations = citationRecords || [];
    state.messages = [];
    messageList.replaceChildren();
    for (const item of persisted) {
      const message = item.message;
      // 持久化里的 generating 只可能来自上次被刷新/断网/限流打断的会话。
      // 它不能继续显示成“正在生成”，否则会永久挂起；这里标记为已中断并给出重试入口。
      const interrupted = message.status === "generating";
      const cancelled = message.status === "cancelled";
      const emptyText = interrupted
        ? "上次生成被中断，尚未完成。可点“重试”重新生成。"
        : cancelled
          ? "已取消，可重试。"
          : message.status === "failed"
            ? "生成失败，可重试。"
            : "本次生成未返回内容。";
      appendMessage({
        id: message.id,
        role: message.role === "user" ? "user" : "agent",
        text: message.content || emptyText,
        time: message.createdAt ? new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "刚刚",
        saved: message.role === "user",
        failed: message.status === "failed" || cancelled || interrupted,
        interrupted,
        citations: citations.filter((item) => item.messageId === message.id).map((item) => ({
          structureNodeId: item.structureNodeId,
          locator: item.locator,
          excerpt: item.excerpt,
        })),
      });
    }
    scrollIfFollowing(forceScroll);
  }

  function activatePanel(name) {
    for (const tab of document.querySelectorAll(".pane-tab")) {
      const active = tab.dataset.panel === name;
      tab.classList.toggle("active", active);
      tab.setAttribute("aria-selected", String(active));
    }
    for (const panel of document.querySelectorAll(".panel")) {
      panel.classList.toggle("active", panel.dataset.panel === name);
    }
    if (window.matchMedia("(max-width: 900px)").matches) {
      const active = document.querySelector('.panel[data-panel="' + name + '"]');
      active?.scrollIntoView({ block: "start", behavior: "auto" });
    }
    if (name === "notes") refreshNotes();
  }

  for (const tab of document.querySelectorAll(".pane-tab")) {
    tab.addEventListener("click", () => activatePanel(tab.dataset.panel));
  }

  function formatNoteTime(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    return date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  }

  function unitLabel(unit) {
    if (!unit) return "原文来源";
    return unit.title?.startsWith(unit.chapter) ? unit.title : unit.chapter + " · " + unit.title;
  }

  function friendlyUnitLabel(nodeId, fallback) {
    const unit = units.find((item) => item.id === nodeId);
    return unit ? unitLabel(unit) : fallback;
  }

  function renderNotes() {
    const list = $("notesList");
    const empty = $("notesEmpty");
    const count = $("noteCount");
    list.replaceChildren();
    if (count) {
      count.textContent = String(notes.length);
      count.hidden = notes.length === 0;
    }
    if (empty) {
      empty.hidden = notes.length > 0;
      empty.textContent = productionRuntime
        ? "还没有笔记。读到有感觉的句子，点“记一条”写下来。"
        : "当前是只读阅读模式，笔记需要本地 Repository 可用。";
    }
    for (const note of notes) {
      const reference = note.sourceReferences?.[0];
      const card = document.createElement("article");
      card.className = "note-card";
      const head = document.createElement("div");
      head.className = "note-card-head";
      const locator = document.createElement("span");
      locator.className = "note-locator";
      locator.textContent = reference ? friendlyUnitLabel(reference.structureNodeId, reference.locator) : "未关联原文";
      const time = document.createElement("span");
      time.className = "note-time";
      time.textContent = formatNoteTime(note.updatedAt);
      head.append(locator, time);
      const content = document.createElement("p");
      content.className = "note-content";
      content.textContent = note.content;
      const actions = document.createElement("div");
      actions.className = "note-actions";
      if (reference) {
        const jump = document.createElement("button");
        jump.type = "button";
        jump.className = "text-button";
        jump.textContent = "回到原文 ↗";
        jump.addEventListener("click", () => showCitation(reference.structureNodeId));
        actions.append(jump);
      }
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "text-button";
      edit.textContent = "编辑";
      edit.addEventListener("click", () => openNoteEditor(note));
      actions.append(edit);
      card.append(head, content, actions);
      list.append(card);
    }
  }

  async function refreshNotes() {
    if (!productionRuntime) { notes = []; renderNotes(); return; }
    try {
      notes = await productionRuntime.loadNotes();
      renderNotes();
    } catch (error) {
      setGenerationStatus("笔记读取失败：" + errorText(error) + "。");
    }
  }

  function openNoteEditor(note = null) {
    if (!productionRuntime) {
      toast("当前是只读阅读模式，暂时不能记录笔记。");
      return;
    }
    const unit = state.displayedUnit;
    $("noteId").value = note?.id || "";
    $("noteBaseRevision").value = note ? String(note.revision) : "";
    $("noteInput").value = note?.content || "";
    $("noteDialogEyebrow").textContent = note ? "编辑笔记" : "读书笔记";
    $("noteDialogTitle").textContent = note ? "修改这条笔记" : "记一条笔记";
    const reference = note?.sourceReferences?.[0];
    $("noteDialogSource").textContent = reference
      ? "关联原文：" + friendlyUnitLabel(reference.structureNodeId, reference.locator)
      : unit ? "关联原文：" + unitLabel(unit) : "未关联原文位置";
    $("noteDialogStatus").textContent = note ? "笔记只由你修改，Agent 不会覆盖你的内容。" : "";
    $("noteSaveButton").disabled = false;
    $("noteDialog").showModal();
    setTimeout(() => $("noteInput").focus(), 30);
  }

  async function saveNoteFromDialog() {
    if (!productionRuntime) return;
    const button = $("noteSaveButton");
    const content = $("noteInput").value.trim();
    if (!content) {
      $("noteDialogStatus").textContent = "写点内容再保存。";
      return;
    }
    const id = $("noteId").value;
    const baseRevision = Number($("noteBaseRevision").value || 0);
    button.disabled = true;
    $("noteDialogStatus").textContent = "正在保存…";
    try {
      if (id) {
        await productionRuntime.updateNote({ id, content, baseRevision });
      } else {
        const unit = state.displayedUnit;
        await productionRuntime.createNote({ content, unitId: unit?.id, unitLocator: unit?.locator });
      }
      $("noteDialog").close();
      await refreshNotes();
      activatePanel("notes");
      toast(id ? "笔记已更新，只保存了你写的内容。" : "笔记已保存，并关联到当前原文。");
    } catch (error) {
      $("noteDialogStatus").textContent = errorText(error) + "。";
      button.disabled = false;
    }
  }

  $("noteButton").addEventListener("click", () => openNoteEditor());
  $("railNoteButton").addEventListener("click", () => openNoteEditor());
  $("addNoteButton").addEventListener("click", () => openNoteEditor());
  $("noteCancelButton").addEventListener("click", () => $("noteDialog").close());
  $("noteSaveButton").addEventListener("click", saveNoteFromDialog);
  $("noteInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      saveNoteFromDialog();
    }
  });
  $("railMemoryButton").addEventListener("click", () => activatePanel("memory"));
  $("extractMemoryButton").addEventListener("click", async () => {
    if (!productionRuntime) { toast("当前是只读阅读模式，暂时不能整理认知。"); return; }
    const button = $("extractMemoryButton");
    button.disabled = true;
    $("memoryStatus").textContent = "正在整理这次讨论…";
    try {
      renderMemoryState(await productionRuntime.extractMemories());
      toast("认知整理完成，候选记录已写入本地。");
    } catch (error) {
      $("memoryStatus").textContent = "认知整理失败：" + errorText(error) + "。可再点“整理这次讨论”重试。";
    } finally {
      button.disabled = false;
    }
  });


  const bookSelector = $("bookSelector");
  if (bookSelector) {
    const serviceOption = bookSelector.querySelector('option[value="service"]');
    const localOption = bookSelector.querySelector('option[value="local"]');
    if (serviceOption) serviceOption.disabled = !(readerConfig.apiBaseUrl && readerConfig.bookRevisionId);
    if (localOption) {
      localOption.hidden = !activeLocalBookPackageId;
      localOption.disabled = !activeLocalBookPackageId;
    }
    bookSelector.value = activeSource === "github" ? queryBookId : activeSource;
    bookSelector.addEventListener("change", () => {
      const next = bookSelector.value;
      const params = new URLSearchParams(window.location.search);
      if (next === "service") {
        params.delete("book");
        params.delete("localBookRevision");
        try { window.localStorage.removeItem("read-book:prefer-local-book"); } catch {}
      } else if (next === "local") {
        params.delete("book");
        if (activeLocalBookPackageId) params.set("localBookRevision", activeLocalBookPackageId);
      } else {
        params.delete("localBookRevision");
        params.set("book", next);
      }
      const query = params.toString();
      window.location.search = query ? "?" + query : "";
    });
  }

  const libraryButton = $("libraryButton");
  const libraryDialog = $("libraryDialog");
  if (libraryButton && libraryDialog) {
    $("libraryCloseButton")?.addEventListener("click", () => libraryDialog.close());
    libraryButton.addEventListener("click", async () => {
      const list = $("libraryList");
      const empty = $("libraryListEmpty");
      list.replaceChildren();
      empty.hidden = true;
      libraryButton.disabled = true;
      try {
        const packages = await listImportedBookPackages();
        for (const item of packages) {
          const button = document.createElement("button");
          button.type = "button";
          button.className = "library-item" + (item.bookRevisionId === activeLocalBookPackageId ? " active" : "");
          const title = document.createElement("strong");
          title.textContent = item.title || "未命名书籍";
          const meta = document.createElement("span");
          const importedAt = item.importedAt ? new Date(item.importedAt) : null;
          meta.textContent = [
            item.author || "",
            importedAt && !Number.isNaN(importedAt.getTime())
              ? "导入于 " + importedAt.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
              : "",
          ].filter(Boolean).join(" · ");
          button.append(title, meta);
          button.addEventListener("click", () => {
            const params = new URLSearchParams(window.location.search);
            params.delete("book");
            params.set("localBookRevision", item.bookRevisionId);
            window.location.search = params.toString();
          });
          list.append(button);
        }
        if (!packages.length) empty.hidden = false;
        libraryDialog.showModal();
      } catch (error) {
        setGenerationStatus("读取本地书库失败：" + errorText(error) + "。");
      } finally {
        libraryButton.disabled = false;
      }
    });
  }

  async function initializeReader() {
    try {
      if (isDemoProvider) {
        bookContentProvider = createDemoBookContentProvider();
      } else if (isGithubCorpusMode || isBundledMode) {
        state.messages = [];
        messageList.replaceChildren();
        bookContentProvider = isBundledMode ? createBundledBookContentProvider() : createGithubCorpusProvider();
      } else if (useLocalBookPackage) {
        state.messages = [];
        messageList.replaceChildren();
        bookContentProvider = createLocalBookPackageProvider();
      } else {
        state.messages = [];
        messageList.replaceChildren();
        if (!readerConfig.apiBaseUrl || !readerConfig.bookRevisionId) {
          throw new Error("真实书籍模式必须同时提供 READ_BOOK_CONFIG.apiBaseUrl 和 bookRevisionId。");
        }
        const getAccessToken = readerConfig.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken;
        if (typeof getAccessToken !== "function") {
          throw new Error("真实模式需要通过 READ_BOOK_CONFIG.getAccessToken 或 READ_BOOK_AUTH.getAccessToken 提供登录令牌。");
        }
        bookContentProvider = createPublicBookApiProvider({
          baseUrl: readerConfig.apiBaseUrl,
          getAccessToken,
        });
      }
      if (!requestedBookRevisionId) throw new Error("真实书籍模式必须提供 READ_BOOK_CONFIG.bookRevisionId。");
      let sourceFallbackNotice = "";
      if (isGithubCorpusMode) {
        try {
          bookRevision = await bookContentProvider.loadBookRevision(requestedBookRevisionId);
        } catch (sourceError) {
          // 外部语料不可用（配额耗尽 / 断网 / 来源异常）时，页面不能整页失效：
          // 自动切到随仓库分发的内置读物，并保留可操作的说明与书籍切换入口。
          activeSource = "bundled";
          bookContentProvider = createBundledBookContentProvider();
          bookRevision = await bookContentProvider.loadBookRevision(BUNDLED_BOOK_REVISION_ID);
          if (bookSelector) bookSelector.value = "bundled";
          // URL 必须反映实际加载的内容：否则刷新时会再次请求已经失败的 GitHub 来源。
          const fallbackParams = new URLSearchParams(window.location.search);
          fallbackParams.delete("localBookRevision");
          fallbackParams.set("book", "bundled");
          window.history.replaceState({}, "", window.location.pathname + "?" + fallbackParams.toString());
          sourceFallbackNotice = sourceError?.code === "RATE_LIMITED"
            ? "GitHub 未认证配额已用尽（HTTP " + (sourceError.status || 403) + "），已自动切换到内置《传习录（节选）》。稍后可重试，或在右上角“选择阅读书籍”中切回 GitHub 书目。"
            : "GitHub 来源加载失败：" + errorText(sourceError) + "。已自动切换到内置《传习录（节选）》，可在右上角“选择阅读书籍”中切换。";
        }
      } else {
        bookRevision = await bookContentProvider.loadBookRevision(requestedBookRevisionId);
      }
      units = bookRevision.units;
      sourceRetriever = createSourceRetriever(units);
      state.mainlineIndex = units.findIndex(unit => unit.id === bookRevision.initialMainlineUnitId);
      if (state.mainlineIndex < 0) throw new Error("书籍主线起始单元不存在。");
      state.displayedUnit = units[state.mainlineIndex];
      renderChapterOptions();
      renderRailChapters();
      if (isCorpusSourceActive()) {
        state.discussed = true;
        $("menuButton").hidden = true;
        $("simulateFailure").hidden = true;
        try {
          const getAccessToken = readerConfig.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken;
          const hasAgentService = hasGenerationService(readerConfig, getAccessToken);
          productionRuntime = await createProductionReaderRuntime(runtimeConfigFor({
            ...readerConfig,
            getAccessToken,
            localOnly: readerConfig.localOnly === true || !hasAgentService,
          }), bookRevision);
          const position = productionRuntime.readingPosition;
          if (position) {
            const index = units.findIndex((unit) => unit.id === position.mainlineNodeId);
            if (index >= 0) state.mainlineIndex = index;
            state.viewMode = position.viewMode || "mainline";
            state.displayedUnit = units.find((unit) => unit.id === position.displayedNodeId) || units[state.mainlineIndex];
            state.discussed = Boolean(position.currentUnitDiscussed);
          }
          $("conversationSection").hidden = false;
          $("composerSection").hidden = !productionRuntime.generationConfigured;
          $("memoryPanel").hidden = false;
          $("backupButton").disabled = false;
          $("backupButton").textContent = productionRuntime.backupStatus.label;
          $("readerModeLabel").textContent = productionRuntime.generationConfigured
            ? (activeSource === "github" ? "GitHub 原文" : "内置读物") + " · Agent 接口已配置"
            : (activeSource === "github" ? "GitHub 原文" : "内置读物") + " · 本地阅读";
          await refreshPersistedMessages({ forceScroll: true });
          await refreshNotes();
          renderMemoryState(await productionRuntime.loadMemoryState());
          renderSource();
          updateCount();
          const cachedCount = bookRevision.sourceMetadata?.cacheFallbackCount || 0;
          const cacheMessage = activeSource === "github" && cachedCount
            ? "本次有 " + cachedCount + " 个来源资源由离线缓存提供。"
            : activeSource === "github" ? "已启用在线优先的本机来源缓存。" : "";
          const agentMessage = productionRuntime.generationConfigured
            ? "Agent 接口已配置，生成结果仍以服务端权威响应为准"
            : "Agent 配置不完整，当前使用本地阅读与历史查看模式";
          if (sourceFallbackNotice) {
            setGenerationStatus(sourceFallbackNotice + " 已载入 " + units.length + " 个内置阅读单元，可离线阅读与讨论（" + agentMessage + "）。");
          } else if (activeSource === "bundled") {
            setGenerationStatus("已加载内置《传习录（节选）》" + units.length + " 个阅读单元，离线可用，不依赖网络配额。" + agentMessage + "。");
          } else {
            setGenerationStatus("已从 GitHub 读取 " + units.length + " 个阅读单元。" + cacheMessage + " " + agentMessage + "。" + productionRuntime.backupStatus.detail);
          }
        } catch (runtimeError) {
          productionRuntime = null;
          try {
            productionRuntime = await createLocalCorpusRuntime(bookRevision, {
              datasetId: readerConfig.localDataSetId || undefined,
            });
            const position = productionRuntime.readingPosition;
            if (position) {
              const index = units.findIndex((unit) => unit.id === position.mainlineNodeId);
              if (index >= 0) state.mainlineIndex = index;
              state.viewMode = position.viewMode || "mainline";
              state.displayedUnit = units.find((unit) => unit.id === position.displayedNodeId) || units[state.mainlineIndex];
              state.discussed = Boolean(position.currentUnitDiscussed);
            }
            $("conversationSection").hidden = true;
            $("composerSection").hidden = true;
            $("memoryPanel").hidden = true;
            $("backupButton").disabled = true;
            $("backupButton").textContent = "备份未配置";
            $("readerModeLabel").textContent = (activeSource === "github" ? "GitHub 原文" : "内置读物") + " · 本地只读";
            renderSource();
            updateCount();
            setGenerationStatus("正式阅读运行时初始化失败，已降级为本地只读阅读。阅读位置可本地保存；Agent/云端备份未启用。原因：" + errorText(runtimeError) + "。");
          } catch (localError) {
            productionRuntime = null;
            $("conversationSection").hidden = true;
            $("composerSection").hidden = true;
            $("memoryPanel").hidden = true;
            $("backupButton").disabled = true;
            $("backupButton").textContent = "备份未配置";
            $("readerModeLabel").textContent = (activeSource === "github" ? "GitHub 原文" : "内置读物") + " · 在线只读";
            renderSource();
            updateCount();
            setGenerationStatus("本地 Repository 不可用，当前仅显示在线原文。运行时错误：" + errorText(runtimeError) + "；本地存储错误：" + errorText(localError) + "。");
          }
        }
        return;
      }
      if (isDemoProvider) {
        const initialMessages = state.messages;
        state.messages = [];
        messageList.replaceChildren();
        for (const message of initialMessages) appendMessage(message);
        renderSource();
        updateCount();
        scrollIfFollowing(true);
        setGenerationStatus("演示内容已通过 BookContentProvider 加载；尚未连接真实书籍服务。");
        return;
      }

      productionRuntime = await createProductionReaderRuntime(runtimeConfigFor({
        ...readerConfig,
        // A locally generated BookRevision ID is not registered with a remote
        // Generation service. Keep imported packages local unless the host
        // explicitly declares that it can serve locally generated revisions.
        localOnly: useLocalBookPackage && readerConfig.allowLocalBookGeneration !== true,
      }), bookRevision);
      const position = productionRuntime.readingPosition;
      if (position) {
        const index = units.findIndex(unit => unit.id === position.mainlineNodeId);
        if (index >= 0) state.mainlineIndex = index;
        state.viewMode = position.viewMode || "mainline";
        state.displayedUnit = units.find(unit => unit.id === position.displayedNodeId) || units[state.mainlineIndex];
        state.discussed = Boolean(position.currentUnitDiscussed);
      }
      renderSource();
      await refreshPersistedMessages({ forceScroll: true });
      await refreshNotes();
      renderMemoryState(await productionRuntime.loadMemoryState());
      $("messageInput").disabled = !productionRuntime.generationConfigured;
      $("sendButton").disabled = !productionRuntime.generationConfigured;
      $("simulateFailure").hidden = true;
      $("menuButton").hidden = true;
      $("backupButton").textContent = productionRuntime.backupStatus.label;
      $("readerModeLabel").textContent = productionRuntime.generationConfigured ? "本地阅读 · Agent 已配置" : "本地导入书籍 · 阅读模式";
      setGenerationStatus(productionRuntime.generationConfigured
        ? "本地阅读数据已加载；讨论消息先保存到本地，再请求 Agent。"
        : "本地书籍、阅读主线和讨论历史已保存到当前浏览器。Agent 与云端备份尚未配置。");
      if (productionRuntime.generationConfigured) productionRuntime.resumePending({
        onDelta: () => {},
        onMemoryUpdate: renderMemoryState,
      }).then(async () => {
        await refreshPersistedMessages({ forceScroll: true });
        renderMemoryState(await productionRuntime.loadMemoryState());
      }).catch(error => {
        setGenerationStatus("有未完成的生成任务，自动恢复暂不可用：" + errorText(error) + "。可对下方标记为“上次生成被中断”的回复点“重新生成”。");
      });
    } catch (error) {
      $("sourceHeading").textContent = "书籍内容加载失败";
      $("sourceText").textContent = "当前无法加载此书籍版本，请检查网络、来源仓库和内容提供器配置。";
      setGenerationStatus("内容加载失败：" + errorText(error) + "。");
      $("messageInput").disabled = true;
      $("sendButton").disabled = true;
      $("simulateFailure").disabled = true;
    }
  }

  initializeReader();
})();
