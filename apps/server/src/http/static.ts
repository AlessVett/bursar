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

export function webAppHandler(webDistDir: string): Handler {
  const root = path.resolve(webDistDir);
  const indexFile = path.join(root, "index.html");
  if (!existsSync(indexFile)) throw new Error(`Web build not found: ${indexFile}`);
  const indexHtml = readFileSync(indexFile, "utf8");

  return (c) => {
    const file = resolveInside(root, c.req.path);
    if (!file) return c.html(indexHtml, 200, { "cache-control": "no-cache" });
    const isAsset = path.relative(root, file).startsWith(`assets${path.sep}`);
    return c.body(readFileSync(file), 200, {
      "content-type": CONTENT_TYPES[path.extname(file)] ?? "application/octet-stream",
      "cache-control": isAsset ? "public, max-age=31536000, immutable" : "no-cache",
    });
  };
}
