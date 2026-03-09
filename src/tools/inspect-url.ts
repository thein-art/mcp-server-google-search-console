import { z } from "zod";
import type { ZodTypeAny } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteResolver } from "../site-resolver.js";
import type { InspectUrlResponse, InspectionResult } from "../types.js";
import { toolResult, toolError, resolveSiteUrl } from "../util.js";

/** Build a human-readable summary of the inspection result. */
export function buildInspectionSummary(r: InspectionResult): string {
  const parts: string[] = [];

  const idx = r.indexStatusResult;
  if (idx) {
    const verdict = idx.verdict ?? "UNKNOWN";
    const state = idx.coverageState ? `: ${idx.coverageState}` : "";
    parts.push(`Index: ${verdict}${state}`);

    if (idx.lastCrawlTime) {
      const date = idx.lastCrawlTime.split("T")[0];
      parts.push(`Last crawl: ${date} (${idx.crawledAs ?? "unknown agent"})`);
    }

    if (idx.pageFetchState && idx.pageFetchState !== "SUCCESSFUL") {
      parts.push(`Fetch: ${idx.pageFetchState}`);
    }

    if (idx.robotsTxtState === "DISALLOWED") {
      parts.push("Blocked by robots.txt");
    }

    if (idx.indexingState && idx.indexingState !== "INDEXING_ALLOWED") {
      parts.push(`Indexing: ${idx.indexingState}`);
    }

    // Canonical mismatch detection
    if (idx.googleCanonical && idx.userCanonical && idx.googleCanonical !== idx.userCanonical) {
      parts.push(`CANONICAL MISMATCH: Google selected "${idx.googleCanonical}" but page declares "${idx.userCanonical}"`);
    }

    if (idx.sitemap && idx.sitemap.length > 0) {
      parts.push(`Referenced in ${idx.sitemap.length} sitemap(s)`);
    }
  }

  const mobile = r.mobileUsabilityResult;
  if (mobile) {
    if (mobile.verdict === "PASS") {
      parts.push("Mobile: PASS");
    } else {
      const issueTypes = (mobile.issues?.length ?? 0) > 0
        ? mobile.issues!.map((i) => i.issueType ?? i.message).join(", ")
        : "no details";
      parts.push(`Mobile: ${mobile.verdict} (${issueTypes})`);
    }
  }

  const rich = r.richResultsResult;
  if (rich?.detectedItems && rich.detectedItems.length > 0) {
    const types = rich.detectedItems.map((d) => d.richResultType).filter(Boolean);
    const errorCount = rich.detectedItems.reduce(
      (sum, d) => sum + (d.items?.reduce((s, item) =>
        s + (item.issues?.filter((i) => i.severity === "ERROR").length ?? 0), 0) ?? 0),
      0,
    );
    let richPart = `Rich results: ${types.join(", ")}`;
    if (errorCount > 0) richPart += ` (${errorCount} errors)`;
    if (rich.verdict && rich.verdict !== "PASS") richPart += ` [${rich.verdict}]`;
    parts.push(richPart);
  }

  const amp = r.ampResult;
  if (amp?.verdict) {
    let ampPart = `AMP: ${amp.verdict}`;
    const ampErrors = amp.issues?.filter((i) => i.severity === "ERROR").length ?? 0;
    if (ampErrors > 0) ampPart += ` (${ampErrors} errors)`;
    parts.push(ampPart);
  }

  return parts.join(". ") + ".";
}

export function registerInspectUrlTool(server: McpServer, client: GscApiClient, resolver: SiteResolver, completableSiteUrl: ZodTypeAny) {
  server.registerTool("inspect_url", {
    title: "Inspect URL",
    description: [
      "Inspect a URL's index status in Google Search Console.",
      "Returns index coverage, canonical info, crawl details, mobile usability, rich results, and AMP status.",
      "Shows the indexed version only — does not test live URL crawlability.",
      "Detects canonical mismatches (Google-selected vs page-declared canonical).",
      "Rate limit: ~600 requests/min per property, ~2000/min total.",
    ].join(" "),
    inputSchema: z.object({
      url: z.string().url().describe("The fully-qualified URL to inspect. Must belong to the specified site_url property."),
      site_url: completableSiteUrl,
      language_code: z
        .string()
        .describe("IETF BCP-47 language code for localized issue messages (e.g. 'de', 'en-US'). Defaults to 'en-US'.")
        .optional(),
    }),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ url, site_url, language_code }, { signal }) => {
    try {
      const { siteUrl, resolvedNote } = await resolveSiteUrl(resolver, site_url as string);

      const body: Record<string, unknown> = {
        inspectionUrl: url,
        siteUrl,
      };
      if (language_code) body.languageCode = language_code;

      const data = await client.postInspection<InspectUrlResponse>(
        "/urlInspection/index:inspect",
        body,
        signal,
      );

      const result = data.inspectionResult;
      const summary = buildInspectionSummary(result);

      return toolResult({
        ...(resolvedNote ? { _resolved: resolvedNote } : {}),
        _summary: summary,
        ...result,
      });
    } catch (e) {
      return toolError(e);
    }
  });
}
