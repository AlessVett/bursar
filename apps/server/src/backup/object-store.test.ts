import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LocalDirStore, ObjectNotFoundError } from "./object-store";

describe("LocalDirStore", () => {
  let dir: string;
  let root: string;
  let store: LocalDirStore;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "bursar-store-"));
    root = path.join(dir, "backups");
    store = new LocalDirStore(root);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("writes private files in private directories and reads them back", async () => {
    await store.put("20261109T020000Z/bursar.db", Buffer.from("encrypted bytes"));
    const file = path.join(root, "20261109T020000Z", "bursar.db");
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(path.join(root, "20261109T020000Z")).mode & 0o777).toBe(0o700);
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect((await store.get("20261109T020000Z/bursar.db")).toString()).toBe("encrypted bytes");
  });

  it("replaces an object atomically and leaves no temporary file behind", async () => {
    await store.put("a/file.bin", Buffer.from("first"));
    await store.put("a/file.bin", Buffer.from("second"));
    expect((await store.get("a/file.bin")).toString()).toBe("second");
    expect(readdirSync(path.join(root, "a"))).toEqual(["file.bin"]);
  });

  it("lists keys with sizes, sorted, filtered by prefix, hiding dot entries", async () => {
    await store.put("20261109T020000Z/manifest.json", Buffer.from("{}"));
    await store.put("20261109T020000Z/bursar.db", Buffer.from("12345"));
    await store.put("20261108T020000Z/bursar.db", Buffer.from("123"));
    mkdirSync(path.join(root, ".work"));
    writeFileSync(path.join(root, ".work", "copy.db"), "x");
    writeFileSync(path.join(root, "20261108T020000Z", ".bursar.db.abc.tmp"), "x");

    expect(await store.list("")).toEqual([
      { key: "20261108T020000Z/bursar.db", size: 3 },
      { key: "20261109T020000Z/bursar.db", size: 5 },
      { key: "20261109T020000Z/manifest.json", size: 2 },
    ]);
    expect((await store.list("20261109T020000Z/")).map((o) => o.key)).toEqual([
      "20261109T020000Z/bursar.db",
      "20261109T020000Z/manifest.json",
    ]);
  });

  it("lists nothing when the root does not exist yet", async () => {
    expect(await store.list("")).toEqual([]);
  });

  it("reports a missing object as ObjectNotFoundError", async () => {
    await expect(store.get("20261109T020000Z/bursar.db")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
  });

  it("deletes objects, drops the emptied set directory and ignores missing keys", async () => {
    await store.put("20261109T020000Z/bursar.db", Buffer.from("x"));
    await store.put("20261109T020000Z/manifest.json", Buffer.from("{}"));
    await store.delete("20261109T020000Z/bursar.db");
    expect(existsSync(path.join(root, "20261109T020000Z"))).toBe(true);
    await store.delete("20261109T020000Z/manifest.json");
    expect(existsSync(path.join(root, "20261109T020000Z"))).toBe(false);
    await expect(store.delete("20261109T020000Z/manifest.json")).resolves.toBeUndefined();
  });

  it.each([
    "../escape.db",
    "/etc/passwd",
    "a/../../escape.db",
    "a//b",
    "",
    ".hidden",
    "a/./b",
    "a\\..\\b",
    "set/.work",
  ])("rejects the unsafe key %j before touching the disk", async (key) => {
    await expect(store.put(key, Buffer.from("x"))).rejects.toThrow("Invalid object key");
    await expect(store.get(key)).rejects.toThrow("Invalid object key");
    await expect(store.delete(key)).rejects.toThrow("Invalid object key");
    expect(readdirSync(dir)).toEqual([]);
  });

  it("rejects an unsafe list prefix", async () => {
    await expect(store.list("../")).rejects.toThrow("Invalid object key");
  });
});
