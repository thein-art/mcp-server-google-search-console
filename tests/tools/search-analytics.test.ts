import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import {
  registerSearchAnalyticsTool,
  calcCompareDates,
  resolveGranularity,
  dateBucketKey,
  aggregateByDateGranularity,
} from "../../src/tools/search-analytics.js";

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

/** Mock that returns different data per call (for comparison mode). */
function mockApiSequence(...responses: unknown[]) {
  let callIndex = 0;
  const mockFetch = vi.fn().mockImplementation(async () => ({
    ok: true,
    text: async () => JSON.stringify(responses[callIndex++] ?? { rows: [] }),
  }));
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

function parseBody(mockFetch: ReturnType<typeof vi.fn>, callIndex = 0): Record<string, unknown> {
  return JSON.parse(mockFetch.mock.calls[callIndex][1].body);
}

function parseResult(result: unknown): Record<string, unknown> {
  return JSON.parse((result as { content: Array<{ text: string }> }).content[0].text);
}

describe("search-analytics tool", () => {
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

    registerSearchAnalyticsTool(server, client, resolver);
  });

  it("registers the tool with registerTool", () => {
    expect(server.registerTool).toHaveBeenCalledWith(
      "get_search_analytics",
      expect.objectContaining({
        title: "Search Analytics",
        description: expect.any(String),
        inputSchema: expect.any(Object),
      }),
      expect.any(Function),
    );
  });

  it("calls API with correct parameters", async () => {
    const mockFetch = mockApiSuccess({
      rows: [
        { keys: ["test query"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3.5 },
      ],
      responseAggregationType: "auto",
    });

    const result = await registeredHandler({
      site_url: "https://example.com/",
      start_date: "2024-01-01",
      end_date: "2024-01-31",
      dimensions: ["query"],
      row_limit: 10,
    }, mockExtra);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/searchAnalytics/query"),
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"startDate":"2024-01-01"'),
      }),
    );

    const parsed = parseResult(result);
    expect(parsed.rows).toHaveLength(1);
    expect((parsed.rows as Array<{ clicks: number }>)[0].clicks).toBe(100);
    expect(parsed.rowCount).toBe(1);

    vi.unstubAllGlobals();
  });

  it("validates date range", async () => {
    const result = await registeredHandler({
      site_url: "https://example.com/",
      start_date: "2024-02-01",
      end_date: "2024-01-01",
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("Invalid date range");
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      headers: new Headers(),
      json: async () => ({ error: { message: "Invalid request" } }),
    }));

    const result = await registeredHandler({
      site_url: "https://example.com/",
    }, mockExtra);

    expect((result as { isError: boolean }).isError).toBe(true);
    expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("Invalid request");

    vi.unstubAllGlobals();
  });

  describe("convenience filters", () => {
    it("converts filter_query to dimensionFilterGroups with contains operator", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "query", operator: "contains", expression: "seo" }],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("converts filter_page to dimensionFilterGroups with contains operator", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_page: "/blog/",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "page", operator: "contains", expression: "/blog/" }],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("converts filter_device to dimensionFilterGroups with equals operator", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_device: "MOBILE",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "device", operator: "equals", expression: "MOBILE" }],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("converts filter_country to dimensionFilterGroups with equals operator", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_country: "deu",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "country", operator: "equals", expression: "deu" }],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("auto-adds query dimension when filter_query is set and no explicit dimensions", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensions).toEqual(["query"]);

      vi.unstubAllGlobals();
    });

    it("auto-adds query dimension when filter_page is set (typical intent: queries for these pages)", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_page: "/blog/",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensions).toEqual(["query"]);

      vi.unstubAllGlobals();
    });

    it("auto-adds query dimension once when both filter_query and filter_page are set", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
        filter_page: "/blog/",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensions).toEqual(["query"]);

      vi.unstubAllGlobals();
    });

    it("does not auto-add dimensions for device/country filters", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_device: "DESKTOP",
        filter_country: "usa",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensions).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("explicit dimensions override auto-dimensions", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
        dimensions: ["page"],
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensions).toEqual(["page"]);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [{ dimension: "query", operator: "contains", expression: "seo" }],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("merges convenience filters with generic filters", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
        filters: [{ dimension: "country", operator: "equals", expression: "deu" }],
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [
            { dimension: "query", operator: "contains", expression: "seo" },
            { dimension: "country", operator: "equals", expression: "deu" },
          ],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("merges all convenience filters together", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        filter_query: "seo",
        filter_page: "/blog/",
        filter_device: "MOBILE",
        filter_country: "deu",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toEqual([
        {
          groupType: "and",
          filters: [
            { dimension: "query", operator: "contains", expression: "seo" },
            { dimension: "page", operator: "contains", expression: "/blog/" },
            { dimension: "device", operator: "equals", expression: "MOBILE" },
            { dimension: "country", operator: "equals", expression: "deu" },
          ],
        },
      ]);

      vi.unstubAllGlobals();
    });

    it("no filters set produces no dimensionFilterGroups", async () => {
      const mockFetch = mockApiSuccess({ rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
      }, mockExtra);

      const body = parseBody(mockFetch);
      expect(body.dimensionFilterGroups).toBeUndefined();

      vi.unstubAllGlobals();
    });
  });

  describe("calcCompareDates", () => {
    it("previous_period: calculates same-length window before start", () => {
      // 7-day window: Feb 23 - Mar 1 → Feb 16 - Feb 22
      const { compareStart, compareEnd } = calcCompareDates("2026-02-23", "2026-03-01", "previous_period");
      expect(compareStart).toBe("2026-02-16");
      expect(compareEnd).toBe("2026-02-22");
    });

    it("previous_period: works for single-day period", () => {
      const { compareStart, compareEnd } = calcCompareDates("2026-03-01", "2026-03-01", "previous_period");
      expect(compareStart).toBe("2026-02-28");
      expect(compareEnd).toBe("2026-02-28");
    });

    it("previous_period: works for 28-day period", () => {
      const { compareStart, compareEnd } = calcCompareDates("2026-02-01", "2026-02-28", "previous_period");
      expect(compareStart).toBe("2026-01-04");
      expect(compareEnd).toBe("2026-01-31");
    });

    it("year_over_year: shifts both dates back one year", () => {
      const { compareStart, compareEnd } = calcCompareDates("2026-02-23", "2026-03-01", "year_over_year");
      expect(compareStart).toBe("2025-02-23");
      expect(compareEnd).toBe("2025-03-01");
    });

    it("year_over_year: clamps Feb 29 to Feb 28 in non-leap year (B2 fix)", () => {
      // Feb 29 2024 → Feb 28 2023 (clamped, not Mar 1)
      const { compareStart, compareEnd } = calcCompareDates("2024-02-29", "2024-02-29", "year_over_year");
      expect(compareStart).toBe("2023-02-28");
      expect(compareEnd).toBe("2023-02-28");
    });

    it("year_over_year: normal dates unaffected by leap year fix", () => {
      // Feb 15 2024 → Feb 15 2023 (no clamping needed)
      const { compareStart, compareEnd } = calcCompareDates("2024-02-15", "2024-02-15", "year_over_year");
      expect(compareStart).toBe("2023-02-15");
      expect(compareEnd).toBe("2023-02-15");
    });

    it("year_over_year: Feb 29 to Feb 29 leap-to-leap is unchanged", () => {
      // Feb 29 2028 → Feb 29 2027? No, 2027 is not leap. Clamp to Feb 28.
      const { compareStart, compareEnd } = calcCompareDates("2028-02-29", "2028-02-29", "year_over_year");
      expect(compareStart).toBe("2027-02-28");
      expect(compareEnd).toBe("2027-02-28");
    });
  });

  describe("comparison mode", () => {
    it("makes two API calls and returns delta metrics", async () => {
      const mockFetch = mockApiSequence(
        {
          rows: [
            { keys: ["seo"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3.5 },
            { keys: ["marketing"], clicks: 50, impressions: 500, ctr: 0.1, position: 5.0 },
          ],
        },
        {
          rows: [
            { keys: ["seo"], clicks: 80, impressions: 900, ctr: 0.0889, position: 4.0 },
            { keys: ["marketing"], clicks: 70, impressions: 600, ctr: 0.1167, position: 4.5 },
          ],
        },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      // Two API calls made
      expect(mockFetch).toHaveBeenCalledTimes(2);

      const parsed = parseResult(result);
      expect(parsed.currentPeriod).toEqual({ start: "2026-02-23", end: "2026-03-01" });
      expect(parsed.previousPeriod).toEqual({ start: "2026-02-16", end: "2026-02-22" });

      const rows = parsed.rows as Array<Record<string, unknown>>;
      expect(rows).toHaveLength(2);

      // Both have |delta| = 20, so order depends on stable sort
      // Check that both rows exist with correct deltas
      const seoRow = rows.find((r) => (r.keys as string[])[0] === "seo")!;
      const mktRow = rows.find((r) => (r.keys as string[])[0] === "marketing")!;

      expect(seoRow.current).toEqual({ clicks: 100, impressions: 1000, ctr: 0.1, position: 3.5 });
      expect(seoRow.previous).toEqual({ clicks: 80, impressions: 900, ctr: 0.0889, position: 4.0 });
      expect(seoRow.delta).toEqual({ clicks: 20, impressions: 100, ctr: 0.0111, position: -0.5 });
      expect((mktRow.delta as { clicks: number }).clicks).toBe(-20);

      vi.unstubAllGlobals();
    });

    it("includes keywords only in current period with previous: null", async () => {
      mockApiSequence(
        { rows: [{ keys: ["new-keyword"], clicks: 50, impressions: 200, ctr: 0.25, position: 2.0 }] },
        { rows: [] },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      const rows = parsed.rows as Array<Record<string, unknown>>;
      expect(rows[0].keys).toEqual(["new-keyword"]);
      expect(rows[0].current).toBeTruthy();
      expect(rows[0].previous).toBeNull();
      expect(rows[0].delta).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("includes keywords only in previous period with current: null", async () => {
      mockApiSequence(
        { rows: [] },
        { rows: [{ keys: ["lost-keyword"], clicks: 30, impressions: 100, ctr: 0.3, position: 3.0 }] },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      const rows = parsed.rows as Array<Record<string, unknown>>;
      expect(rows[0].keys).toEqual(["lost-keyword"]);
      expect(rows[0].current).toBeNull();
      expect(rows[0].previous).toBeTruthy();

      vi.unstubAllGlobals();
    });

    it("uses explicit compare dates when provided", async () => {
      const mockFetch = mockApiSequence({ rows: [] }, { rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_start_date: "2025-02-23",
        compare_end_date: "2025-03-01",
        dimensions: ["query"],
      }, mockExtra);

      // Check the second call uses the explicit comparison dates
      const body2 = parseBody(mockFetch, 1);
      expect(body2.startDate).toBe("2025-02-23");
      expect(body2.endDate).toBe("2025-03-01");

      vi.unstubAllGlobals();
    });

    it("rejects compare_period combined with explicit compare dates", async () => {
      mockApiSuccess({ rows: [] });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        compare_period: "previous_period",
        compare_start_date: "2025-01-01",
        compare_end_date: "2025-01-31",
      }, mockExtra);

      expect((result as { isError: boolean }).isError).toBe(true);
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("Cannot use compare_period together");

      vi.unstubAllGlobals();
    });

    it("rejects compare_start_date without compare_end_date", async () => {
      mockApiSuccess({ rows: [] });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        compare_start_date: "2025-01-01",
      }, mockExtra);

      expect((result as { isError: boolean }).isError).toBe(true);
      expect((result as { content: Array<{ text: string }> }).content[0].text).toContain("must be set together");

      vi.unstubAllGlobals();
    });

    it("oversamples API calls for complete joins", async () => {
      const mockFetch = mockApiSequence({ rows: [] }, { rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
        row_limit: 10,
      }, mockExtra);

      // Both API calls should use oversampled limit, not the user's row_limit
      const body1 = parseBody(mockFetch, 0);
      const body2 = parseBody(mockFetch, 1);
      expect(body1.rowLimit).toBeGreaterThanOrEqual(2000);
      expect(body2.rowLimit).toBeGreaterThanOrEqual(2000);

      vi.unstubAllGlobals();
    });

    it("trims result to row_limit", async () => {
      // Generate 5 rows per period
      const rows = Array.from({ length: 5 }, (_, i) => ({
        keys: [`keyword-${i}`], clicks: 100 - i * 10, impressions: 1000, ctr: 0.1, position: 3.0,
      }));
      mockApiSequence({ rows }, { rows });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
        row_limit: 3,
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed.rowCount).toBe(3);

      vi.unstubAllGlobals();
    });

    it("includes _comparison summary note", async () => {
      mockApiSequence(
        {
          rows: [
            { keys: ["both"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
            { keys: ["new"], clicks: 5, impressions: 50, ctr: 0.1, position: 3.0 },
          ],
        },
        {
          rows: [
            { keys: ["both"], clicks: 8, impressions: 80, ctr: 0.1, position: 6.0 },
            { keys: ["lost"], clicks: 3, impressions: 30, ctr: 0.1, position: 7.0 },
          ],
        },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      const note = parsed._comparison as string;
      expect(note).toContain("1 in both");
      expect(note).toContain("1 only in current (new)");
      expect(note).toContain("1 only in previous (lost)");

      vi.unstubAllGlobals();
    });

    it("applies convenience filters in comparison mode", async () => {
      const mockFetch = mockApiSequence({ rows: [] }, { rows: [] });

      await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        filter_page: "/magazin/",
      }, mockExtra);

      // Both calls should have the filter
      const body1 = parseBody(mockFetch, 0);
      const body2 = parseBody(mockFetch, 1);
      const expectedFilter = [{ groupType: "and", filters: [{ dimension: "page", operator: "contains", expression: "/magazin/" }] }];
      expect(body1.dimensionFilterGroups).toEqual(expectedFilter);
      expect(body2.dimensionFilterGroups).toEqual(expectedFilter);

      // Auto-dimension should be "query"
      expect(body1.dimensions).toEqual(["query"]);
      expect(body2.dimensions).toEqual(["query"]);

      vi.unstubAllGlobals();
    });

    it("sorts rows: delta rows first (desc by |clicks|), then current-only, then previous-only", async () => {
      mockApiSequence(
        {
          rows: [
            { keys: ["winner"], clicks: 100, impressions: 500, ctr: 0.2, position: 2.0 },
            { keys: ["loser"], clicks: 20, impressions: 200, ctr: 0.1, position: 5.0 },
            { keys: ["new-kw"], clicks: 50, impressions: 300, ctr: 0.167, position: 3.0 },
          ],
        },
        {
          rows: [
            { keys: ["winner"], clicks: 50, impressions: 400, ctr: 0.125, position: 3.0 },
            { keys: ["loser"], clicks: 80, impressions: 600, ctr: 0.133, position: 4.0 },
            { keys: ["lost-kw"], clicks: 30, impressions: 200, ctr: 0.15, position: 4.0 },
          ],
        },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2026-02-23",
        end_date: "2026-03-01",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      const rows = parsed.rows as Array<{ keys: string[]; delta?: { clicks: number } }>;

      // Sorted by |delta|: loser first (|delta| 60), then winner (|delta| 50), then new-kw, then lost-kw
      expect(rows[0].keys).toEqual(["loser"]);
      expect(rows[0].delta!.clicks).toBe(-60);
      expect(rows[1].keys).toEqual(["winner"]);
      expect(rows[1].delta!.clicks).toBe(50);
      expect(rows[2].keys).toEqual(["new-kw"]);
      expect(rows[3].keys).toEqual(["lost-kw"]);

      vi.unstubAllGlobals();
    });
  });

  describe("_summary", () => {
    it("includes _summary in standard mode without dimensions", async () => {
      mockApiSuccess({
        rows: [{ clicks: 12345, impressions: 234567, ctr: 0.0526, position: 12.4 }],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-01",
        end_date: "2024-01-28",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed._summary).toContain("28 days");
      expect(parsed._summary).toContain("12,345 clicks");
      expect(parsed._summary).toContain("CTR");

      vi.unstubAllGlobals();
    });

    it("includes _summary in standard mode with dimensions", async () => {
      mockApiSuccess({
        rows: [
          { keys: ["seo"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3.0 },
          { keys: ["marketing"], clicks: 50, impressions: 500, ctr: 0.1, position: 5.0 },
        ],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-01",
        end_date: "2024-01-28",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed._summary).toContain("2 rows");
      expect(parsed._summary).toContain("150 clicks");
      expect(parsed._summary).toContain("'seo'");

      vi.unstubAllGlobals();
    });

    it("includes _summary in standard mode with no data", async () => {
      mockApiSuccess({ rows: [] });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-01",
        end_date: "2024-01-28",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed._summary).toContain("no data");

      vi.unstubAllGlobals();
    });

    it("includes _summary in comparison mode", async () => {
      mockApiSequence(
        { rows: [{ keys: ["seo"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3.0 }] },
        { rows: [{ keys: ["seo"], clicks: 80, impressions: 900, ctr: 0.0889, position: 4.0 }] },
      );

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-15",
        end_date: "2024-01-28",
        compare_period: "previous_period",
        dimensions: ["query"],
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed._summary).toContain("vs prev");
      expect(parsed._summary).toContain("clicks");

      vi.unstubAllGlobals();
    });
  });

  describe("resolveGranularity", () => {
    it("returns daily for undefined", () => {
      expect(resolveGranularity(undefined, 30)).toBe("daily");
    });

    it("returns daily for daily", () => {
      expect(resolveGranularity("daily", 30)).toBe("daily");
    });

    it("returns weekly for weekly", () => {
      expect(resolveGranularity("weekly", 7)).toBe("weekly");
    });

    it("returns monthly for monthly", () => {
      expect(resolveGranularity("monthly", 7)).toBe("monthly");
    });

    it("auto: ≤14d returns daily", () => {
      expect(resolveGranularity("auto", 14)).toBe("daily");
    });

    it("auto: 15-60d returns weekly", () => {
      expect(resolveGranularity("auto", 15)).toBe("weekly");
      expect(resolveGranularity("auto", 60)).toBe("weekly");
    });

    it("auto: >60d returns monthly", () => {
      expect(resolveGranularity("auto", 61)).toBe("monthly");
    });
  });

  describe("dateBucketKey", () => {
    it("monthly: returns YYYY-MM", () => {
      expect(dateBucketKey("2024-01-15", "monthly")).toBe("2024-01");
      expect(dateBucketKey("2024-12-31", "monthly")).toBe("2024-12");
    });

    it("weekly: returns Monday of the ISO week", () => {
      // 2024-01-15 is a Monday
      expect(dateBucketKey("2024-01-15", "weekly")).toBe("2024-01-15");
      // 2024-01-17 is a Wednesday → Monday is 2024-01-15
      expect(dateBucketKey("2024-01-17", "weekly")).toBe("2024-01-15");
      // 2024-01-21 is a Sunday → Monday is 2024-01-15
      expect(dateBucketKey("2024-01-21", "weekly")).toBe("2024-01-15");
    });
  });

  describe("aggregateByDateGranularity", () => {
    it("aggregates daily rows into weekly buckets", () => {
      const rows = [
        { keys: ["2024-01-15"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
        { keys: ["2024-01-16"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
        { keys: ["2024-01-22"], clicks: 30, impressions: 300, ctr: 0.1, position: 4.0 },
      ];

      const result = aggregateByDateGranularity(rows, "weekly", 0);

      expect(result).toHaveLength(2);
      // First bucket: 2024-01-15 (Mon-Sun week)
      const week1 = result.find((r) => (r.keys as string[])[0] === "2024-01-15")!;
      expect(week1.clicks).toBe(30);
      expect(week1.impressions).toBe(300);
      // Weighted avg position: (5*100 + 3*200) / 300 = 1100/300 = 3.7
      expect(week1.position).toBe(3.7);
      // CTR recalculated: 30/300 = 0.1
      expect(week1.ctr).toBe(0.1);
    });

    it("aggregates daily rows into monthly buckets", () => {
      const rows = [
        { keys: ["2024-01-05"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
        { keys: ["2024-01-25"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
        { keys: ["2024-02-05"], clicks: 30, impressions: 300, ctr: 0.1, position: 4.0 },
      ];

      const result = aggregateByDateGranularity(rows, "monthly", 0);

      expect(result).toHaveLength(2);
      const jan = result.find((r) => (r.keys as string[])[0] === "2024-01")!;
      expect(jan.clicks).toBe(30);
      expect(jan.impressions).toBe(300);
    });

    it("handles multi-dimension keys with date at index 0", () => {
      const rows = [
        { keys: ["2024-01-15", "seo"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
        { keys: ["2024-01-16", "seo"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
        { keys: ["2024-01-15", "marketing"], clicks: 5, impressions: 50, ctr: 0.1, position: 8.0 },
      ];

      const result = aggregateByDateGranularity(rows, "weekly", 0);

      // All dates are in the same week (Mon 2024-01-15)
      expect(result).toHaveLength(2);
      const seo = result.find((r) => (r.keys as string[])[1] === "seo")!;
      expect(seo.clicks).toBe(30);
      const mkt = result.find((r) => (r.keys as string[])[1] === "marketing")!;
      expect(mkt.clicks).toBe(5);
    });

    it("handles zero impressions without division by zero", () => {
      const rows = [
        { keys: ["2024-01-15"], clicks: 0, impressions: 0, ctr: 0, position: 0 },
      ];

      const result = aggregateByDateGranularity(rows, "weekly", 0);
      expect(result[0].ctr).toBe(0);
      expect(result[0].position).toBe(0);
    });
  });

  describe("date_granularity integration", () => {
    it("applies weekly granularity to date-dimension results", async () => {
      mockApiSuccess({
        rows: [
          { keys: ["2024-01-15"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
          { keys: ["2024-01-16"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
          { keys: ["2024-01-22"], clicks: 30, impressions: 300, ctr: 0.1, position: 4.0 },
        ],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-15",
        end_date: "2024-01-28",
        dimensions: ["date"],
        date_granularity: "weekly",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed.dateGranularity).toBe("weekly");
      expect(parsed.rowCount).toBe(2);

      vi.unstubAllGlobals();
    });

    it("auto granularity for short period stays daily (no aggregation)", async () => {
      mockApiSuccess({
        rows: [
          { keys: ["2024-01-15"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
          { keys: ["2024-01-16"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
        ],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-15",
        end_date: "2024-01-20",
        dimensions: ["date"],
        date_granularity: "auto",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed.dateGranularity).toBeUndefined(); // stays daily, not set
      expect(parsed.rowCount).toBe(2);

      vi.unstubAllGlobals();
    });

    it("ignores date_granularity when date not in dimensions", async () => {
      mockApiSuccess({
        rows: [
          { keys: ["seo"], clicks: 100, impressions: 1000, ctr: 0.1, position: 3.0 },
        ],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        dimensions: ["query"],
        date_granularity: "monthly",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed.dateGranularity).toBeUndefined();
      expect(parsed.rowCount).toBe(1);

      vi.unstubAllGlobals();
    });

    it("monthly granularity aggregates correctly", async () => {
      mockApiSuccess({
        rows: [
          { keys: ["2024-01-05"], clicks: 10, impressions: 100, ctr: 0.1, position: 5.0 },
          { keys: ["2024-01-25"], clicks: 20, impressions: 200, ctr: 0.1, position: 3.0 },
          { keys: ["2024-02-05"], clicks: 30, impressions: 300, ctr: 0.1, position: 4.0 },
          { keys: ["2024-02-15"], clicks: 40, impressions: 400, ctr: 0.1, position: 2.0 },
        ],
      });

      const result = await registeredHandler({
        site_url: "https://example.com/",
        start_date: "2024-01-01",
        end_date: "2024-03-31",
        dimensions: ["date"],
        date_granularity: "monthly",
      }, mockExtra);

      const parsed = parseResult(result);
      expect(parsed.dateGranularity).toBe("monthly");
      const rows = parsed.rows as Array<{ keys: string[]; clicks: number }>;
      expect(rows).toHaveLength(2);
      const jan = rows.find((r) => r.keys[0] === "2024-01")!;
      expect(jan.clicks).toBe(30);
      const feb = rows.find((r) => r.keys[0] === "2024-02")!;
      expect(feb.clicks).toBe(70);

      vi.unstubAllGlobals();
    });
  });
});
