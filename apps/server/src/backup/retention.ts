import { addDays, diffDays, type LocalDate, toLocalDate } from "@bursar/shared";
import { MANIFEST_FILE, parseSetId } from "./backup";
import type { ObjectStore } from "./object-store";

export interface RetentionPolicy {
  daily: number;
  weekly: number;
  monthly: number;
}

/** Spec §6.12: 7 daily, 4 weekly, 6 monthly. */
export const DEFAULT_RETENTION: RetentionPolicy = { daily: 7, weekly: 4, monthly: 6 };

/** Monday of the ISO week that contains `date`. */
function isoWeekMonday(date: LocalDate): LocalDate {
  const weekday = new Date(`${date}T00:00:00Z`).getUTCDay(); // 0 = Sunday
  return addDays(date, -((weekday + 6) % 7));
}

function monthIndex(date: LocalDate): number {
  return Number(date.slice(0, 4)) * 12 + Number(date.slice(5, 7)) - 1;
}

/**
 * The set ids to keep. Buckets are calendar windows in `timeZone` ending at `now`: the newest
 * set of each of the last `daily` local days (today included), of each of the last `weekly` ISO
 * weeks (this week included) and of each of the last `monthly` months (this month included).
 * The newest set is always kept, whatever its age. Ids that are not set ids are ignored.
 */
export function retainedSetIds(
  setIds: readonly string[],
  now: number,
  timeZone: string,
  policy: RetentionPolicy = DEFAULT_RETENTION,
): Set<string> {
  const dated = setIds
    .map((id) => ({ id, at: parseSetId(id) }))
    .filter((entry): entry is { id: string; at: number } => entry.at !== null)
    .sort((a, b) => b.at - a.at);
  const keep = new Set<string>();
  const newest = dated[0];
  if (!newest) return keep;
  keep.add(newest.id);

  const today = toLocalDate(now, timeZone);
  const thisMonday = isoWeekMonday(today);
  const thisMonth = monthIndex(today);
  const days = new Set<LocalDate>();
  const weeks = new Set<LocalDate>();
  const months = new Set<number>();
  // Newest first, so the first set met in a bucket is that bucket's newest.
  for (const { id, at } of dated) {
    const day = toLocalDate(at, timeZone);
    const dayAge = diffDays(today, day);
    if (dayAge >= 0 && dayAge < policy.daily && !days.has(day)) {
      days.add(day);
      keep.add(id);
    }
    const monday = isoWeekMonday(day);
    const weekAge = diffDays(thisMonday, monday) / 7;
    if (weekAge >= 0 && weekAge < policy.weekly && !weeks.has(monday)) {
      weeks.add(monday);
      keep.add(id);
    }
    const month = monthIndex(day);
    const monthAge = thisMonth - month;
    if (monthAge >= 0 && monthAge < policy.monthly && !months.has(month)) {
      months.add(month);
      keep.add(id);
    }
  }
  return keep;
}

/**
 * Deletes every object of every set not in `keep`, incomplete sets included. Objects whose first
 * path segment is not a set id are never touched. Returns the number of sets removed.
 */
export async function pruneStore(store: ObjectStore, keep: Set<string>): Promise<number> {
  const removed = new Set<string>();
  const objects = await store.list("");
  // Manifests first: a half-pruned set is then incomplete and never offered for restore.
  const isManifest = (key: string) => key.endsWith(`/${MANIFEST_FILE}`);
  const ordered = [
    ...objects.filter((o) => isManifest(o.key)),
    ...objects.filter((o) => !isManifest(o.key)),
  ];
  for (const { key } of ordered) {
    const [setId, ...rest] = key.split("/");
    if (!setId || rest.length === 0 || parseSetId(setId) === null || keep.has(setId)) continue;
    await store.delete(key);
    removed.add(setId);
  }
  return removed.size;
}
