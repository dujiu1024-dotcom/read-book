# Encrypted Backup PoC

Independent browser/Node Web Crypto PoC. Uses synthetic data and an in-memory mock server only; it does not connect to user datasets or production APIs.

## Included
- Random AES-256-GCM dataset key and independent 256-bit recovery credential.
- PBKDF2-SHA-256 key wrapping with configurable iteration count. The default is experimental and requires security review before production.
- Versioned full snapshots, ID-based incremental upserts/removals, configurable full-checkpoint cadence, and resumable chunk upload.
- Per-backup HKDF-derived AES-GCM subkeys, deterministic unique chunk-counter nonces, and AAD bound to dataset, backup, parent, schema version and chunk index. A new backup ID derives a distinct chunk key; retry must reuse the original ciphertext package rather than re-encrypting under the same ID.
- SHA-256 ciphertext manifest validation and full-chain restore into a temporary in-memory snapshot.
- Mock server that stores ciphertext only, supports idempotent upload and enforces a cleared-dataset tombstone against late upload completion and download.

## Run
`npm test`

## Explicit limitations
- No production storage, API, authentication, recovery UI, key rotation, device keystore, upload transport, or security review.
- The in-memory mock server is not a substitute for server-side atomic tombstone enforcement and audit logs.
- Incremental records are ID-based snapshot deltas; this PoC does not implement a production append-only event log or concurrent multi-device merge.
- Never commit recovery credentials or plaintext dataset keys. Production KDF parameters and recovery UX require independent security review.
