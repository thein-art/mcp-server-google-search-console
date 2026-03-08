import { describe, it, expect, vi, beforeEach } from "vitest";
import { GscApiClient } from "../src/api-client.js";
import { SiteResolver } from "../src/site-resolver.js";
import type { SiteList } from "../src/types.js";

const mockTokenProvider = async () => "ya29.mock-token";

function mockSiteList(sites: SiteList) {
  const mockFetch = vi.fn().mockResolvedValue({
    ok: true,
    text: async () => JSON.stringify(sites),
  });
  vi.stubGlobal("fetch", mockFetch);
  return mockFetch;
}

const STANDARD_SITES: SiteList = {
  siteEntry: [
    { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
    { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
    { siteUrl: "http://example.com/", permissionLevel: "siteFullUser" },
    { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
    { siteUrl: "https://www.other.com/", permissionLevel: "siteOwner" },
  ],
};

describe("SiteResolver", () => {
  let client: GscApiClient;
  let resolver: SiteResolver;

  beforeEach(() => {
    vi.unstubAllGlobals();
    client = new GscApiClient(mockTokenProvider);
    resolver = new SiteResolver(client);
  });

  describe("resolve — exact match", () => {
    it("returns exact match without resolving", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("sc-domain:example.com");
      expect(result).toEqual({ siteUrl: "sc-domain:example.com", resolved: false });
    });

    it("returns exact match for https URL", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("https://example.com/");
      expect(result).toEqual({ siteUrl: "https://example.com/", resolved: false });
    });

    it("returns exact match for subdir property", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("https://example.com/blog/");
      expect(result).toEqual({ siteUrl: "https://example.com/blog/", resolved: false });
    });
  });

  describe("resolve — sc-domain: matching", () => {
    it("resolves bare domain to sc-domain property", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("example.com");
      expect(result).toEqual({ siteUrl: "sc-domain:example.com", resolved: true });
    });

    it("resolves sc-domain: prefix (non-exact) to sc-domain property", async () => {
      mockSiteList({
        siteEntry: [{ siteUrl: "sc-domain:test.org", permissionLevel: "siteOwner" }],
      });
      const result = await resolver.resolve("test.org");
      expect(result).toEqual({ siteUrl: "sc-domain:test.org", resolved: true });
    });
  });

  describe("resolve — https/http root matching", () => {
    it("resolves bare domain to https root when no sc-domain exists", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://nodomain.com/", permissionLevel: "siteOwner" },
          { siteUrl: "http://nodomain.com/", permissionLevel: "siteFullUser" },
        ],
      });
      const result = await resolver.resolve("nodomain.com");
      expect(result).toEqual({ siteUrl: "https://nodomain.com/", resolved: true });
    });

    it("resolves to http root when no https exists", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "http://legacy.com/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("legacy.com");
      expect(result).toEqual({ siteUrl: "http://legacy.com/", resolved: true });
    });

    it("resolves www variant to property without www", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("www.example.com");
      expect(result).toEqual({ siteUrl: "https://example.com/", resolved: true });
    });

    it("resolves to www property when www is in the property URL", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://www.example.com/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("example.com");
      expect(result).toEqual({ siteUrl: "https://www.example.com/", resolved: true });
    });
  });

  describe("resolve — subdir matching", () => {
    it("resolves path to most specific subdir property", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/blog/tech/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("example.com/blog/tech/post");
      expect(result).toEqual({ siteUrl: "https://example.com/blog/tech/", resolved: true });
    });

    it("resolves path to parent subdir when no exact subdir match", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://example.com/", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("example.com/blog/some-post");
      expect(result).toEqual({ siteUrl: "https://example.com/blog/", resolved: true });
    });

    it("falls back to sc-domain for path when subdir doesn't match", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("example.com/shop/item");
      expect(result).toEqual({ siteUrl: "sc-domain:example.com", resolved: true });
    });
  });

  describe("resolve — no match", () => {
    it("returns input as-is when no match found", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("unknown-site.org");
      expect(result).toEqual({ siteUrl: "unknown-site.org", resolved: false });
    });

    it("returns malformed input as-is", async () => {
      mockSiteList(STANDARD_SITES);
      const result = await resolver.resolve("not a url at all");
      // parseInput will try to parse, but hostname will be garbage — no match
      expect(result.resolved).toBe(false);
    });

    it("returns empty site list input as-is", async () => {
      mockSiteList({ siteEntry: [] });
      const result = await resolver.resolve("example.com");
      expect(result).toEqual({ siteUrl: "example.com", resolved: false });
    });
  });

  describe("parseInput via resolve (indirect)", () => {
    it("handles full https URL with path", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "https://example.com/blog/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("https://example.com/blog/post");
      expect(result).toEqual({ siteUrl: "https://example.com/blog/", resolved: true });
    });

    it("handles full http URL", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "http://example.com/", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("http://example.com/page");
      expect(result).toEqual({ siteUrl: "http://example.com/", resolved: true });
    });

    it("handles sc-domain: prefix input", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        ],
      });
      // Non-exact sc-domain input (different domain)
      const result = await resolver.resolve("sc-domain:other.com");
      expect(result.resolved).toBe(false);
    });

    it("strips www from bare domain input", async () => {
      mockSiteList({
        siteEntry: [
          { siteUrl: "sc-domain:example.com", permissionLevel: "siteOwner" },
        ],
      });
      const result = await resolver.resolve("www.example.com");
      expect(result).toEqual({ siteUrl: "sc-domain:example.com", resolved: true });
    });
  });

  describe("cache behavior", () => {
    it("caches site list and reuses it", async () => {
      const mockFetch = mockSiteList(STANDARD_SITES);

      await resolver.resolve("example.com");
      await resolver.resolve("other.com");

      // Only one API call despite two resolves
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("invalidate clears cache", async () => {
      const mockFetch = mockSiteList(STANDARD_SITES);

      await resolver.resolve("example.com");
      expect(mockFetch).toHaveBeenCalledOnce();

      resolver.invalidate();
      await resolver.resolve("example.com");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("coalesces concurrent requests", async () => {
      // Create a fresh resolver to avoid cache from previous tests
      const freshClient = new GscApiClient(mockTokenProvider);
      const freshResolver = new SiteResolver(freshClient);

      let resolveResponse: (value: Response) => void;
      const mockFetch = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => { resolveResponse = resolve; }),
      );
      vi.stubGlobal("fetch", mockFetch);

      const p1 = freshResolver.resolve("example.com");
      const p2 = freshResolver.resolve("other.com");

      // Wait a tick for promises to register
      await new Promise((r) => setTimeout(r, 0));

      expect(mockFetch).toHaveBeenCalledOnce();

      resolveResponse!({
        ok: true,
        text: async () => JSON.stringify(STANDARD_SITES),
      } as unknown as Response);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1.siteUrl).toBe("sc-domain:example.com");
      expect(r2.siteUrl).toBe("https://www.other.com/");
    });
  });
});
