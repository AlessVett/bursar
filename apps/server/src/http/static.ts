import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import type { Handler } from "hono";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

interface CachedFile {
  body: Uint8Array<ArrayBuffer>;
  contentType: string;
  cacheControl: string;
}

function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(requestPath);
  } catch {
    return null;
  }
  const relative = path.normalize(decoded).replace(/^[/\\]+/, "");
  if (!relative) return null;
  const file = path.join(root, relative);
  if (!file.startsWith(root + path.sep)) return null;
  return existsSync(file) && statSync(file).isFile() ? file : null;
}

/**
 * True when the request names a file rather than a panel route: anything under /assets/, or a
 * last path segment with an extension. A missing file must be a 404, never the panel's
 * index.html, or a stale hashed bundle would receive HTML instead of a script.
 */
function namesAFile(requestPath: string): boolean {
  if (requestPath.startsWith("/assets/")) return true;
  const lastSegment = requestPath.slice(requestPath.lastIndexOf("/") + 1);
  return /\.[A-Za-z0-9]+$/.test(lastSegment);
}

export function webAppHandler(webDistDir: string): Handler {
  const root = path.resolve(webDistDir);
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) throw new Error(`Web build not found: ${indexFile}`);
  const indexHtml = readFileSync(indexFile, "utf8");
  // The build directory does not change while the process runs (one build per deploy), so each
  // file is read once and then served from memory. Keys are resolved file paths, which bounds the
  // cache by the number of files in the build.
  const cache = new Map<string, CachedFile>();

  return (c) => {
    const file = resolveInside(root, c.req.path);
    if (!file) {
      if (namesAFile(c.req.path)) return c.text("Not found", 404, { "cache-control": "no-cache" });
      return c.html(indexHtml, 200, { "cache-control": "no-cache" });
    }
    let cached = cache.get(file);
    if (!cached) {
      const isAsset = path.relative(root, file).startsWith(`assets${path.sep}`);
      cached = {
        body: new Uint8Array(readFileSync(file)),
        contentType: CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
        cacheControl: isAsset ? "public, max-age=31536000, immutable" : "no-cache",
      };
      cache.set(file, cached);
    }
    return c.body(cached.body, 200, {
      "content-type": cached.contentType,
      "cache-control": cached.cacheControl,
    });
  };
}
