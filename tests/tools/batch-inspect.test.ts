import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import { registerBatchInspectTool } from "../../src/tools/batch-inspect.js";

const mockTokenProvider = async () => "ya29.mock-token";

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("batch_inspect_urls tool", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;
  let handler: (args: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    const server = new McpServer({ name: "test", version: "0.0.1" });
    const originalRegisterTool = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      // @ts-expect-error - simplified mock
      (_name: string, _config: unknown, h: (args: Record<string, unknown>) => Promise<unknown>) => {
        handler = h;
        return originalRegisterTool(_name, _config, h);
      },
    );
    registerBatchInspectTool(server, client, resolver);
  });

  function mockInspectionResponses(responses: Array<{ verdict: string; coverageState?: string }>) {
    let callIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      const r = responses[callIndex++] ?? responses[responses.length - 1];
      return {
        ok: true,
        text: async () => JSON.stringify({
          inspectionResult: {
            indexStatusResult: {
              verdict: r.verdict,
              coverageState: r.coverageState ?? (r.verdict === "PASS" ? "Submitted and indexed" : "Crawled - currently not indexed"),
              lastCrawlTime: "2026-03-05T10:00:00Z",
              crawledAs: "MOBILE",
            },
          },
        }),
      };
    }));
  }

  it("inspects multiple URLs and returns aggregate summary", async () => {
    mockInspectionResponses([
      { verdict: "PASS" },
      { verdict: "PASS" },
      { verdict: "FAIL" },
    ]);

    const result = await handler({
      urls: [
        "https://example.com/page1",
        "https://example.com/page2",
        "https://example.com/page3",
      ],
      site_url: "https://example.com/",
    });

    const parsed = parseResult(result);
    expect(parsed._summary).toBe("3 URLs inspected: 2 indexed 1 not indexed");
    expect(parsed.results).toHaveLength(3);

    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results[0].url).toBe("https://example.com/page1");
    expect(results[0].verdict).toBe("PASS");
    expect(results[1].verdict).toBe("PASS");
    expect(results[2].verdict).toBe("FAIL");

    vi.unstubAllGlobals();
  });

  it("handles API errors for individual URLs gracefully", async () => {
    let callIndex = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      callIndex++;
      if (callIndex === 2) {
        return {
          ok: false,
          status: 403,
          headers: new Headers(),
          json: async () => ({ error: { message: "Access denied" } }),
        };
      }
      return {
        ok: true,
        text: async () => JSON.stringify({
          inspectionResult: {
            indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" },
          },
        }),
      };
    }));

    const result = await handler({
      urls: [
        "https://example.com/page1",
        "https://example.com/page2",
        "https://example.com/page3",
      ],
      site_url: "https://example.com/",
    });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results[0].verdict).toBe("PASS");
    expect(results[1].verdict).toBe("ERROR");
    expect(results[1].error).toBeTruthy();
    expect(results[2].verdict).toBe("PASS");

    expect(parsed._summary).toContain("1 errors");

    vi.unstubAllGlobals();
  });

  it("includes per-URL summaries", async () => {
    mockInspectionResponses([{ verdict: "PASS" }]);

    const result = await handler({
      urls: ["https://example.com/page1"],
      site_url: "https://example.com/",
    });

    const parsed = parseResult(result);
    const results = parsed.results as Array<Record<string, unknown>>;
    expect(results[0]._summary).toContain("Index: PASS");
    expect(results[0]._summary).toContain("Submitted and indexed");

    vi.unstubAllGlobals();
  });

  it("passes language_code to all API calls", async () => {
    mockInspectionResponses([{ verdict: "PASS" }, { verdict: "PASS" }]);

    await handler({
      urls: ["https://example.com/page1", "https://example.com/page2"],
      site_url: "https://example.com/",
      language_code: "de",
    });

    const mockFetch = vi.mocked(globalThis.fetch);
    for (const call of mockFetch.mock.calls) {
      const body = JSON.parse(call[1]!.body as string);
      expect(body.languageCode).toBe("de");
    }

    vi.unstubAllGlobals();
  });

  it("includes resolved note when site_url is auto-resolved", async () => {
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "sc-domain:example.com", resolved: true });
    mockInspectionResponses([{ verdict: "PASS" }]);

    const result = await handler({
      urls: ["https://example.com/page1"],
      site_url: "example.com",
    });

    const parsed = parseResult(result);
    expect(parsed._resolved).toContain("example.com");
    expect(parsed._resolved).toContain("sc-domain:example.com");

    vi.unstubAllGlobals();
  });

  it("returns compact results with key fields only", async () => {
    mockInspectionResponses([{ verdict: "PASS" }]);

    const result = await handler({
      urls: ["https://example.com/page1"],
      site_url: "https://example.com/",
    });

    const parsed = parseResult(result);
    const r = (parsed.results as Array<Record<string, unknown>>)[0];

    // Should have compact fields
    expect(r).toHaveProperty("url");
    expect(r).toHaveProperty("_summary");
    expect(r).toHaveProperty("verdict");
    expect(r).toHaveProperty("coverageState");
    expect(r).toHaveProperty("lastCrawlTime");
    expect(r).toHaveProperty("crawledAs");

    // Should NOT have full nested objects
    expect(r).not.toHaveProperty("indexStatusResult");
    expect(r).not.toHaveProperty("mobileUsabilityResult");

    vi.unstubAllGlobals();
  });

  it("respects concurrency limit", async () => {
    let maxConcurrent = 0;
    let currentConcurrent = 0;

    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => {
      currentConcurrent++;
      maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
      // Simulate some async work
      await new Promise((r) => setTimeout(r, 10));
      currentConcurrent--;
      return {
        ok: true,
        text: async () => JSON.stringify({
          inspectionResult: {
            indexStatusResult: { verdict: "PASS", coverageState: "Submitted and indexed" },
          },
        }),
      };
    }));

    const urls = Array.from({ length: 10 }, (_, i) => `https://example.com/page${i}`);
    await handler({ urls, site_url: "https://example.com/" });

    expect(maxConcurrent).toBeLessThanOrEqual(5);
    expect(maxConcurrent).toBeGreaterThan(1); // Should actually be parallel

    vi.unstubAllGlobals();
  });

  it("summary counts only indexed/not-indexed/errors", async () => {
    mockInspectionResponses([
      { verdict: "PASS" },
      { verdict: "PASS" },
      { verdict: "PASS" },
    ]);

    const result = await handler({
      urls: [
        "https://example.com/page1",
        "https://example.com/page2",
        "https://example.com/page3",
      ],
      site_url: "https://example.com/",
    });

    const parsed = parseResult(result);
    expect(parsed._summary).toBe("3 URLs inspected: 3 indexed");
    expect(parsed._summary).not.toContain("not indexed");
    expect(parsed._summary).not.toContain("errors");

    vi.unstubAllGlobals();
  });
});
