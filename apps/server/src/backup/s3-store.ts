import { createHash } from "node:crypto";
import { AwsClient } from "aws4fetch";
import {
  assertSafeKey,
  assertSafePrefix,
  ObjectNotFoundError,
  type ObjectStore,
} from "./object-store";

export interface S3StoreOptions {
  endpoint: URL;
  region: string;
  bucket: string;
  /** Key prefix inside the bucket, without a leading or trailing slash (may be empty). */
  prefix: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

/**
 * A failed S3 call. The message carries only the operation, the HTTP status and the S3 error
 * `Code` (or a network error code): never the response body, the URL or a credential.
 */
export class S3Error extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "S3Error";
  }
}

/** The parts of a ListObjectsV2 response the store needs. Exported for tests. */
export function parseListObjectsV2(xml: string): {
  contents: { key: string; size: number }[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
} {
  const contents: { key: string; size: number }[] = [];
  for (const match of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const body = match[1] ?? "";
    const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
    const size = /<Size>(\d+)<\/Size>/.exec(body)?.[1];
    if (key !== undefined && size !== undefined) {
      contents.push({ key: decodeXml(key), size: Number(size) });
    }
  }
  const token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  return {
    contents,
    isTruncated: /<IsTruncated>\s*true\s*<\/IsTruncated>/i.test(xml),
    nextContinuationToken: token === undefined ? null : decodeXml(token),
  };
}

function decodeXml(text: string): string {
  return text.replace(
    /&(lt|gt|quot|apos|amp|#(\d+)|#x([0-9a-fA-F]+));/g,
    (_match, name: string, dec?: string, hex?: string) => {
      if (dec) return String.fromCodePoint(Number(dec));
      if (hex) return String.fromCodePoint(Number.parseInt(hex, 16));
      return { lt: "<", gt: ">", quot: '"', apos: "'", amp: "&" }[name] ?? "";
    },
  );
}

async function s3ErrorCode(response: Response): Promise<string | null> {
  const text = await response.text().catch(() => "");
  return /<Code>([A-Za-z0-9.]{1,64})<\/Code>/.exec(text)?.[1] ?? null;
}

function networkReason(error: unknown): string {
  const code =
    error instanceof Error ? (error.cause as { code?: unknown } | undefined)?.code : null;
  return typeof code === "string" && /^[A-Z0-9_]{2,40}$/.test(code)
    ? `network error (${code})`
    : "network error";
}

const MAX_LIST_PAGES = 1_000;

/**
 * An S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, …) addressed path-style:
 * `<endpoint>/<bucket>/<prefix>/<key>`. Requests are signed with SigV4 by `aws4fetch`; uploads
 * carry their SHA-256 in `x-amz-content-sha256`, so the service rejects a corrupted body. No
 * retries here: a failed nightly run is retried the next night.
 */
export class S3Store implements ObjectStore {
  readonly kind = "s3" as const;
  private readonly client: AwsClient;
  private readonly fetchImpl: typeof fetch;
  private readonly bucketUrl: string;
  private readonly prefix: string;

  constructor(options: S3StoreOptions) {
    this.client = new AwsClient({
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
      service: "s3",
      region: options.region,
      retries: 0,
    });
    this.fetchImpl = options.fetch ?? fetch;
    this.bucketUrl = `${options.endpoint.origin}/${encodeURIComponent(options.bucket)}`;
    this.prefix = options.prefix.replace(/^\/+|\/+$/g, "");
  }

  async put(key: string, body: Buffer): Promise<void> {
    const url = this.objectUrl(key);
    const response = await this.send("put", url, {
      method: "PUT",
      headers: {
        "content-type": "application/octet-stream",
        "x-amz-content-sha256": createHash("sha256").update(body).digest("hex"),
      },
      body: Uint8Array.from(body),
    });
    await response.arrayBuffer();
  }

  async get(key: string): Promise<Buffer> {
    const response = await this.send("get", this.objectUrl(key), { method: "GET" }, true);
    if (response.status === 404) {
      await response.arrayBuffer();
      throw new ObjectNotFoundError(key);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async list(prefix: string): Promise<{ key: string; size: number }[]> {
    assertSafePrefix(prefix);
    const strip = this.prefix ? `${this.prefix}/` : "";
    const items: { key: string; size: number }[] = [];
    let token: string | null = null;
    for (let page = 0; page < MAX_LIST_PAGES; page++) {
      const query = new URLSearchParams({ "list-type": "2", prefix: `${strip}${prefix}` });
      if (token) query.set("continuation-token", token);
      const response = await this.send("list", `${this.bucketUrl}?${query}`, { method: "GET" });
      const parsed = parseListObjectsV2(await response.text());
      for (const item of parsed.contents) {
        if (item.key.startsWith(strip))
          items.push({ key: item.key.slice(strip.length), size: item.size });
      }
      if (!parsed.isTruncated) {
        return items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      }
      if (!parsed.nextContinuationToken) {
        throw new S3Error(
          "S3 list failed: truncated listing without a continuation token",
          null,
          null,
        );
      }
      token = parsed.nextContinuationToken;
    }
    throw new S3Error("S3 list failed: too many pages", null, null);
  }

  async delete(key: string): Promise<void> {
    const response = await this.send("delete", this.objectUrl(key), { method: "DELETE" }, true);
    await response.arrayBuffer();
  }

  private objectUrl(key: string): string {
    assertSafeKey(key);
    const full = this.prefix ? `${this.prefix}/${key}` : key;
    return `${this.bucketUrl}/${full.split("/").map(encodeURIComponent).join("/")}`;
  }

  /** Signs and sends one request; any status other than 2xx (and 404 when allowed) throws. */
  private async send(
    operation: "put" | "get" | "list" | "delete",
    url: string,
    init: RequestInit,
    allowNotFound = false,
  ): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(await this.client.sign(url, init));
    } catch (error) {
      throw new S3Error(`S3 ${operation} failed: ${networkReason(error)}`, null, null);
    }
    if (response.ok || (allowNotFound && response.status === 404)) return response;
    const code = await s3ErrorCode(response);
    throw new S3Error(
      `S3 ${operation} failed: HTTP ${response.status}${code ? ` ${code}` : ""}`,
      response.status,
      code,
    );
  }
}
