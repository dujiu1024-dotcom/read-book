const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 知识抽取走本地宿主代理：模型密钥只留在服务端，浏览器只拿到结构化结果。
 * 服务端已做来源校验，这里只负责传输与错误语义。
 */
export function createKnowledgeProxyProvider({ baseUrl, getAccessToken, fetchImpl = fetch }) {
  const root = String(baseUrl || "").replace(/\/+$/, "");

  async function postOnce(payload) {
    const token = typeof getAccessToken === "function" ? await getAccessToken() : "";
    if (!token) throw new Error("缺少本地访问令牌，无法调用知识抽取服务。");
    let response;
    try {
      response = await fetchImpl(root + "/v1/knowledge/extract", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + token },
        body: JSON.stringify(payload),
      });
    } catch (cause) {
      const error = new Error("知识抽取服务连接失败，请检查网络后重试");
      error.retryable = true;
      error.cause = cause;
      throw error;
    }
    let body = null;
    try { body = await response.json(); } catch { body = null; }
    if (!response.ok) {
      const code = body?.error?.code || "proxy_error";
      const error = new Error("知识抽取服务返回 " + response.status + "（" + code + "）：" + (body?.error?.message || "未知错误"));
      error.status = response.status;
      error.retryable = RETRYABLE_STATUS.has(response.status);
      throw error;
    }
    if (!body || !Array.isArray(body.items)) {
      throw new Error("知识抽取服务没有返回 items 数组，请重试");
    }
    return body;
  }

  return {
    model: "knowledge-proxy",
    async extract({ bookRevisionId, chapter, chunks, focus, model, genre }) {
      let lastError;
      for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
        try {
          return await postOnce({
            book_revision_id: bookRevisionId,
            chapter,
            chunks,
            ...(focus ? { focus } : {}),
            ...(genre ? { genre } : {}),
            ...(model ? { model } : {}),
          });
        } catch (error) {
          lastError = error;
          if (!error.retryable || attempt === MAX_ATTEMPTS - 1) throw error;
          await delay(400 * (attempt + 1));
        }
      }
      throw lastError;
    },
  };
}
