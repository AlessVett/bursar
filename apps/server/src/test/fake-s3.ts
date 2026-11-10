/** Test double for an S3-compatible bucket, reached through an injected `fetch`. No network. */
export interface FakeS3 {
  fetch: typeof fetch;
  /** Objects by full key inside the bucket (store prefix included), e.g. `bursar/<setId>/bursar.db`. */
  objects: Map<string, Buffer>;
  requests: Request[];
  /** Every following request answers `status` with an S3 error document carrying `code`. */
  failWith(status: number, code: string): void;
  recover(): void;
}

const escapeXml = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

const xml = (status: number, body: string) =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?>\n${body}`, {
    status,
    headers: { "content-type": "application/xml" },
  });

/**
 * Path-style bucket `bucket` with PUT, GET, DELETE and ListObjectsV2 (`pageSize` keys per page,
 * continuation token = index of the next key). It does not check signatures: `s3-store.test.ts`
 * checks the request shape.
 */
export function createFakeS3(options: { bucket?: string; pageSize?: number } = {}): FakeS3 {
  const bucket = options.bucket ?? "bursar-backups";
  const pageSize = options.pageSize ?? 1_000;
  const objects = new Map<string, Buffer>();
  const requests: Request[] = [];
  let failure: { status: number; code: string } | null = null;

  const handle = async (request: Request): Promise<Response> => {
    if (failure) {
      return xml(
        failure.status,
        `<Error><Code>${failure.code}</Code><Message>Refused by the fake</Message></Error>`,
      );
    }
    const url = new URL(request.url);
    const [, bucketName, ...rest] = url.pathname.split("/");
    if (bucketName !== bucket) return xml(404, "<Error><Code>NoSuchBucket</Code></Error>");
    const key = rest.map(decodeURIComponent).join("/");
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = Number(url.searchParams.get("continuation-token") ?? "0");
      const page = keys.slice(start, start + pageSize);
      const truncated = start + pageSize < keys.length;
      const contents = page
        .map(
          (k) =>
            `<Contents><Key>${escapeXml(k)}</Key><Size>${objects.get(k)?.length ?? 0}</Size></Contents>`,
        )
        .join("");
      return xml(
        200,
        `<ListBucketResult><Name>${bucket}</Name><KeyCount>${page.length}</KeyCount>${contents}` +
          `<IsTruncated>${truncated}</IsTruncated>` +
          (truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : "") +
          "</ListBucketResult>",
      );
    }
    if (request.method === "PUT") {
      objects.set(key, Buffer.from(await request.arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (request.method === "GET") {
      const object = objects.get(key);
      return object
        ? new Response(Uint8Array.from(object), { status: 200 })
        : xml(404, "<Error><Code>NoSuchKey</Code></Error>");
    }
    if (request.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return xml(405, "<Error><Code>MethodNotAllowed</Code></Error>");
  };

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    return handle(request);
  }) as typeof fetch;

  return {
    fetch: fakeFetch,
    objects,
    requests,
    failWith: (status, code) => {
      failure = { status, code };
    },
    recover: () => {
      failure = null;
    },
  };
}
