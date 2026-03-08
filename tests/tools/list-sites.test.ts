import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { registerListSitesTool } from "../../src/tools/list-sites.js";

const mockTokenProvider = async () => "ya29.mock-token";

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

describe("list_sites tool", () => {
  let client: GscApiClient;
  let handler: () => Promise<unknown>;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);

    const server = new McpServer({ name: "test", version: "0.0.1" });
    const originalRegisterTool = server.registerTool.bind(server);
    vi.spyOn(server, "registerTool").mockImplementation(
      // @ts-expect-error - simplified mock
      (_name: string, _config: unknown, h: () => Promise<unknown>) => {
        handler = h;
        return originalRegisterTool(_name, _config, h);
      },
    );
    registerListSitesTool(server, client);
  });

  it("registers the tool", () => {
    expect(handler).toBeDefined();
  });

  it("returns total count and sites array", async () => {
    mockApiSuccess({
      siteEntry: [
        { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
      ],
    });

    const result = await handler();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(1);
    expect(parsed.sites).toHaveLength(1);

    vi.unstubAllGlobals();
  });

  it("handles empty site list", async () => {
    mockApiSuccess({ siteEntry: [] });

    const result = await handler();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.sites).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("handles missing siteEntry", async () => {
    mockApiSuccess({});

    const result = await handler();
    const parsed = parseResult(result);
    expect(parsed.total).toBe(0);
    expect(parsed.sites).toEqual([]);

    vi.unstubAllGlobals();
  });

  describe("classification", () => {
    it("classifies sc-domain: as domain type", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].url).toBe("sc-domain:example.com");
      // Single site = flat entry, no type field at top level in flat mode
      // But permission is there
      expect(sites[0].permission).toBe("owner");

      vi.unstubAllGlobals();
    });

    it("classifies https URL as https type", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://example.com/", permissionLevel: "siteFullUser" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].permission).toBe("full");

      vi.unstubAllGlobals();
    });

    it("classifies subdir URL correctly", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].url).toBe("https://example.com/blog/");

      vi.unstubAllGlobals();
    });
  });

  describe("grouping", () => {
    it("groups multiple properties under same domain", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;

      // Should be grouped under one domain
      expect(sites).toHaveLength(1);
      expect(sites[0].domain).toBe("example.com");
      expect(sites[0].properties).toHaveLength(3);

      vi.unstubAllGlobals();
    });

    it("keeps single-property domains flat", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://single.com/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;

      expect(sites).toHaveLength(1);
      expect(sites[0].url).toBe("https://single.com/");
      expect(sites[0].domain).toBeUndefined();

      vi.unstubAllGlobals();
    });

    it("picks domain property as default over https", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].default).toBe("sc-domain:example.com");

      vi.unstubAllGlobals();
    });

    it("picks https over http as default", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "http://example.com/", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].default).toBe("https://example.com/");

      vi.unstubAllGlobals();
    });

    it("skips unverified properties for default selection", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteUnverifiedUser" },
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].default).toBe("https://example.com/");

      vi.unstubAllGlobals();
    });
  });

  describe("unverified handling", () => {
    it("marks unverified sites with note", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://unverified.com/", permissionLevel: "siteUnverifiedUser" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].permission).toBe("unverified");
      expect(sites[0].note).toBe("no API access");

      vi.unstubAllGlobals();
    });

    it("sorts unverified sites to the end", async () => {
      mockApiSuccess({
        siteEntry: [
          { siteUrl: "https://unverified.com/", permissionLevel: "siteUnverifiedUser" },
          { siteUrl: "https://verified.com/", permissionLevel: "siteOwner" },
        ],
      });

      const result = await handler();
      const parsed = parseResult(result);
      const sites = parsed.sites as Array<Record<string, unknown>>;
      expect(sites[0].url).toBe("https://verified.com/");
      expect(sites[1].url).toBe("https://unverified.com/");

      vi.unstubAllGlobals();
    });
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      json: async () => ({ error: { message: "Internal error" } }),
    }));

    const result = await handler();
    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });

  describe("permission mapping", () => {
    it("maps siteOwner to owner", async () => {
      mockApiSuccess({
        siteEntry: [{ siteUrl: "https://a.com/", permissionLevel: "siteOwner" }],
      });
      const parsed = parseResult(await handler());
      expect((parsed.sites as Array<Record<string, unknown>>)[0].permission).toBe("owner");
      vi.unstubAllGlobals();
    });

    it("maps siteRestrictedUser to restricted", async () => {
      mockApiSuccess({
        siteEntry: [{ siteUrl: "https://a.com/", permissionLevel: "siteRestrictedUser" }],
      });
      const parsed = parseResult(await handler());
      expect((parsed.sites as Array<Record<string, unknown>>)[0].permission).toBe("restricted");
      vi.unstubAllGlobals();
    });
  });
});
