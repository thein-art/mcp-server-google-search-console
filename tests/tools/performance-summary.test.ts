import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import { registerPerformanceSummaryTool } from "../../src/tools/performance-summary.js";

const mockTokenProvider = async () => "ya29.mock-token";
const mockExtra = { signal: undefined as unknown as AbortSignal };

function mockApiSequence(...responses: unknown[]) {
  let callIndex = 0;
  const mockFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    text: async () => JSON.stringify(responses[callIndex++] ?? { rows: [] }),
  }));
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

function parseBody(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[callIndex][1].body);
}

describe("performance-summary tool", () => {
  let server: McpServer;
  let client: GscApiClient;
  let resolver: SiteResolver;
  let registeredHandler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    server = new McpServer({ name: "test", version: "0.0.1" });

    const originalRegisterTool = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      // @ts-expect-error - simplified mock
      (name: string, config: unknown, handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>) => {
        registeredHandler = handler;
        return originalRegisterTool(name, config, handler);
      },
    );

    registerPerformanceSummaryTool(server, client, resolver);
  });

  it("registers the tool", () => {
    expect(server.registerTool).toHaveBeenCalledWith(
      "get_performance_summary",
      expect.objectContaining({
        title: "Performance Summary",
        description: expect.any(String),
        inputSchema: expect.any(Object),
      }),
      expect.any(Function),
    );
  });

  it("makes 3 parallel API calls", async () => {
    const mockFetch = mockApiSequence(
      { rows: [{ clicks: 1000, impressions: 10000, ctr: 0.1, position: 5.0 }] },
      { rows: [{ clicks: 800, impressions: 9000, ctr: 0.0889, position: 5.5 }] },
      { rows: [
        { keys: ["best query"], clicks: 200, impressions: 2000, ctr: 0.1, position: 3.0 },
        { keys: ["second query"], clicks: 100, impressions: 1500, ctr: 0.0667, position: 4.0 },
      ] },
    );

    const result = await registeredHandler({ site_url: "https://example.com/" }, mockExtra);
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const parsed = parseResult(result);
    expect(parsed.current).toEqual({ clicks: 1000, impressions: 10000, ctr: 0.1, position: 5.0 });
    expect(parsed.previous).toEqual({ clicks: 800, impressions: 9000, ctr: 0.0889, position: 5.5 });
    expect((parsed.delta as Record<string, number>).clicks).toBe(200);
    expect((parsed.delta_pct as Record<string, string>).clicks).toBe("+25%");
    expect(parsed.top_queries).toHaveLength(2);
    expect((parsed.top_queries as Array<{ query: string }>)[0].query).toBe("best query");

    vi.unstubAllGlobals();
  });

  it("includes _summary string", async () => {
    mockApiSequence(
      { rows: [{ clicks: 12345, impressions: 234567, ctr: 0.0526, position: 12.4 }] },
      { rows: [{ clicks: 11000, impressions: 240000, ctr: 0.0458, position: 13.0 }] },
      { rows: [{ keys: ["example query"], clicks: 2345, impressions: 20000, ctr: 0.117, position: 3.0 }] },
    );

    const result = await registeredHandler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    expect(parsed._summary).toContain("28-day summary");
    expect(parsed._summary).toContain("12,345 clicks");
    expect(parsed._summary).toContain("example query");

    vi.unstubAllGlobals();
  });

  it("uses 7d period when specified", async () => {
    const mockFetch = mockApiSequence(
      { rows: [{ clicks: 100, impressions: 1000, ctr: 0.1, position: 5.0 }] },
      { rows: [{ clicks: 90, impressions: 900, ctr: 0.1, position: 5.0 }] },
      { rows: [] },
    );

    const result = await registeredHandler({ site_url: "https://example.com/", period: "7d" }, mockExtra);
    const parsed = parseResult(result);

    expect((parsed.period as Record<string, unknown>).label).toBe("7d");
    expect(parsed._summary).toContain("7-day summary");

    vi.unstubAllGlobals();
  });

  it("passes search_type to API calls", async () => {
    const mockFetch = mockApiSequence({ rows: [] }, { rows: [] }, { rows: [] });

    await registeredHandler({ site_url: "https://example.com/", search_type: "image" }, mockExtra);

    for (let i = 0; i < 3; i++) {
      const body = parseBody(mockFetch, i);
      expect(body.type).toBe("image");
    }

    vi.unstubAllGlobals();
  });

  it("handles zero metrics gracefully", async () => {
    mockApiSequence({ rows: [] }, { rows: [] }, { rows: [] });

    const result = await registeredHandler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    expect(parsed.current).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
    expect(parsed.previous).toEqual({ clicks: 0, impressions: 0, ctr: 0, position: 0 });
    expect((parsed.delta_pct as Record<string, string>).clicks).toBe("0%");
    expect(parsed.top_queries).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("includes resolved note when site URL was fuzzy-matched", async () => {
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "sc-domain:example.com", resolved: true });
    mockApiSequence({ rows: [] }, { rows: [] }, { rows: [] });

    const result = await registeredHandler({ site_url: "example.com" }, mockExtra);
    const parsed = parseResult(result);

    expect(parsed._resolved).toContain("Resolved");

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ error: { message: "Access denied" } }),
    }));

    const result = await registeredHandler({ site_url: "https://example.com/" }, mockExtra);
    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });

  it("calculates correct delta percentages", async () => {
    mockApiSequence(
      { rows: [{ clicks: 150, impressions: 3000, ctr: 0.05, position: 10.0 }] },
      { rows: [{ clicks: 100, impressions: 2000, ctr: 0.05, position: 12.0 }] },
      { rows: [] },
    );

    const result = await registeredHandler({ site_url: "https://example.com/" }, mockExtra);
    const parsed = parseResult(result);

    expect((parsed.delta_pct as Record<string, string>).clicks).toBe("+50%");
    expect((parsed.delta_pct as Record<string, string>).impressions).toBe("+50%");
    expect((parsed.delta as Record<string, number>).position).toBe(-2);

    vi.unstubAllGlobals();
  });

  it("top queries limited to 10 via API rowLimit", async () => {
    const mockFetch = mockApiSequence({ rows: [] }, { rows: [] }, { rows: [] });

    await registeredHandler({ site_url: "https://example.com/" }, mockExtra);

    // Third call is top queries — should have rowLimit 10
    const body = parseBody(mockFetch, 2);
    expect(body.rowLimit).toBe(10);
    expect(body.dimensions).toEqual(["query"]);

    vi.unstubAllGlobals();
  });
});
