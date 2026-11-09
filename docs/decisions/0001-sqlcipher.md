# 0001 — SQLCipher with Drizzle and FTS5 (gate V1)

- **Date:** 2026-11-09
- **Status:** accepted

## Question

Does `better-sqlite3-multiple-ciphers` in SQLCipher mode (`cipher=sqlcipher`, `legacy=4`) work with Drizzle migrations and FTS5? (Spec §15, V1.)

## Evidence

`apps/server/src/db/db.test.ts` checks that the file header is not plain SQLite, that a wrong passphrase is refused, that Drizzle reads data back, and that an FTS5 query matches.

```
 Test Files  1 passed (1)
      Tests  3 passed (3)
```

## Decision

Use `better-sqlite3-multiple-ciphers` with Drizzle. The passphrase is the hex form of `deriveKey(masterKey, "database")`.

## Integration notes

- Drizzle's `better-sqlite3` driver imports the `better-sqlite3` package by name, so `apps/server` aliases it to the fork: `"better-sqlite3": "npm:better-sqlite3-multiple-ciphers@^13.0.3"`.
- The fork's `package.json` `exports` map has no `types` condition, so `apps/server/tsconfig.json` maps the module to its bundled `index.d.ts` through `paths`.
