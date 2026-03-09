import { describe, it, expect, beforeEach } from "vitest";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerPrompts } from "../src/prompts.js";

describe("MCP prompts", () => {
  let server: McpServer;
  const registeredPrompts: Map<
    string,
    { config: Record<string, unknown>; handler: (...args: unknown[]) => Promise<unknown> }
  > = new Map();

  beforeEach(() => {
    registeredPrompts.clear();
    server = new McpServer({ name: "test", version: "0.0.1" });

    const originalRegisterPrompt = server.registerPrompt.bind(server);
    // @ts-expect-error - simplified mock capturing
    server.registerPrompt = (name: string, config: Record<string, unknown>, handler: (...args: unknown[]) => Promise<unknown>) => {
      registeredPrompts.set(name, { config, handler });
      return originalRegisterPrompt(name, config, handler);
    };

    registerPrompts(server, z.string().describe("Site URL"));
  });

  it("registers exactly 3 prompts", () => {
    expect(registeredPrompts.size).toBe(3);
  });

  it("registers seo_performance_analysis, index_coverage_check, content_opportunity_analysis", () => {
    expect(registeredPrompts.has("seo_performance_analysis")).toBe(true);
    expect(registeredPrompts.has("index_coverage_check")).toBe(true);
    expect(registeredPrompts.has("content_opportunity_analysis")).toBe(true);
  });

  describe("seo_performance_analysis", () => {
    it("has correct metadata", () => {
      const { config } = registeredPrompts.get("seo_performance_analysis")!;
      expect(config.title).toBe("SEO Performance Analysis");
      expect(config.description).toContain("5-step");
    });

    it("returns messages with site_url and default 28d period", async () => {
      const { handler } = registeredPrompts.get("seo_performance_analysis")!;
      const result = (await handler({ site_url: "example.com", period: "28d" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };

      expect(result.messages).toHaveLength(1);
      expect(result.messages[0].role).toBe("user");
      expect(result.messages[0].content.type).toBe("text");

      const text = result.messages[0].content.text;
      expect(text).toContain("example.com");
      expect(text).toContain("28 days");
      expect(text).toContain("Step 1");
      expect(text).toContain("Step 5");
      expect(text).toContain("Final Report");
    });

    it("uses 7 days for 7d period", async () => {
      const { handler } = registeredPrompts.get("seo_performance_analysis")!;
      const result = (await handler({ site_url: "example.com", period: "7d" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      expect(result.messages[0].content.text).toContain("7 days");
    });

    it("uses 90 days for 90d period", async () => {
      const { handler } = registeredPrompts.get("seo_performance_analysis")!;
      const result = (await handler({ site_url: "example.com", period: "90d" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      expect(result.messages[0].content.text).toContain("90 days");
    });

    it("references all 5 analysis steps", async () => {
      const { handler } = registeredPrompts.get("seo_performance_analysis")!;
      const result = (await handler({ site_url: "test.com", period: "28d" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      const text = result.messages[0].content.text;
      expect(text).toContain("Top Queries");
      expect(text).toContain("Top Pages");
      expect(text).toContain("Device Split");
      expect(text).toContain("Country Split");
      expect(text).toContain("Trends");
    });
  });

  describe("index_coverage_check", () => {
    it("has correct metadata", () => {
      const { config } = registeredPrompts.get("index_coverage_check")!;
      expect(config.title).toBe("Index Coverage Check");
      expect(config.description).toContain("URL inspection");
    });

    it("returns messages listing provided URLs", async () => {
      const { handler } = registeredPrompts.get("index_coverage_check")!;
      const result = (await handler({
        site_url: "example.com",
        urls: "https://example.com/page1, https://example.com/page2",
      })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };

      expect(result.messages).toHaveLength(1);
      const text = result.messages[0].content.text;
      expect(text).toContain("example.com");
      expect(text).toContain("https://example.com/page1");
      expect(text).toContain("https://example.com/page2");
      expect(text).toContain("batch_inspect_urls");
    });

    it("handles single URL without trailing comma", async () => {
      const { handler } = registeredPrompts.get("index_coverage_check")!;
      const result = (await handler({
        site_url: "example.com",
        urls: "https://example.com/only",
      })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      const text = result.messages[0].content.text;
      expect(text).toContain("https://example.com/only");
    });

    it("requests structured coverage report", async () => {
      const { handler } = registeredPrompts.get("index_coverage_check")!;
      const result = (await handler({
        site_url: "example.com",
        urls: "https://example.com/a",
      })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      const text = result.messages[0].content.text;
      expect(text).toContain("Summary Table");
      expect(text).toContain("Issues Found");
      expect(text).toContain("Recommendations");
    });
  });

  describe("content_opportunity_analysis", () => {
    it("has correct metadata", () => {
      const { config } = registeredPrompts.get("content_opportunity_analysis")!;
      expect(config.title).toBe("Content Opportunity Analysis");
      expect(config.description).toContain("Low-Hanging Fruit");
    });

    it("returns messages with all 3 analysis steps", async () => {
      const { handler } = registeredPrompts.get("content_opportunity_analysis")!;
      const result = (await handler({ site_url: "example.com" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };

      expect(result.messages).toHaveLength(1);
      const text = result.messages[0].content.text;
      expect(text).toContain("example.com");
      expect(text).toContain("Low-Hanging Fruit");
      expect(text).toContain("Keyword Cannibalization");
      expect(text).toContain("Trending Queries");
      expect(text).toContain("Final Report");
    });

    it("includes comparison mode for trends", async () => {
      const { handler } = registeredPrompts.get("content_opportunity_analysis")!;
      const result = (await handler({ site_url: "test.com" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      const text = result.messages[0].content.text;
      expect(text).toContain("compare_mode=previous_period");
    });

    it("includes actionable report sections", async () => {
      const { handler } = registeredPrompts.get("content_opportunity_analysis")!;
      const result = (await handler({ site_url: "test.com" })) as {
        messages: Array<{ role: string; content: { type: string; text: string } }>;
      };
      const text = result.messages[0].content.text;
      expect(text).toContain("Quick Wins");
      expect(text).toContain("Cannibalization Fixes");
      expect(text).toContain("Rising Topics");
      expect(text).toContain("Declining Topics");
    });
  });
});
