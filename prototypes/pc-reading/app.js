import { createDemoBookContentProvider } from "./book-content-provider.js";
import { createPublicBookApiProvider } from "./public-book-content-provider.js";
import { createGithubCorpusProvider } from "./github-corpus-provider.js";
import { createProductionReaderRuntime } from "./reader-runtime.js";
import { createLocalBookPackageProvider, importBookPackageFile } from "./local-book-package-provider.js";

(() => {
  let units = [];
  let bookRevision = null;
  const readerConfig = window.READ_BOOK_CONFIG || {};
  const queryParams = new URLSearchParams(window.location.search);
  const queryBookId = queryParams.get("book");
  const queryLocalBookId = queryParams.get("localBookRevision");
  const isGithubCorpusMode = Boolean(queryBookId && queryBookId !== "demo");
  const activeLocalBookPackageId = readerConfig.localBookPackageId || queryLocalBookId || (() => {
    try { return window.localStorage.getItem("read-book:active-local-book") || ""; } catch { return ""; }
  })();
  const preferLocalBookPackage = Boolean(readerConfig.localBookPackageId || queryLocalBookId) || (() => {
    try { return window.localStorage.getItem("read-book:prefer-local-book") === "true"; } catch { return false; }
  })();
  const useLocalBookPackage = Boolean(activeLocalBookPackageId && !queryBookId && (preferLocalBookPackage || !readerConfig.bookRevisionId));
  const isDemoProvider = queryBookId === "demo" || (!isGithubCorpusMode && !useLocalBookPackage && !readerConfig.apiBaseUrl && !readerConfig.bookRevisionId);
  let bookContentProvider = null;
  let productionRuntime = null;
  const requestedBookRevisionId = isGithubCorpusMode
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
  let nearBottom = true;
  let toastTimer = null;

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
    $("sourceTag").textContent = isGithubCorpusMode ? "GitHub 公开语料" : useLocalBookPackage ? "本地书籍包" : "原书内容";
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
    $("sourceLocator").textContent = unit.locator;
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
    if (productionRuntime) productionRuntime.savePosition(state, units).catch((error) => setGenerationStatus("阅读位置保存失败：" + error.message));
  }

  function updateCount() {
    $("messageCount").textContent = state.messages.length + " 条消息";
  }

  function scrollIfFollowing() {
    if (nearBottom) {
      messageList.scrollTop = messageList.scrollHeight;
    }
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
    if (message.citation) {
      const citation = document.createElement("div");
      citation.className = "citation-card";
      const label = document.createElement("div");
      label.className = "citation-label";
      const citedUnit = units.find(item => item.id === message.citation);
      label.textContent = "引用 · " + (citedUnit?.chapter || "原文来源");
      const quote = document.createElement("p");
      quote.textContent = citedUnit ? "“" + citedUnit.text.slice(0, 55) + "……”" : "引用来源暂不可用。";
      const link = document.createElement("button");
      link.type = "button";
      link.className = "text-button citation-link";
      link.textContent = "查看原文位置 ↗";
      link.addEventListener("click", () => showCitation(message.citation));
      citation.append(label, quote, link);
      content.append(citation);
    }
    if (message.failed) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.className = "text-button";
      retry.textContent = "重试";
      retry.addEventListener("click", async () => {
        retry.disabled = true;
        if (productionRuntime) {
          setGenerating(true);
          setGenerationStatus("正在使用原始输入重新发起生成…");
          try {
            await productionRuntime.retryFailedGeneration(message.id);
            await refreshPersistedMessages();
            setGenerationStatus("重试完成，原始用户消息未重复写入。");
          } catch (error) {
            setGenerationStatus("重试失败：" + error.message);
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
    const unit = units.find(item => item.id === unitId) || units[state.mainlineIndex];
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
    $("generationStatus").textContent = message;
  }

  function setGenerating(value) {
    state.generating = value;
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
    }, 900);
  }

  async function sendMessage() {
    if (state.generating) return;
    const input = $("messageInput");
    const value = input.value.trim();
    if (!value) {
      toast("先输入一段想法再发送。");
      input.focus();
      return;
    }
    input.value = "";
    if (productionRuntime) {
      const userBubble = { role: "user", text: value, time: "刚刚", saving: true };
      appendMessage(userBubble);
      const userArticle = messageList.lastElementChild;
      const assistantBubble = { role: "agent", text: "", time: "刚刚" };
      appendMessage(assistantBubble);
      const assistantArticle = messageList.lastElementChild;
      const assistantText = assistantArticle.querySelector(".message-content > p");
      setGenerating(true);
      setGenerationStatus("正在将消息保存到本地…");
      try {
        const result = await productionRuntime.send(value, state.displayedUnit, {
          onPersisted() {
            userBubble.saving = false;
            userBubble.saved = true;
            const label = userArticle.querySelector(".saved-label");
            if (label) label.textContent = "本地已保存";
            setGenerationStatus("本地已保存 · Agent 正在生成");
          },
          onDelta(text) {
            assistantText.textContent += text;
          },
          onMemoryUpdate(memoryState) { renderMemoryState(memoryState); },
          onMemoryError(error) { setGenerationStatus("回复已保存，但自动认知抽取失败：" + error.message); },
        });
        assistantText.textContent = result.snapshot.result?.content || assistantText.textContent;
        await refreshPersistedMessages();
        // Do not infer an Assistant citation from the user's current reading position.
        // Only persisted, service-verified sourceReferences may render a citation card.
        state.discussed = true;
        setGenerationStatus("回复已完成并保存。");
        productionRuntime.savePosition(state, units).catch(() => {});
      } catch (error) {
        setGenerationStatus("生成未完成：" + error.message + "。原始输入保留在本地，可稍后恢复。");
        await refreshPersistedMessages();
      } finally {
        setGenerating(false);
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
    if (!state.discussed && !isGithubCorpusMode) {
      const confirmed = window.confirm("当前论述单元还没有讨论。是否略读当前单元并继续？");
      if (!confirmed) return;
    }
    if (state.mainlineIndex >= units.length - 1) {
      toast(isGithubCorpusMode ? "当前书籍已到最后一个阅读单元。" : "演示主线已到最后一个单元。");
      return;
    }
    state.mainlineIndex += 1;
    state.displayedUnit = units[state.mainlineIndex];
    state.viewMode = "mainline";
    state.discussed = isGithubCorpusMode;
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
    if (productionRuntime) {
      productionRuntime.stop();
      setGenerationStatus("已请求停止生成；最终状态以服务端确认为准。");
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
      setGenerationStatus("书籍导入失败：" + error.message);
      button.disabled = false;
      event.target.value = "";
    }
  });

  messageList.addEventListener("scroll", () => {
    nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 48;
  });
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
      if (versions.length > 1) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        summary.textContent = "查看认知演变历史（" + versions.length + " 个版本）";
        details.append(summary);
        for (const version of versions) {
          const item = document.createElement("p");
          item.className = "memory-history-item";
          item.textContent = "v" + version.version + " · " + version.changeKind + " · " + version.content;
          details.append(item);
        }
        card.append(details);
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
          setGenerationStatus("认知确认失败：" + error.message);
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
          setGenerationStatus("处理待确认认知失败：" + error.message);
        }
      });
      actions.append(confirm, reject);
      card.append(heading, meta, content, actions);
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

  async function refreshPersistedMessages() {
    if (!productionRuntime) return;
    const persisted = await productionRuntime.loadMessages();
    state.messages = [];
    messageList.replaceChildren();
    for (const item of persisted) {
      const message = item.message;
      appendMessage({
        id: message.id,
        role: message.role === "user" ? "user" : "agent",
        text: message.content || (message.status === "generating" ? "正在生成…" : "本次生成未返回内容。"),
        time: message.createdAt ? new Date(message.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "刚刚",
        saved: message.role === "user",
        failed: message.status === "failed" || message.status === "cancelled",
        citation: message.sourceReferences?.[0]?.structureNodeId,
      });
    }
  }

  const bookSelector = $("bookSelector");
  if (bookSelector) {
    const serviceOption = bookSelector.querySelector('option[value="service"]');
    const localOption = bookSelector.querySelector('option[value="local"]');
    if (serviceOption) serviceOption.disabled = !(readerConfig.apiBaseUrl && readerConfig.bookRevisionId);
    if (localOption) {
      localOption.hidden = !activeLocalBookPackageId;
      localOption.disabled = !activeLocalBookPackageId;
    }
    bookSelector.value = useLocalBookPackage ? "local" : isGithubCorpusMode ? queryBookId : (queryBookId === "demo" || isDemoProvider ? "demo" : "service");
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

  async function initializeReader() {
    try {
      if (isDemoProvider) {
        bookContentProvider = createDemoBookContentProvider();
      } else if (isGithubCorpusMode) {
        state.messages = [];
        messageList.replaceChildren();
        bookContentProvider = createGithubCorpusProvider();
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
      bookRevision = await bookContentProvider.loadBookRevision(requestedBookRevisionId);
      units = bookRevision.units;
      state.mainlineIndex = units.findIndex(unit => unit.id === bookRevision.initialMainlineUnitId);
      if (state.mainlineIndex < 0) throw new Error("书籍主线起始单元不存在。");
      state.displayedUnit = units[state.mainlineIndex];
      renderChapterOptions();
      if (isGithubCorpusMode) {
        $("conversationSection").hidden = true;
        $("composerSection").hidden = true;
        $("memoryPanel").hidden = true;
        $("menuButton").hidden = true;
        $("readerModeLabel").textContent = "GitHub 公开语料 · 只读模式";
        $("backupButton").disabled = true;
        $("backupButton").textContent = "备份未接入";
        state.discussed = true;
        renderSource();
        updateCount();
        setGenerationStatus("已从原始 GitHub 仓库读取 " + units.length + " 个阅读单元。当前为只读语料模式，尚未接入本地持久化和真实 Agent。");
        return;
      }
      if (isDemoProvider) {
        renderSource();
        updateCount();
        messageList.scrollTop = messageList.scrollHeight;
        setGenerationStatus("演示内容已通过 BookContentProvider 加载；尚未连接真实书籍服务。");
        return;
      }

      const hasAgentConfiguration = Boolean(
        (readerConfig.getAccessToken || window.READ_BOOK_AUTH?.getAccessToken) &&
        (readerConfig.generationApiBaseUrl || readerConfig.apiBaseUrl) &&
        readerConfig.localDataSetId
      );
      productionRuntime = await createProductionReaderRuntime({
        ...readerConfig,
        localOnly: useLocalBookPackage && !hasAgentConfiguration,
      }, bookRevision);
      const position = productionRuntime.readingPosition;
      if (position) {
        const index = units.findIndex(unit => unit.id === position.mainlineNodeId);
        if (index >= 0) state.mainlineIndex = index;
        state.viewMode = position.viewMode || "mainline";
        state.displayedUnit = units.find(unit => unit.id === position.displayedNodeId) || units[state.mainlineIndex];
        state.discussed = Boolean(position.currentUnitDiscussed);
      }
      renderSource();
      await refreshPersistedMessages();
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
        await refreshPersistedMessages();
        renderMemoryState(await productionRuntime.loadMemoryState());
      }).catch(error => {
        setGenerationStatus("有未完成的生成任务，自动恢复暂不可用：" + error.message);
      });
    } catch (error) {
      $("sourceHeading").textContent = "书籍内容加载失败";
      $("sourceText").textContent = "当前无法加载此书籍版本，请检查网络、来源仓库和内容提供器配置。";
      setGenerationStatus("内容加载失败：" + error.message);
      $("messageInput").disabled = true;
      $("sendButton").disabled = true;
      $("simulateFailure").disabled = true;
    }
  }

  initializeReader();
})();
