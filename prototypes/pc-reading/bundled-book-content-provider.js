import bundledBook from "./bundled-book-data.js";
import { createBookContentProvider } from "./book-content-provider.js";

/**
 * 随仓库分发的兜底读物：《传习录》公版原文节选。
 *
 * 它不依赖任何网络请求，也不消耗 GitHub 未认证 API 配额。默认入口在外部来源
 * 不可用（例如 api.github.com 配额耗尽、断网）时自动回退到这里，保证页面仍能
 * 打开一本可读、可讨论的书。
 */
export const BUNDLED_BOOK_ID = "bundled";
export const BUNDLED_BOOK_REVISION_ID = "b7e5f0a2-3c4d-5e6f-8a90-1b2c3d4e5f60";

export function createBundledBookContentProvider() {
  return createBookContentProvider({
    async loadBookRevision(bookRevisionId) {
      if (bookRevisionId !== BUNDLED_BOOK_REVISION_ID) {
        throw new Error("内置读物不包含该版本：" + bookRevisionId + "。");
      }
      return bundledBook;
    },
  });
}
