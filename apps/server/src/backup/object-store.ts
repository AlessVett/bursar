import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { mkdir, open, readdir, readFile, rename, rm, rmdir, stat } from "node:fs/promises";
import path from "node:path";

/** A flat key/value blob store. Keys are relative POSIX paths such as `<setId>/bursar.db`. */
export interface ObjectStore {
  readonly kind: "local" | "s3";
  put(key: string, body: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
  /** Every object whose key starts with `prefix` (`""` lists everything), sorted by key. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Deleting a missing key is not an error. */
  delete(key: string): Promise<void>;
}

/** `get` of a key that does not exist. */
export class ObjectNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`Object not found: ${key}`);
    this.name = "ObjectNotFoundError";
  }
}

// A segment never starts with a dot: this rules out ".", "..", hidden files and the temporary
// files and work directory the local store keeps next to the sets.
const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;

/** Throws unless every `/`-separated segment of `key` is a plain name (no traversal, no root). */
export function assertSafeKey(key: string): void {
  if (key.length === 0 || key.length > 512 || !key.split("/").every((s) => SEGMENT.test(s))) {
    throw new Error("Invalid object key");
  }
}

/** `""`, or a safe key optionally ending with `/`. */
export function assertSafePrefix(prefix: string): void {
  if (prefix === "") return;
  assertSafeKey(prefix.endsWith("/") ? prefix.slice(0, -1) : prefix);
}

/**
 * Stores objects as files under `rootDir`: directories 0700, files 0600, every write goes to a
 * hidden temporary file that is synced and then renamed over the target, so a reader never sees
 * half a file. Entries whose name starts with a dot are never listed.
 */
export class LocalDirStore implements ObjectStore {
  readonly kind = "local" as const;
  private readonly root: string;

  constructor(rootDir: string) {
    this.root = path.resolve(rootDir);
  }

  async put(key: string, body: Buffer): Promise<void> {
    const file = this.resolve(key);
    const dir = path.dirname(file);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const temp = path.join(dir, `.${path.basename(file)}.${randomBytes(6).toString("hex")}.tmp`);
    try {
      const handle = await open(temp, "wx", 0o600);
      try {
        await handle.writeFile(body);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true });
      throw error;
    }
  }

  async get(key: string): Promise<Buffer> {
    try {
      return await readFile(this.resolve(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ObjectNotFoundError(key);
      throw error;
    }
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertSafePrefix(prefix);
    const found: { key: string; size: number }[] = [];
    const walk = async (dir: string, keyPrefix: string): Promise<void> => {
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const key = `${keyPrefix}${entry.name}`;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full, `${key}/`);
        else if (entry.isFile() && key.startsWith(prefix)) {
          found.push({ key, size: (await stat(full)).size });
        }
      }
    };
    await walk(this.root, "");
    return found.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async delete(key: string): Promise<void> {
    const file = this.resolve(key);
    await rm(file, { force: true });
    const dir = path.dirname(file);
    // Drop the set directory once it is empty; rmdir refuses a non-empty directory.
    if (dir !== this.root) await rmdir(dir).catch(() => {});
  }

  private resolve(key: string): string {
    assertSafeKey(key);
    const file = path.join(this.root, ...key.split("/"));
    if (!file.startsWith(`${this.root}${path.sep}`)) throw new Error("Invalid object key");
    return file;
  }
}
