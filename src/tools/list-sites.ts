import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GscApiClient } from "../api-client.js";
import type { SiteList, PermissionLevel } from "../types.js";
import { toolResult, toolError } from "../util.js";

const PERMISSION_SHORT: Record<PermissionLevel, string> = {
  siteOwner: "owner",
  siteFullUser: "full",
  siteRestrictedUser: "restricted",
  siteUnverifiedUser: "unverified",
};

/** Extract the effective root domain from any site URL for grouping. */
function getRootDomain(siteUrl: string): string {
  if (siteUrl.startsWith("sc-domain:")) return siteUrl.slice(10);
  try {
    return new URL(siteUrl).hostname.replace(/^www\./, "");
  } catch {
    return siteUrl;
  }
}

interface CompactSite {
  url: string;
  permission: string;
  type: "domain" | "https" | "http" | "subdir";
  note?: string;
}

function classifySite(siteUrl: string): CompactSite["type"] {
  if (siteUrl.startsWith("sc-domain:")) return "domain";
  try {
    const u = new URL(siteUrl);
    if (u.pathname !== "/") return "subdir";
    return u.protocol === "https:" ? "https" : "http";
  } catch {
    return "https";
  }
}

/**
 * Pick the best default property from a group:
 * 1. Domain property (sc-domain:) — covers everything
 * 2. HTTPS root — most common modern setup
 * 3. HTTP root — legacy fallback
 * Subdir properties are never the default — they exist for scoped analysis.
 */
function pickDefault(sites: CompactSite[]): CompactSite | null {
  return (
    sites.find((s) => s.type === "domain" && s.permission !== "unverified") ??
    sites.find((s) => s.type === "https" && s.permission !== "unverified") ??
    sites.find((s) => s.type === "http" && s.permission !== "unverified") ??
    null
  );
}

export function registerListSitesTool(server: McpServer, client: GscApiClient) {
  server.registerTool("list_sites", {
    title: "List Sites",
    description: [
      "List all Google Search Console properties grouped by root domain.",
      "Each group shows a recommended default property (domain > https > http).",
      "Subdir properties exist for scoped analysis (e.g. per-language URL inspection quotas) — use them when the user asks about a specific section.",
      "Properties with 'unverified' permission return 403 on API calls.",
    ].join(" "),
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  }, async ({ signal }) => {
    try {
      const data = await client.get<SiteList>("/sites", signal);
      const sites = data.siteEntry ?? [];

      // Build compact entries with classification
      const all: CompactSite[] = sites.map((s) => ({
        url: s.siteUrl,
        permission: PERMISSION_SHORT[s.permissionLevel] ?? s.permissionLevel,
        type: classifySite(s.siteUrl),
      }));

      // Group by root domain
      const groups = new Map<string, CompactSite[]>();
      for (const s of all) {
        const root = getRootDomain(s.url);
        let group = groups.get(root);
        if (!group) {
          group = [];
          groups.set(root, group);
        }
        group.push(s);
      }

      // Build output: single-property domains stay flat, multi-property domains get grouped
      type SingleEntry = { url: string; permission: string; note?: string };
      type GroupEntry = { domain: string; default: string; properties: CompactSite[] };
      const output: Array<SingleEntry | GroupEntry> = [];

      for (const [domain, props] of groups) {
        if (props.length === 1) {
          const s = props[0];
          const entry: SingleEntry = { url: s.url, permission: s.permission };
          if (s.permission === "unverified") entry.note = "no API access";
          output.push(entry);
        } else {
          // Mark unverified
          for (const s of props) {
            if (s.permission === "unverified") s.note = "no API access";
          }

          const best = pickDefault(props);
          output.push({
            domain,
            default: best?.url ?? props[0].url,
            properties: props,
          });
        }
      }

      // Sort: groups and usable sites first, lone unverified last
      output.sort((a, b) => {
        const aUnv = "permission" in a && a.permission === "unverified" ? 1 : 0;
        const bUnv = "permission" in b && b.permission === "unverified" ? 1 : 0;
        return aUnv - bUnv;
      });

      return toolResult({ total: sites.length, sites: output });
    } catch (e) {
      return toolError(e);
    }
  });
}
