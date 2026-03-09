import type { GscApiClient } from "./api-client.js";
import type { SiteList, Site } from "./types.js";

/**
 * Resolves user-provided site identifiers to exact GSC property URLs.
 * Caches the site list and provides fuzzy matching so tools don't require
 * the user (or LLM) to call list_sites first.
 *
 * Resolution priority:
 * 1. Exact match
 * 2. sc-domain: property for the given domain
 * 3. https:// root property
 * 4. http:// root property
 * 5. Best subdir match (longest prefix)
 */

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export class SiteResolver {
  private sites: Site[] = [];
  private loadedAt = 0;
  private pending: Promise<Site[]> | null = null;

  constructor(private client: GscApiClient) {}

  /** Load site list (cached, with TTL). */
  private async getSites(): Promise<Site[]> {
    const now = Date.now();
    if (this.sites.length > 0 && now - this.loadedAt < CACHE_TTL_MS) {
      return this.sites;
    }

    if (!this.pending) {
      this.pending = this.client
        .get<SiteList>("/sites")
        .then((data) => {
          this.sites = data.siteEntry ?? [];
          this.loadedAt = Date.now();
          return this.sites;
        })
        .finally(() => {
          this.pending = null;
        });
    }

    return this.pending;
  }

  /**
   * Resolve a user-provided site identifier to the best matching GSC property URL.
   * Accepts: "artaxo.com", "sc-domain:artaxo.com", "https://www.artaxo.com/",
   *          "www.artaxo.com", "artaxo.com/blog/", etc.
   */
  async resolve(input: string): Promise<{ siteUrl: string; resolved: boolean }> {
    const sites = await this.getSites();
    const urls = sites.map((s) => s.siteUrl);

    // 1. Exact match
    if (urls.includes(input)) {
      return { siteUrl: input, resolved: false };
    }

    // Normalize input to extract hostname and path
    const { hostname, pathname } = this.parseInput(input);
    if (!hostname) {
      // Can't parse — return as-is and let the API decide
      return { siteUrl: input, resolved: false };
    }

    // 2. sc-domain: match (covers everything)
    const domainMatch = urls.find(
      (u) => u === `sc-domain:${hostname}`,
    );
    if (domainMatch && pathname === "/") {
      return { siteUrl: domainMatch, resolved: true };
    }

    // 3. HTTPS root match
    const httpsRoot = urls.find(
      (u) =>
        u === `https://${hostname}/` ||
        u === `https://www.${hostname}/`,
    );

    // 4. HTTP root match
    const httpRoot = urls.find(
      (u) =>
        u === `http://${hostname}/` ||
        u === `http://www.${hostname}/`,
    );

    // 5. Subdir match — find the most specific (longest) property that covers the path
    const subdirCandidates = urls
      .filter((u) => {
        try {
          const parsed = new URL(u);
          const h = parsed.hostname.replace(/^www\./, "");
          return h === hostname && pathname.startsWith(parsed.pathname);
        } catch {
          return false;
        }
      })
      .sort((a, b) => b.length - a.length); // longest (most specific) first

    // If user asked for a specific path, prefer subdir match
    if (pathname !== "/") {
      if (subdirCandidates.length > 0) {
        return { siteUrl: subdirCandidates[0], resolved: true };
      }
      // Fall back to domain property (it covers subdirs too)
      if (domainMatch) {
        return { siteUrl: domainMatch, resolved: true };
      }
    }

    // For root-level queries, prefer domain > https > http
    if (domainMatch) return { siteUrl: domainMatch, resolved: true };
    if (httpsRoot) return { siteUrl: httpsRoot, resolved: true };
    if (httpRoot) return { siteUrl: httpRoot, resolved: true };
    if (subdirCandidates.length > 0) {
      return { siteUrl: subdirCandidates[0], resolved: true };
    }

    // No match — return as-is
    return { siteUrl: input, resolved: false };
  }

  private parseInput(input: string): { hostname: string; pathname: string } {
    // Handle sc-domain: prefix
    if (input.startsWith("sc-domain:")) {
      return { hostname: input.slice(10), pathname: "/" };
    }

    // Handle full URLs
    if (input.startsWith("http://") || input.startsWith("https://")) {
      try {
        const u = new URL(input);
        return {
          hostname: u.hostname.replace(/^www\./, ""),
          pathname: u.pathname || "/",
        };
      } catch {
        return { hostname: "", pathname: "/" };
      }
    }

    // Bare domain or domain/path (e.g., "artaxo.com" or "guenstiger.de/Kaufberatung/")
    const slashIdx = input.indexOf("/");
    if (slashIdx === -1) {
      return { hostname: input.replace(/^www\./, ""), pathname: "/" };
    }
    return {
      hostname: input.slice(0, slashIdx).replace(/^www\./, ""),
      pathname: input.slice(slashIdx),
    };
  }

  /** Return all site URLs (for completions and resource listing). */
  async listSiteUrls(): Promise<string[]> {
    const sites = await this.getSites();
    return sites.map((s) => s.siteUrl);
  }

  /** Invalidate the cache (for testing or after site changes). */
  invalidate(): void {
    this.sites = [];
    this.loadedAt = 0;
  }
}
