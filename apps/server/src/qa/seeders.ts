import type { SeedContext } from "../server";

/**
 * Writes deterministic QA data into a freshly migrated database. Seeders are synchronous, use
 * `ctx.now()` for every date and never `Math.random`, so two runs with the same clock match.
 */
export type QaSeeder = (ctx: SeedContext) => void;

/** Seeders run in order by `seedQa`. Later tasks append theirs (Task 6: `seedBanking`). */
export const QA_SEEDERS: QaSeeder[] = [];
