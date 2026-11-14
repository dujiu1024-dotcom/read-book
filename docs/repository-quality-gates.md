# Repository Quality Gates

Run the same checks locally:

```sh
node scripts/check-markdown-links.mjs
node scripts/validate-json-files.mjs
cd packages/book-package-validator
npm install
npm run validate:processing-contract
npm test
cd ../..
npx --yes @redocly/cli@1.27.1 lint --config .redocly.yaml docs/api-contract.yaml
```

The workflow is currently `workflow_dispatch` only. This is intentional: product owner requested one consolidated validation pass after implementation, so PR/main auto-runs are not enabled during the coding phase. After that final pass, change the trigger to `pull_request` and `push: branches: [main]`.

The Markdown checker validates repository-relative links only; external links are not network-fetched. The JSON checker parses all tracked JSON/JSONL-shaped files. The book package validator owns the package-specific schema and semantic checks. Redocly owns OpenAPI 3.1 parsing and linting.
