# 0001 — SQLCipher with Drizzle and FTS5 (gate V1)

- **Date:** 2026-11-09
- **Status:** accepted

## Question

Does `better-sqlite3-multiple-ciphers` in SQLCipher mode (`cipher=sqlcipher`, `legacy=4`) work with Drizzle migrations and FTS5? (Spec §15, V1.)

## Evidence

`apps/server/src/db/db.test.ts` checks that the file header is not plain SQLite, that a wrong passphrase is refused, that Drizzle reads data back, that an empty or too short passphrase is rejected without creating a plaintext file, and that an FTS5 query matches.

Command: `pnpm --filter @bursar/server test src/db/db.test.ts`

```
 Test Files  1 passed (1)
      Tests  4 passed (4)
```

## Decision

Use `better-sqlite3-multiple-ciphers` with Drizzle. The passphrase is the hex form of `deriveKey(masterKey, "database")`.

## Integration notes

- `openDatabase` refuses a passphrase shorter than `MIN_PASSPHRASE_LENGTH` (16 characters). With an empty key SQLCipher would silently create an unencrypted database, so the guard runs before the file is opened.
- Drizzle's `better-sqlite3` driver imports the `better-sqlite3` package by name, so `apps/server` aliases it to the fork: `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@^13.0.3"`.
- The fork's `package.json` `exports` map has no `types` condition, so `apps/server/tsconfig.json` maps the module to its bundled `index.d.ts` through `paths`.
- tsx applies `paths` at runtime and would load that `index.d.ts` as code (`ReferenceError: Database is not defined`). The tsx scripts (`dev`, `bursar`) therefore pass `--tsconfig tsconfig.runtime.json`, a config without `paths`; `apps/server/src/tsx-runtime.test.ts` guards this. Vitest and tsup do not apply `paths`.
