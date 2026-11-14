# Book Package Validator

Node 22.12+ CLI for validating a `read-book-package` 1.0.0 directory or ZIP. It is independent of the reader database and ingestion UI.

## Run

```sh
npm install
node src/cli.js ./path/to/package-or.zip
npm run validate:processing-contract
```

Exit codes: 0 valid, 1 invalid package, 2 CLI usage error. The package CLI emits a machine-readable JSON report.

## Validation coverage
- Draft 2020-12 JSON Schema validation for manifest, book, chapters, chunks, optional embeddings manifest, local report and processing contract.
- Directory traversal and symlink rejection; ZIP central-directory preflight for absolute paths, `..`, backslashes, duplicate/case-colliding paths, symlinks, encrypted entries, unsupported compression, ZIP64, oversized files, excessive total expansion and compression bombs.
- Source file size/SHA-256/extension; artifact existence and safe relative paths.
- Chapter ID/parent/order/cycle checks; chunk ID, chapter reference and content hash checks.
- Manifest counts, embedding chunk references and vector file hash.

## Explicit limits
- ZIP64 is intentionally rejected in v1.0.0.
- EPUB/PDF/TXT semantic parsing, copyright review, OCR quality, retrieval quality and rights approval are not performed by this validator.
- Local report is structurally checked but never treated as cloud acceptance evidence.
- Thresholds for OCR, text quality and retrieval are not invented; they require representative authorized samples.