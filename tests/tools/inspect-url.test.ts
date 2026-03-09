import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import { registerInspectUrlTool, buildInspectionSummary } from "../../src/tools/inspect-url.js";
import type { InspectionResult } from "../../src/types.js";

const mockTokenProvider = async () => "ya29.mock-token";
const mockExtra = { signal: undefined as unknown as AbortSignal };

function mockApiSuccess(data: unknown) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(data),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("buildInspectionSummary", () => {
  it("summarizes a fully indexed URL", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "PASS",
        coverageState: "Submitted and indexed",
        lastCrawlTime: "2026-03-05T10:00:00Z",
        crawledAs: "MOBILE",
        pageFetchState: "SUCCESSFUL",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
        googleCanonical: "https://example.com/page",
        userCanonical: "https://example.com/page",
      },
      mobileUsabilityResult: { verdict: "PASS" },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Index: PASS: Submitted and indexed");
    expect(summary).toContain("Last crawl: 2026-03-05 (MOBILE)");
    expect(summary).toContain("Mobile: PASS");
    expect(summary).not.toContain("CANONICAL MISMATCH");
    expect(summary).not.toContain("Fetch:");
    expect(summary).not.toContain("Blocked");
  });

  it("summarizes a failed/not-indexed URL", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "FAIL",
        coverageState: "Crawled - currently not indexed",
        lastCrawlTime: "2026-02-20T08:00:00Z",
        crawledAs: "DESKTOP",
        pageFetchState: "SUCCESSFUL",
        robotsTxtState: "ALLOWED",
        indexingState: "INDEXING_ALLOWED",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Index: FAIL: Crawled - currently not indexed");
    expect(summary).toContain("Last crawl: 2026-02-20 (DESKTOP)");
  });

  it("detects canonical mismatch", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "PASS",
        googleCanonical: "https://example.com/page",
        userCanonical: "https://example.com/page/",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("CANONICAL MISMATCH");
    expect(summary).toContain("https://example.com/page");
    expect(summary).toContain("https://example.com/page/");
  });

  it("does not flag canonical when they match", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "PASS",
        googleCanonical: "https://example.com/page",
        userCanonical: "https://example.com/page",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).not.toContain("CANONICAL MISMATCH");
  });

  it("reports robots.txt blocking", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "FAIL",
        robotsTxtState: "DISALLOWED",
        indexingState: "BLOCKED_BY_ROBOTS_TXT",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Blocked by robots.txt");
    expect(summary).toContain("Indexing: BLOCKED_BY_ROBOTS_TXT");
  });

  it("reports noindex blocking", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "FAIL",
        indexingState: "BLOCKED_BY_META_TAG",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Indexing: BLOCKED_BY_META_TAG");
  });

  it("reports fetch failures", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "FAIL",
        pageFetchState: "NOT_FOUND",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Fetch: NOT_FOUND");
  });

  it("reports soft 404", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "FAIL",
        pageFetchState: "SOFT_404",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Fetch: SOFT_404");
  });

  it("reports sitemap references", () => {
    const result: InspectionResult = {
      indexStatusResult: {
        verdict: "PASS",
        sitemap: ["https://example.com/sitemap.xml", "https://example.com/sitemap-news.xml"],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Referenced in 2 sitemap(s)");
  });

  it("reports mobile verdict when issues array is empty (B1 bug fix)", () => {
    const result: InspectionResult = {
      mobileUsabilityResult: {
        verdict: "PARTIAL",
        issues: [],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Mobile: PARTIAL (no details)");
  });

  it("reports mobile verdict when issues is undefined (B1 bug fix)", () => {
    const result: InspectionResult = {
      mobileUsabilityResult: {
        verdict: "FAIL",
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Mobile: FAIL (no details)");
  });

  it("reports mobile usability issues", () => {
    const result: InspectionResult = {
      mobileUsabilityResult: {
        verdict: "FAIL",
        issues: [
          { issueType: "TAP_TARGETS_TOO_CLOSE", severity: "ERROR", message: "Clickable elements too close" },
          { issueType: "USE_LEGIBLE_FONT_SIZES", severity: "ERROR", message: "Text too small" },
        ],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Mobile: FAIL");
    expect(summary).toContain("TAP_TARGETS_TOO_CLOSE");
    expect(summary).toContain("USE_LEGIBLE_FONT_SIZES");
  });

  it("reports rich results with types", () => {
    const result: InspectionResult = {
      richResultsResult: {
        verdict: "PASS",
        detectedItems: [
          { richResultType: "FAQ", items: [{ name: "FAQ item" }] },
          { richResultType: "Article", items: [{ name: "Article item" }] },
        ],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Rich results: FAQ, Article");
    expect(summary).not.toContain("errors");
  });

  it("reports rich results errors", () => {
    const result: InspectionResult = {
      richResultsResult: {
        verdict: "FAIL",
        detectedItems: [
          {
            richResultType: "FAQ",
            items: [{
              name: "FAQ",
              issues: [
                { issueMessage: "Missing field", severity: "ERROR" },
                { issueMessage: "Bad format", severity: "WARNING" },
              ],
            }],
          },
        ],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("Rich results: FAQ (1 errors) [FAIL]");
  });

  it("reports AMP status", () => {
    const result: InspectionResult = {
      ampResult: {
        verdict: "FAIL",
        issues: [
          { issueMessage: "AMP error", severity: "ERROR" },
          { issueMessage: "AMP warning", severity: "WARNING" },
        ],
      },
    };

    const summary = buildInspectionSummary(result);
    expect(summary).toContain("AMP: FAIL (1 errors)");
  });

  it("handles empty inspection result", () => {
    const summary = buildInspectionSummary({});
    expect(summary).toBe(".");
  });
});

describe("inspect_url tool", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;
  let handler: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "https://example.com/", resolved: false });

    const server = new McpServer({ name: "test", version: "0.0.1" });
    const originalRegisterTool = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      // @ts-expect-error - simplified mock
      (_name: string, _config: unknown, h: (args: Record<string, unknown>, extra: Record<string, unknown>) => Promise<unknown>) => {
        handler = h;
        return originalRegisterTool(_name, _config, h);
      },
    );
    registerInspectUrlTool(server, client, resolver);
  });

  it("calls inspection API and returns result with summary", async () => {
    mockApiSuccess({
      inspectionResult: {
        inspectionResultLink: "https://search.google.com/search-console/inspect?resource_id=...",
        indexStatusResult: {
          verdict: "PASS",
          coverageState: "Submitted and indexed",
          lastCrawlTime: "2026-03-05T10:00:00Z",
          crawledAs: "MOBILE",
          pageFetchState: "SUCCESSFUL",
          robotsTxtState: "ALLOWED",
          indexingState: "INDEXING_ALLOWED",
        },
      },
    });

    const result = await handler({
      url: "https://example.com/page",
      site_url: "https://example.com/",
    }, mockExtra);

    const parsed = parseResult(result);
    expect(parsed._summary).toContain("Index: PASS");
    expect(parsed.indexStatusResult).toBeTruthy();
    expect(parsed.inspectionResultLink).toBeTruthy();

    vi.unstubAllGlobals();
  });

  it("passes language_code to API", async () => {
    const mockFetch = mockApiSuccess({
      inspectionResult: { indexStatusResult: { verdict: "PASS" } },
    });

    await handler({
      url: "https://example.com/page",
      site_url: "https://example.com/",
      language_code: "de",
    }, mockExtra);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.languageCode).toBe("de");

    vi.unstubAllGlobals();
  });

  it("uses postInspection endpoint (searchconsole API)", async () => {
    const mockFetch = mockApiSuccess({
      inspectionResult: { indexStatusResult: { verdict: "PASS" } },
    });

    await handler({
      url: "https://example.com/page",
      site_url: "https://example.com/",
    }, mockExtra);

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("searchconsole.googleapis.com");
    expect(url).toContain("/urlInspection/index:inspect");

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      json: async () => ({ error: { message: "Access denied" } }),
    }));

    const result = await handler({
      url: "https://example.com/page",
      site_url: "https://example.com/",
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });
});
