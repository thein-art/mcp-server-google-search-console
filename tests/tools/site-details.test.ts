import { describe, it, expect, vi, beforeEach } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GscApiClient } from "../../src/api-client.js";
import { SiteResolver } from "../../src/site-resolver.js";
import { registerSiteDetailsTool } from "../../src/tools/site-details.js";

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

describe("get_site tool", () => {
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
    registerSiteDetailsTool(server, client, resolver);
  });

  it("registers the tool", () => {
    expect(handler).toBeDefined();
  });

  it("returns site details with permission level", async () => {
    mockApiSuccess({
      siteUrl: "https://example.com/",
      permissionLevel: "siteOwner",
    });

    const result = await handler({ site_url: "https://example.com/" });
    const parsed = parseResult(result);
    expect(parsed.siteUrl).toBe("https://example.com/");
    expect(parsed.permissionLevel).toBe("siteOwner");

    vi.unstubAllGlobals();
  });

  it("includes resolved note when site was resolved", async () => {
    vi.spyOn(resolver, "resolve").mockResolvedValue({ siteUrl: "sc-domain:example.com", resolved: true });

    mockApiSuccess({
      siteUrl: "sc-domain:example.com",
      permissionLevel: "siteOwner",
    });

    const result = await handler({ site_url: "example.com" });
    const parsed = parseResult(result);
    expect(parsed._resolved).toContain("Resolved");
    expect(parsed.siteUrl).toBe("sc-domain:example.com");

    vi.unstubAllGlobals();
  });

  it("returns error on API failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      headers: new Headers(),
      json: async () => ({ error: { message: "Not found" } }),
    }));

    const result = await handler({ site_url: "https://unknown.com/" });
    expect((result as { isError: boolean }).isError).toBe(true);

    vi.unstubAllGlobals();
  });

  it("calls API with encoded site URL", async () => {
    const mockFetch = mockApiSuccess({
      siteUrl: "https://example.com/",
      permissionLevel: "siteOwner",
    });

    await handler({ site_url: "https://example.com/" });

    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain(encodeURIComponent("https://example.com/"));

    vi.unstubAllGlobals();
  });
});
