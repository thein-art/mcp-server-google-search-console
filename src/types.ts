// Google Search Console API types

// Authentication

export type TokenProvider = () => Promise<string>;

export interface ServiceAccountKey {
  type: string;
  project_id: string;
  private_key_id: string;
  private_key: string;
  client_email: string;
  client_id: string;
}

export interface OAuthClientConfig {
  installed: {
    client_id: string;
    client_secret: string;
    auth_uri: string;
    token_uri: string;
    redirect_uris: string[];
  };
}

export interface OAuthTokenData {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix epoch seconds
  scope: string;
}

// Sites / Properties

export type PermissionLevel =
  | "siteFullUser"
  | "siteOwner"
  | "siteRestrictedUser"
  | "siteUnverifiedUser";

export interface Site {
  siteUrl: string;
  permissionLevel: PermissionLevel;
}

export interface SiteList {
  siteEntry?: Site[];
}

// Search Analytics

export const DIMENSIONS = ["date", "query", "page", "country", "device", "searchAppearance", "hour"] as const;
export type Dimension = (typeof DIMENSIONS)[number];

export type SearchType = "web" | "image" | "video" | "news" | "googleNews" | "discover";

export type AggregationType = "auto" | "byPage" | "byProperty";

export const FILTER_OPERATORS = [
  "equals",
  "notEquals",
  "contains",
  "notContains",
  "includingRegex",
  "excludingRegex",
] as const;
export type DimensionFilterOperator = (typeof FILTER_OPERATORS)[number];

export interface DimensionFilterGroup {
  groupType?: "and";
  filters: DimensionFilter[];
}

export interface DimensionFilter {
  dimension: Dimension;
  operator: DimensionFilterOperator;
  expression: string;
}

export interface SearchAnalyticsRow {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface SearchAnalyticsMetadata {
  first_incomplete_date?: string;
  first_incomplete_hour?: string;
}

export interface SearchAnalyticsResponse {
  rows?: SearchAnalyticsRow[];
  responseAggregationType?: AggregationType;
  metadata?: SearchAnalyticsMetadata;
}

// URL Inspection

export type Verdict = "VERDICT_UNSPECIFIED" | "PASS" | "PARTIAL" | "FAIL" | "NEUTRAL";
export type RobotsTxtState = "ROBOTS_TXT_STATE_UNSPECIFIED" | "ALLOWED" | "DISALLOWED";
export type IndexingState = "INDEXING_STATE_UNSPECIFIED" | "INDEXING_ALLOWED" | "BLOCKED_BY_META_TAG" | "BLOCKED_BY_HTTP_HEADER" | "BLOCKED_BY_ROBOTS_TXT";
export type PageFetchState = "PAGE_FETCH_STATE_UNSPECIFIED" | "SUCCESSFUL" | "SOFT_404" | "BLOCKED_ROBOTS_TXT" | "NOT_FOUND" | "ACCESS_DENIED" | "SERVER_ERROR" | "REDIRECT_ERROR" | "ACCESS_FORBIDDEN" | "BLOCKED_4XX" | "INTERNAL_CRAWL_ERROR" | "INVALID_URL";
export type CrawlingUserAgent = "CRAWLING_USER_AGENT_UNSPECIFIED" | "DESKTOP" | "MOBILE";
export type IssueSeverity = "SEVERITY_UNSPECIFIED" | "WARNING" | "ERROR";

export interface IndexStatusResult {
  verdict?: Verdict;
  coverageState?: string;
  robotsTxtState?: RobotsTxtState;
  indexingState?: IndexingState;
  lastCrawlTime?: string;
  pageFetchState?: PageFetchState;
  googleCanonical?: string;
  userCanonical?: string;
  referringUrls?: string[];
  sitemap?: string[];
  crawledAs?: CrawlingUserAgent;
}

export interface MobileUsabilityResult {
  verdict?: Verdict;
  issues?: Array<{
    issueType?: string;
    severity?: IssueSeverity;
    message?: string;
  }>;
}

export interface AmpResult {
  verdict?: Verdict;
  ampUrl?: string;
  robotsTxtState?: RobotsTxtState;
  indexingState?: string;
  ampIndexStatusVerdict?: Verdict;
  lastCrawlTime?: string;
  pageFetchState?: PageFetchState;
  issues?: Array<{
    issueMessage?: string;
    severity?: IssueSeverity;
  }>;
}

export interface RichResultsResult {
  verdict?: Verdict;
  detectedItems?: Array<{
    richResultType?: string;
    items?: Array<{
      name?: string;
      issues?: Array<{
        issueMessage?: string;
        severity?: IssueSeverity;
      }>;
    }>;
  }>;
}

export interface InspectionResult {
  inspectionResultLink?: string;
  indexStatusResult?: IndexStatusResult;
  mobileUsabilityResult?: MobileUsabilityResult;
  ampResult?: AmpResult;
  richResultsResult?: RichResultsResult;
}

export interface InspectUrlResponse {
  inspectionResult: InspectionResult;
}

// Sitemaps

export type SitemapType =
  | "atomFeed"
  | "sitemap"
  | "rssFeed"
  | "urlList"
  | "notSitemap";

export interface WmxSitemap {
  path: string;
  lastSubmitted?: string;
  isPending: boolean;
  isSitemapsIndex: boolean;
  type: SitemapType;
  lastDownloaded?: string;
  warnings: string;
  errors: string;
  contents?: Array<{
    type: string;
    submitted: string;
    indexed?: string;
  }>;
}

export interface SitemapList {
  sitemap?: WmxSitemap[];
}
