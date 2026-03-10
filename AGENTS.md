# Cap'n Web Development Guide

## Cursor Cloud specific instructions

This is a pure TypeScript library (no services/databases). Development is build-and-test only.

- **Package manager:** npm (lockfile is `package-lock.json`). Use `npm ci` to install.
- **Node version:** 22 (matches CI).
- **Build:** `npm run build` (tsup). Must build before running tests or examples, since the workerd test project and examples import from `dist/`.
- **Tests:** `npm test` runs vitest across 5 projects: node, workerd (miniflare), chromium, firefox, webkit. A test HTTP server starts automatically via vitest `globalSetup`. Playwright browsers must be installed (`npx playwright install --with-deps chromium firefox webkit`).
- **Type tests:** `npm run test:types` (compile-only TypeScript check).
- **Lint:** No dedicated linter configured; `npm run test:types` is the closest static check.
- **Examples:** See `examples/README.md`. The `batch-pipelining` example can be run with `node examples/batch-pipelining/server-node.mjs` + `node examples/batch-pipelining/client.mjs`.
