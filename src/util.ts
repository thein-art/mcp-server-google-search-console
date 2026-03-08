import { z } from "zod";
import { DIMENSIONS, FILTER_OPERATORS } from "./types.js";

// --- Zod Schemas (derived from single source of truth in types.ts) ---

export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Date must be YYYY-MM-DD format");

export const siteUrlSchema = z
  .string()
  .min(1)
  .describe(
    "The site to query. Can be a bare domain (e.g. 'artaxo.com'), a full URL ('https://www.artaxo.com/'), or a GSC property ('sc-domain:artaxo.com'). The server auto-resolves to the best matching property.",
  );

export const dimensionsSchema = z
  .array(z.enum(DIMENSIONS))
  .describe("Dimensions to group results by");

export const filterOperatorSchema = z.enum(FILTER_OPERATORS);

export const dimensionFilterSchema = z.object({
  dimension: z.enum(DIMENSIONS),
  operator: filterOperatorSchema,
  expression: z.string(),
});

// --- Date Helpers (UTC-based to avoid timezone issues) ---

function utcDateString(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function today(): string {
  return utcDateString(new Date());
}

export function daysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return utcDateString(d);
}

export function validateDateRange(startDate: string, endDate: string): void {
  if (startDate > endDate) {
    throw new Error(`Invalid date range: start_date (${startDate}) is after end_date (${endDate}).`);
  }
}

// --- MCP Response Helpers ---

export function toolResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  };
}

export function toolError(e: unknown) {
  const message = e instanceof Error ? e.message : String(e);
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true,
  };
}

// --- Shared Metrics Helpers ---

export interface Metrics {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export function roundMetrics(r: Metrics): Metrics {
  return {
    clicks: r.clicks,
    impressions: r.impressions,
    ctr: Math.round(r.ctr * 10000) / 10000,
    position: Math.round(r.position * 10) / 10,
  };
}

export function formatNum(n: number): string {
  return n.toLocaleString("en-US");
}

export function pctChange(cur: number, prev: number): string {
  if (prev === 0) return cur === 0 ? "0%" : "+∞";
  const pct = ((cur - prev) / prev) * 100;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${Math.round(pct * 10) / 10}%`;
}

// --- URL Encoding ---

export function encodeSiteUrl(siteUrl: string): string {
  return encodeURIComponent(siteUrl);
}

// --- Site Resolution ---

import type { SiteResolver } from "./site-resolver.js";

/**
 * Resolve a user-provided site_url to the best matching GSC property.
 * Returns the resolved URL and an optional note for the response.
 */
export async function resolveSiteUrl(
  resolver: SiteResolver,
  input: string,
): Promise<{ siteUrl: string; resolvedNote?: string }> {
  const { siteUrl, resolved } = await resolver.resolve(input);
  const resolvedNote = resolved ? `Resolved "${input}" to "${siteUrl}"` : undefined;
  return { siteUrl, resolvedNote };
}
