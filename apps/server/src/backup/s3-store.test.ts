import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ObjectNotFoundError } from "./object-store";
import { parseListObjectsV2, S3Error, S3Store } from "./s3-store";

const SECRET = "s3-secret-access-key-value-0123456789";

type Responder = (request: Request) => Response | Promise<Response>;

function harness(responder: Responder, prefix = "bursar") {
  const requests: Request[] = [];
  const fetchMock = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    requests.push(request.clone());
    return responder(request);
  }) as typeof fetch;
  const store = new S3Store({
    endpoint: new URL("https://s3.example.test"),
    region: "auto",
    bucket: "bursar-backups",
    prefix,
    accessKeyId: "AKIDEXAMPLE",
    secretAccessKey: SECRET,
    fetch: fetchMock,
  });
  return { store, requests };
}

const errorXml = (code: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>Detail that must not leak: ${SECRET}</Message><RequestId>REQ123</RequestId></Error>`;

describe("S3Store", () => {
  it("puts an object path-style with a SigV4 Authorization header and the body hash", async () => {
    const { store, requests } = harness(() => new Response(null, { status: 200 }));
    const body = Buffer.from("encrypted database bytes");
    await store.put("20261109T020000Z/bursar.db", body);

    expect(requests).toHaveLength(1);
    const request = requests[0] as Request;
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      "https://s3.example.test/bursar-backups/bursar/20261109T020000Z/bursar.db",
    );
    const authorization = request.headers.get("authorization") ?? "";
    expect(authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/auto\/s3\/aws4_request, SignedHeaders=[a-z0-9;-]+, Signature=[0-9a-f]{64}$/,
    );
    const signed = /SignedHeaders=([a-z0-9;-]+)/.exec(authorization)?.[1]?.split(";") ?? [];
    expect(signed).toEqual(expect.arrayContaining(["host", "x-amz-content-sha256", "x-amz-date"]));
    expect(request.headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    expect(request.headers.get("x-amz-content-sha256")).toBe(
      createHash("sha256").update(body).digest("hex"),
    );
    expect(Buffer.from(await request.arrayBuffer())).toEqual(body);
    for (const [, value] of request.headers) expect(value).not.toContain(SECRET);
  });

  it("gets an object and maps 404 to ObjectNotFoundError", async () => {
    const { store, requests } = harness((request) =>
      request.url.endsWith("/present.db")
        ? new Response(Uint8Array.from(Buffer.from("payload")), { status: 200 })
        : new Response(errorXml("NoSuchKey"), { status: 404 }),
    );
    expect((await store.get("20261109T020000Z/present.db")).toString()).toBe("payload");
    await expect(store.get("20261109T020000Z/missing.db")).rejects.toBeInstanceOf(
      ObjectNotFoundError,
    );
    expect(requests.map((r) => r.method)).toEqual(["GET", "GET"]);
  });

  it("lists every page with ListObjectsV2 and returns keys relative to the prefix", async () => {
    const pages = [
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bursar-backups</Name>
        <Contents><Key>bursar/20261108T020000Z/bursar.db</Key><Size>4096</Size></Contents>
        <Contents><Key>bursar/20261108T020000Z/manifest.json</Key><Size>210</Size></Contents>
        <IsTruncated>true</IsTruncated><NextContinuationToken>page-2&amp;more</NextContinuationToken>
      </ListBucketResult>`,
      `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>bursar-backups</Name>
        <Contents><Key>bursar/20261109T020000Z/bursar.db</Key><Size>8192</Size></Contents>
        <IsTruncated>false</IsTruncated>
      </ListBucketResult>`,
    ];
    let page = 0;
    const { store, requests } = harness(() => new Response(pages[page++], { status: 200 }));

    expect(await store.list("2026")).toEqual([
      { key: "20261108T020000Z/bursar.db", size: 4096 },
      { key: "20261108T020000Z/manifest.json", size: 210 },
      { key: "20261109T020000Z/bursar.db", size: 8192 },
    ]);
    const urls = requests.map((r) => new URL(r.url));
    expect(urls.map((u) => `${u.origin}${u.pathname}`)).toEqual([
      "https://s3.example.test/bursar-backups",
      "https://s3.example.test/bursar-backups",
    ]);
    expect(urls[0]?.searchParams.get("list-type")).toBe("2");
    expect(urls[0]?.searchParams.get("prefix")).toBe("bursar/2026");
    expect(urls[0]?.searchParams.has("continuation-token")).toBe(false);
    expect(urls[1]?.searchParams.get("continuation-token")).toBe("page-2&more");
    for (const request of requests) {
      expect(request.headers.get("authorization")).toMatch(/^AWS4-HMAC-SHA256 /);
    }
  });

  it("works without a key prefix", async () => {
    const { store, requests } = harness(() => new Response(null, { status: 200 }), "");
    await store.put("20261109T020000Z/manifest.json", Buffer.from("{}"));
    expect(requests[0]?.url).toBe(
      "https://s3.example.test/bursar-backups/20261109T020000Z/manifest.json",
    );
  });

  it("deletes with DELETE and treats 404 as already gone", async () => {
    const { store, requests } = harness((request) =>
      request.url.endsWith("/gone.db")
        ? new Response(errorXml("NoSuchKey"), { status: 404 })
        : new Response(null, { status: 204 }),
    );
    await store.delete("20261101T020000Z/bursar.db");
    await store.delete("20261101T020000Z/gone.db");
    expect(requests.map((r) => r.method)).toEqual(["DELETE", "DELETE"]);
  });

  it("reduces an S3 error to the operation, the status and the error code", async () => {
    const { store } = harness(() => new Response(errorXml("AccessDenied"), { status: 403 }));
    const error = await store.put("20261109T020000Z/bursar.db", Buffer.from("x")).catch((e) => e);
    expect(error).toBeInstanceOf(S3Error);
    expect(error.message).toBe("S3 put failed: HTTP 403 AccessDenied");
    expect(error).toMatchObject({ status: 403, code: "AccessDenied" });
    expect(error.message).not.toContain(SECRET);
    expect(error.message).not.toContain("s3.example.test");
  });

  it("keeps the status alone when the error body is not an S3 error document", async () => {
    const { store } = harness(() => new Response("<html>gateway</html>", { status: 502 }));
    await expect(store.list("")).rejects.toThrow(/^S3 list failed: HTTP 502$/);
  });

  it("reduces a network failure to its error code", async () => {
    const { store } = harness(() => {
      throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } });
    });
    await expect(store.get("20261109T020000Z/bursar.db")).rejects.toThrow(
      /^S3 get failed: network error \(ECONNREFUSED\)$/,
    );
  });

  it("rejects unsafe keys before sending anything", async () => {
    const { store, requests } = harness(() => new Response(null, { status: 200 }));
    await expect(store.put("../outside.db", Buffer.from("x"))).rejects.toThrow(
      "Invalid object key",
    );
    await expect(store.get("/absolute")).rejects.toThrow("Invalid object key");
    await expect(store.list("a//")).rejects.toThrow("Invalid object key");
    expect(requests).toHaveLength(0);
  });
});

describe("parseListObjectsV2", () => {
  it("decodes XML entities in keys and tokens and ignores incomplete entries", () => {
    expect(
      parseListObjectsV2(
        "<ListBucketResult><Contents><Key>a&amp;b&#47;c&#x2F;d</Key><Size>7</Size></Contents>" +
          "<Contents><Key>no-size</Key></Contents><IsTruncated>false</IsTruncated></ListBucketResult>",
      ),
    ).toEqual({
      contents: [{ key: "a&b/c/d", size: 7 }],
      isTruncated: false,
      nextContinuationToken: null,
    });
  });
});
