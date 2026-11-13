(() => {
  const units = [
    {
      id: "unit-0", chapter: "第一章 / 协同的基础", title: "共同目标", locator: "第一章 · 论述单元 00",
      text: "协作开始之前，参与者需要先明确共同目标。目标应说明要解决的问题和期望产生的结果，而不是把某项活动本身当成目标。"
    },
    {
      id: "unit-1", chapter: "第一章 / 协同的基础", title: "协同效率与沟通", locator: "第一章 · 论述单元 01",
      text: "协同效率并不等于沟通次数增加。它取决于参与者是否围绕同一目标行动，以及关键交接是否清楚。沟通频繁但目标不一致，只会更快放大分歧。"
    },
    {
      id: "unit-2", chapter: "第一章 / 协同的基础", title: "共同目标如何落地", locator: "第一章 · 论述单元 02",
      text: "共同目标需要被转化为可观察的阶段结果。每个参与者应知道自己负责的输入、输出和完成条件。目标不能只停留在口号，也不能用单一活动量代替结果。"
    },
    {
      id: "unit-3", chapter: "第二章 / 接口与交接", title: "接口契约", locator: "第二章 · 论述单元 01",
      text: "接口契约至少说明输入、输出、责任人、时限和异常处理方式。交接双方应对完成条件有共同定义。缺少契约时，问题容易在部门边界反复传递。"
    },
    {
      id: "unit-4", chapter: "第二章 / 接口与交接", title: "异常闭环", locator: "第二章 · 论述单元 02",
      text: "异常闭环包括发现、归属、处理、验证和复盘。仅仅把问题转交给另一个团队不算闭环；必须有人确认结果，并把重复发生的原因反馈到流程设计。"
    }
  ];

  const state = {
    mainlineIndex: 1,
    displayedUnit: units[1],
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
    if (message.saved) {
      const saved = document.createElement("span");
      saved.className = "saved-label";
      saved.textContent = "本地已保存";
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
      label.textContent = "引用 · " + (message.citation === "unit-1" ? "第一章 / 协同的基础" : "第二章 / 接口与交接");
      const quote = document.createElement("p");
      quote.textContent = "“" + (message.citation === "unit-1" ? units[1].text.slice(0, 55) : units[3].text.slice(0, 55)) + "……”";
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
      retry.addEventListener("click", retryLast);
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

  function sendMessage() {
    if (state.generating) return;
    const input = $("messageInput");
    const value = input.value.trim();
    if (!value) {
      toast("先输入一段想法再发送。");
      input.focus();
      return;
    }
    appendMessage({ role: "user", text: value, saved: true });
    input.value = "";
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

  $("temporaryButton").addEventListener("click", () => $("temporaryDialog").showModal());
  document.querySelectorAll("[data-unit]").forEach(button => {
    button.addEventListener("click", () => {
      const unit = units.find(item => item.id === button.dataset.unit);
      if (!unit) return;
      state.displayedUnit = unit;
      state.viewMode = "temporary";
      $("temporaryDialog").close();
      renderSource();
    });
  });

  $("returnMainline").addEventListener("click", returnToMainline);

  $("continueButton").addEventListener("click", () => {
    if (state.viewMode !== "mainline") {
      toast("先回到当前主线，再继续阅读。");
      return;
    }
    if (!state.discussed) {
      const confirmed = window.confirm("当前论述单元还没有讨论。是否略读当前单元并继续？");
      if (!confirmed) return;
    }
    if (state.mainlineIndex >= units.length - 1) {
      toast("演示主线已到最后一个单元。");
      return;
    }
    state.mainlineIndex += 1;
    state.displayedUnit = units[state.mainlineIndex];
    state.viewMode = "mainline";
    state.discussed = false;
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

  $("backupButton").addEventListener("click", () => toast("演示状态：启动备份检查已完成，没有真实上传。"));
  $("menuButton").addEventListener("click", () => {
    state.discussed = !state.discussed;
    toast(state.discussed ? "演示状态：当前单元标记为已讨论。" : "演示状态：当前单元标记为未讨论，可测试继续前确认。");
  });

  messageList.addEventListener("scroll", () => {
    nearBottom = messageList.scrollHeight - messageList.scrollTop - messageList.clientHeight < 48;
  });
  document.querySelectorAll("[data-citation]").forEach(button => {
    button.addEventListener("click", () => showCitation(button.dataset.citation));
  });

  renderSource();
  updateCount();
  messageList.scrollTop = messageList.scrollHeight;
})();
