import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import { registerListSitemapsTool } from "../../src/tools/list-sitemaps.js";
import { registerSubmitSitemapTool } from "../../src/tools/submit-sitemap.js";
import { registerDeleteSitemapTool } from "../../src/tools/delete-sitemap.js";

const mockTokenProvider = async () => "ya29.mock-token";
const mockExtra = { signal: undefined as unknown as AbortSignal };

type Handler = (args: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<unknown>;

function captureHandler(
  server: McpServer,
  registerFn: (server: McpServer, client: GscApiClient, resolver: SiteResolver) => void,
  client: GscApiClient,
  resolver: SiteResolver,
): Handler {
  let handler: Handler;
  const originalRegisterTool = server.registerTool.bind(server);
  vi.spyOn(server, "registerTool").mockImplementation(
    // @ts-expect-error - simplified mock
    (_name: string, _config: unknown, h: Handler) => {
      handler = h;
      return originalRegisterTool(_name, _config, h);
    },
  );
  registerFn(server, client, resolver);
  return handler!;
}

function mockFetchJson(data: unknown) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(data),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function mockFetchVoid() {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => "",
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("list_sitemaps", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;
  let handler: Handler;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    const server = new McpServer({ name: "test", version: "0.0.1" });
    handler = captureHandler(server, registerListSitemapsTool, client, resolver);
  });

  it("returns empty sitemaps array when none exist", async () => {
    mockFetchJson({ sitemap: undefined });

    const result = await handler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    expect(parsed.sitemaps).toEqual([]);
    expect(parsed._summary).toContain("0 sitemaps");

    vi.unstubAllGlobals();
  });

  it("summarizes sitemaps with aggregated stats", async () => {
    mockFetchJson({
      sitemap: [
        {
          path: "https://example.com/sitemap.xml",
          isPending: false,
          isSitemapsIndex: false,
          type: "sitemap",
          lastDownloaded: "2026-03-07T09:00:00Z",
          warnings: "5",
          errors: "0",
          contents: [
            { type: "web", submitted: "100", indexed: "80" },
            { type: "image", submitted: "50", indexed: "30" },
          ],
        },
        {
          path: "https://example.com/sitemap-news.xml",
          isPending: false,
          isSitemapsIndex: false,
          type: "sitemap",
          lastDownloaded: "2026-03-06T12:00:00Z",
          warnings: "0",
          errors: "2",
          contents: [
            { type: "web", submitted: "20", indexed: "15" },
          ],
        },
      ],
    });

    const result = await handler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    const sitemaps = parsed.sitemaps as Array<Record<string, unknown>>;
    expect(sitemaps).toHaveLength(2);

    // First sitemap
    expect(sitemaps[0].path).toBe("https://example.com/sitemap.xml");
    expect(sitemaps[0].errors).toBe(0);
    expect(sitemaps[0].warnings).toBe(5);
    expect(sitemaps[0].submitted).toBe(150);
    expect(sitemaps[0].indexed).toBe(110);
    expect(sitemaps[0].indexRate).toBe("73%");

    // Second sitemap
    expect(sitemaps[1].errors).toBe(2);
    expect(sitemaps[1].submitted).toBe(20);
    expect(sitemaps[1].indexed).toBe(15);
    expect(sitemaps[1].indexRate).toBe("75%");

    // Summary
    const summary = parsed._summary as string;
    expect(summary).toContain("2 sitemaps");
    expect(summary).toContain("1 with errors (2 total)");
    expect(summary).toContain("1 with warnings (5 total)");
    expect(summary).toContain("170 URLs submitted");
    expect(summary).toContain("125 indexed");
    expect(summary).toContain("74%");

    vi.unstubAllGlobals();
  });

  it("handles sitemaps without contents array", async () => {
    mockFetchJson({
      sitemap: [
        {
          path: "https://example.com/broken-url",
          isPending: false,
          isSitemapsIndex: false,
          warnings: "0",
          errors: "1",
          // no type, no contents — common for incorrectly submitted URLs
        },
      ],
    });

    const result = await handler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    const sitemaps = parsed.sitemaps as Array<Record<string, unknown>>;
    expect(sitemaps[0].submitted).toBe(0);
    expect(sitemaps[0].indexed).toBe(0);
    expect(sitemaps[0].indexRate).toBeNull();
    expect(sitemaps[0].type).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("passes sitemapIndex query parameter to API", async () => {
    const mockFetch = mockFetchJson({ sitemap: [] });

    await handler({
      site_url: "https://example.com/",
      sitemapIndex: "https://example.com/sitemap_index.xml",
    }, mockExtra);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("sitemapIndex=");
    expect(url).toContain(encodeURIComponent("https://example.com/sitemap_index.xml"));

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ error: { message: "Forbidden" } }),
    }));

    const result = await handler({ site_url: "https://example.com/" }, mockExtra);
    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("submit_sitemap", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;
  let handler: Handler;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    const server = new McpServer({ name: "test", version: "0.0.1" });
    handler = captureHandler(server, registerSubmitSitemapTool, client, resolver);
  });

  it("submits sitemap via PUT request", async () => {
    const mockFetch = mockFetchVoid();

    const result = await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/sitemap.xml",
    }, mockExtra);

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.feedpath).toBe("https://example.com/sitemap.xml");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/sitemaps/"),
      expect.objectContaining({ method: "PUT" }),
    );

    vi.unstubAllGlobals();
  });

  it("encodes feedpath in URL", async () => {
    const mockFetch = mockFetchVoid();

    await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/sitemap.xml",
    }, mockExtra);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("https://example.com/sitemap.xml"));

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ error: { message: "Insufficient permissions" } }),
    }));

    const result = await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/sitemap.xml",
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });
});

describe("delete_sitemap", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;
  let handler: Handler;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    const server = new McpServer({ name: "test", version: "0.0.1" });
    handler = captureHandler(server, registerDeleteSitemapTool, client, resolver);
  });

  it("rejects deletion when confirm is false", async () => {
    mockFetchVoid();

    const result = await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/sitemap.xml",
      confirm: false,
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("not confirmed");

    vi.unstubAllGlobals();
  });

  it("deletes sitemap when confirmed", async () => {
    const mockFetch = mockFetchVoid();

    const result = await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/sitemap.xml",
      confirm: true,
    }, mockExtra);

    const parsed = parseResult(result);
    expect(parsed.success).toBe(true);
    expect(parsed.deleted).toBe("https://example.com/sitemap.xml");

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/sitemaps/"),
      expect.objectContaining({ method: "DELETE" }),
    );

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ error: { message: "Sitemap not found" } }),
    }));

    const result = await handler({
      site_url: "https://example.com/",
      feedpath: "https://example.com/nonexistent.xml",
      confirm: true,
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });
});
