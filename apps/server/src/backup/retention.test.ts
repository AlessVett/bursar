import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addDays, toLocalDate } from "@bursar/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listBackupSets, parseSetId } from "./backup";
import { LocalDirStore } from "./object-store";
import { pruneStore, retainedSetIds } from "./retention";

const ROME = "Europe/Rome";

/**
 * One set per day at 03:00 in Rome from 2026-09-20 to 2026-10-29 (40 sets). Summer time ends on
 * Sunday 2026-10-25, so 03:00 local is 01:00Z before that day and 02:00Z from that day on.
 */
function nightlySets(): string[] {
  const ids: string[] = [];
  for (let day = "2026-09-20"; day <= "2026-10-29"; day = addDays(day, 1)) {
    const hour = day >= "2026-10-25" ? "02" : "01";
    ids.push(`${day.replaceAll("-", "")}T${hour}0000Z`);
  }
  return ids;
}

describe("retainedSetIds", () => {
  it("keeps 7 daily, 4 weekly and 6 monthly sets across two months and a DST change", () => {
    const ids = nightlySets();
    expect(ids).toHaveLength(40);
    // Sanity check of the fixture: every set falls on its own local day.
    expect(new Set(ids.map((id) => toLocalDate(parseSetId(id) ?? 0, ROME))).size).toBe(40);
    // Two extra sets just after local midnight: on the UTC calendar they belong to the day before.
    const extra = ["20261024T223000Z", "20261027T233000Z"]; // 00:30 on Oct 25 (CEST) and Oct 28 (CET)
    const now = Date.parse("2026-10-29T02:00:00Z");

    const kept = retainedSetIds([...ids, ...extra], now, ROME);

    expect([...kept].sort()).toEqual([
      "20260930T010000Z", // monthly: September
      "20261011T010000Z", // weekly: ISO week of Oct 5
      "20261018T010000Z", // weekly: ISO week of Oct 12
      "20261023T010000Z", // daily ×7 (Oct 23–29); Oct 25 is also the newest of the week of Oct 19
      "20261024T010000Z",
      "20261025T020000Z",
      "20261026T020000Z",
      "20261027T020000Z",
      "20261028T020000Z",
      "20261029T020000Z", // newest, this week, this month
    ]);
  });

  it("always keeps the newest set, however old", () => {
    expect(
      retainedSetIds(
        ["20240101T020000Z", "20230101T020000Z"],
        Date.parse("2026-11-09T02:00:00Z"),
        ROME,
      ),
    ).toEqual(new Set(["20240101T020000Z"]));
    expect(
      retainedSetIds(
        ["20261108T020000Z", "20261109T020000Z"],
        Date.parse("2026-11-09T03:00:00Z"),
        ROME,
        { daily: 0, weekly: 0, monthly: 0 },
      ),
    ).toEqual(new Set(["20261109T020000Z"]));
  });

  it("buckets by the local day of the configured time zone", () => {
    const ids = ["20261024T213000Z", "20261024T223000Z"]; // 23:30 on Oct 24, 00:30 on Oct 25 in Rome
    const now = Date.parse("2026-10-25T12:00:00Z");
    const policy = { daily: 2, weekly: 0, monthly: 0 };
    expect(retainedSetIds(ids, now, ROME, policy)).toEqual(new Set(ids));
    expect(retainedSetIds(ids, now, "UTC", policy)).toEqual(new Set(["20261024T223000Z"]));
  });

  it("ignores ids that are not set ids and returns nothing for no sets", () => {
    expect(retainedSetIds(["notes", "2026-11-09"], Date.now(), ROME)).toEqual(new Set());
    expect(retainedSetIds([], Date.now(), ROME)).toEqual(new Set());
  });
});

describe("pruneStore", () => {
  let dir: string;
  let store: LocalDirStore;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-prune-"));
    store = new LocalDirStore(dir);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("deletes every set outside `keep`, incomplete ones included, and nothing else", async () => {
    const put = (key: string) => store.put(key, Buffer.from("x"));
    for (const id of ["20261101T020000Z", "20261108T020000Z", "20261109T020000Z"]) {
      await put(`${id}/bursar.db`);
      await put(`${id}/manifest.json`);
    }
    await put("20261105T020000Z/bursar.db"); // incomplete leftover of a failed upload
    await put("notes/readme.txt");

    const removed = await pruneStore(store, new Set(["20261108T020000Z", "20261109T020000Z"]));

    expect(removed).toBe(2);
    expect((await store.list("")).map((o) => o.key)).toEqual([
      "20261108T020000Z/bursar.db",
      "20261108T020000Z/manifest.json",
      "20261109T020000Z/bursar.db",
      "20261109T020000Z/manifest.json",
      "notes/readme.txt",
    ]);
    expect(await listBackupSets(store)).toEqual(["20261109T020000Z", "20261108T020000Z"]);
  });
});
