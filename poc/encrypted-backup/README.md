# PoC B：端侧加密备份、恢复与清除墓碑

独立 PoC，不依赖 PoC A，不接入真实账号、真实用户数据或生产备份 API。

## 启动与测试

```bash
cd poc/encrypted-backup
npm install
npx playwright install chromium
npm run dev
npm test
npm run build
```

## 已实现

- 每个数据集随机生成 256-bit DEK；随机生成独立 256-bit 恢复密钥。
- 使用 AES-256-GCM 包装 DEK 与加密数据块；每块使用随机 96-bit nonce。
- AAD 绑定 dataset_id、backup_id、sequence、chunk_index、schema_version 和算法套件。
- Manifest 只包含协议字段、密文哈希、块大小、父备份 ID 和被包装的 DEK。
- Mock 服务端只保存密文和 Manifest，无解密接口。
- 模拟上传会话、分块上传、提交校验、幂等 init 和清除墓碑优先判定。
- 自动化覆盖备份往返、密文篡改检测、清除后旧备份不可访问。

## 关键限制（不得误读为安全验收）

- 当前是浏览器内存 Mock API，不是独立服务进程；尚未完成真实 HTTP、断点续传、重复上传和上传/清除竞态测试。
- 当前只覆盖单份全量备份，增量链与完整检查点尚未实现。
- 恢复凭证是随机高熵密钥的 Base64 展示，不是最终用户友好恢复口令；KDF、恢复凭证格式和密钥生命周期待安全评审。
- 尚未完成错误恢复凭证、父链断裂、缺块、重复请求、过期授权、预签名 URL、晚到上传请求、服务端日志脱敏等完整验收。
- Mock 服务端数据存在内存中，刷新页面后会丢失；不代表持久化实现。
- 本 PoC 只提供算法和状态语义验证起点，不能替代密码学审查、威胁建模或正式安全评审。
