import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function registerPrompts(server: McpServer, completableSiteUrl: ZodTypeAny) {
  server.registerPrompt("seo_performance_analysis", {
    title: "SEO Performance Analysis",
    description:
      "Guided 5-step SEO performance analysis: Top Queries → Top Pages → Device Split → Country Split → Trends. Produces a structured report with actionable insights.",
    argsSchema: {
      site_url: completableSiteUrl,
      period: z
        .enum(["7d", "28d", "90d"])
        .default("28d")
        .describe("Analysis period: 7d, 28d, or 90d"),
    },
  }, async ({ site_url, period }) => {
    const days = period === "7d" ? 7 : period === "90d" ? 90 : 28;

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Perform a comprehensive SEO performance analysis for "${site_url}" over the last ${days} days.`,
              "",
              "Follow these steps in order, using the available GSC tools:",
              "",
              "## Step 1: Top Queries",
              `Call search_analytics for "${site_url}" with dimensions=[query], row_limit=20, ordered by clicks descending.`,
              "Summarize the top queries with clicks, impressions, CTR, and position.",
              "",
              "## Step 2: Top Pages",
              `Call search_analytics for "${site_url}" with dimensions=[page], row_limit=20, ordered by clicks descending.`,
              "Identify the highest-traffic pages and any pages with high impressions but low CTR.",
              "",
              "## Step 3: Device Split",
              `Call search_analytics for "${site_url}" with dimensions=[device].`,
              "Show the traffic split between DESKTOP, MOBILE, and TABLET. Flag significant mobile vs desktop gaps.",
              "",
              "## Step 4: Country Split",
              `Call search_analytics for "${site_url}" with dimensions=[country], row_limit=10.`,
              "Show the top countries by clicks. Identify growth markets.",
              "",
              "## Step 5: Trends",
              `Call search_analytics for "${site_url}" with compare_mode=previous_period.`,
              "Analyze the period-over-period change in clicks, impressions, CTR, and position.",
              "",
              "## Final Report",
              "Combine all findings into a structured report with:",
              "- Executive Summary (3 bullet points)",
              "- Key Metrics table",
              "- Top Opportunities (high impressions, low CTR or positions 5-20)",
              "- Risk Areas (declining metrics)",
              "- Recommended Next Steps",
            ].join("\n"),
          },
        },
      ],
    };
  });

  server.registerPrompt("index_coverage_check", {
    title: "Index Coverage Check",
    description:
      "URL inspection workflow that checks indexing status for one or more URLs using batch_inspect_urls, then produces a structured coverage report.",
    argsSchema: {
      site_url: completableSiteUrl,
      urls: z
        .string()
        .describe("Comma-separated list of URLs to inspect (max 20)"),
    },
  }, async ({ site_url, urls }) => {
    const urlList = urls
      .split(",")
      .map((u) => u.trim())
      .filter(Boolean);
    const urlDisplay = urlList.map((u) => `- ${u}`).join("\n");

    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Check the indexing status for the following URLs on "${site_url}":`,
              "",
              urlDisplay,
              "",
              `Call batch_inspect_urls for "${site_url}" with the URLs listed above.`,
              "",
              "Then produce a structured report with:",
              "",
              "## Summary Table",
              "| URL | Index Status | Crawl Status | Canonical | Mobile | Issues |",
              "Show one row per URL with the key signals from the inspection results.",
              "",
              "## Issues Found",
              "List any URLs with problems:",
              "- Not indexed or blocked",
              "- Canonical mismatch (Google canonical differs from user canonical)",
              "- Mobile usability issues",
              "- Crawl errors",
              "",
              "## Recommendations",
              "For each issue found, provide a specific fix action.",
            ].join("\n"),
          },
        },
      ],
    };
  });

  server.registerPrompt("content_opportunity_analysis", {
    title: "Content Opportunity Analysis",
    description:
      "Full-funnel SEO opportunity analysis: Low-Hanging Fruit identification (positions 5-20 with high impressions), Keyword Cannibalization detection (queries ranking on multiple pages), and Trending analysis via comparison mode.",
    argsSchema: {
      site_url: z
        .string()
        .describe("The site to analyze (e.g. 'example.com')"),
    },
  }, async ({ site_url }) => {
    return {
      messages: [
        {
          role: "user" as const,
          content: {
            type: "text" as const,
            text: [
              `Perform a content opportunity analysis for "${site_url}". Follow these three steps:`,
              "",
              "## Step 1: Low-Hanging Fruit",
              `Call search_analytics for "${site_url}" with:`,
              "- dimensions=[query, page]",
              "- row_limit=50",
              "- filters: position > 4 AND position < 21 (use includingRegex or manual filtering)",
              "- Order by impressions descending",
              "",
              "These are queries where the site already ranks on page 1-2 but could move higher with optimization.",
              "Prioritize by: high impressions + low CTR = biggest opportunity.",
              "",
              "## Step 2: Keyword Cannibalization",
              `Call search_analytics for "${site_url}" with:`,
              "- dimensions=[query, page]",
              "- row_limit=100",
              "- Order by impressions descending",
              "",
              "Identify queries that rank with MORE than one page. These indicate cannibalization.",
              "For each cannibalized query, show all competing pages with their clicks, impressions, and position.",
              "Flag cases where click distribution is split roughly evenly — these hurt the most.",
              "",
              "## Step 3: Trending Queries",
              `Call search_analytics for "${site_url}" with:`,
              "- dimensions=[query]",
              "- compare_mode=previous_period",
              "- row_limit=30",
              "",
              "Identify queries with the largest positive and negative trends.",
              "",
              "## Final Report",
              "Combine all findings into:",
              "- **Quick Wins**: Top 5-10 low-hanging fruit queries with specific page + optimization suggestions",
              "- **Cannibalization Fixes**: Queries with multiple ranking pages and recommended consolidation strategy",
              "- **Rising Topics**: Trending queries to double down on",
              "- **Declining Topics**: Queries losing ground that need attention",
            ].join("\n"),
          },
        },
      ],
    };
  });
}
