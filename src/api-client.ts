import type { TokenProvider } from "./types.js";

const WEBMASTERS_BASE = "https://www.googleapis.com/webmasters/v3";
const SEARCHCONSOLE_BASE = "https://searchconsole.googleapis.com/v1";
const TIMEOUT_MS = 30_000;

export class GscApiClient {
  constructor(private getToken: TokenProvider) {}

  /** GET request to webmasters/v3 API */
  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", `${WEBMASTERS_BASE}${path}`);
  }

  /** POST request to webmasters/v3 API */
  async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", `${WEBMASTERS_BASE}${path}`, body);
  }

  /** PUT request to webmasters/v3 API (returns void) */
  async put(path: string): Promise<void> {
    await this.requestVoid("PUT", `${WEBMASTERS_BASE}${path}`);
  }

  /** DELETE request to webmasters/v3 API (returns void) */
  async delete(path: string): Promise<void> {
    await this.requestVoid("DELETE", `${WEBMASTERS_BASE}${path}`);
  }

  /** POST request to searchconsole/v1 API (URL Inspection) */
  async postInspection<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>("POST", `${SEARCHCONSOLE_BASE}${path}`, body);
  }

  /** Request that expects a JSON response body. Throws if body is empty. */
  private async request<T>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(method, url, body);
    const text = await res.text();

    const trimmed = text.trim();
    if (!trimmed) {
      throw new Error(`GSC API returned empty response for ${method} ${url}`);
    }

    return JSON.parse(trimmed) as T;
  }

  /** Request that expects no response body (PUT/DELETE). */
  private async requestVoid(method: string, url: string): Promise<void> {
    const res = await this.doFetch(method, url);
    // Consume body to free resources
    await res.text();
  }

  private async doFetch(method: string, url: string, body?: unknown): Promise<Response> {
    const token = await this.getToken();

    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    };

    const init: RequestInit = {
      method,
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    };

    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(body);
    }

    const res = await fetch(url, init);

    if (!res.ok) {
      await this.handleError(res, method, url);
    }

    return res;
  }

  private async handleError(res: Response, method: string, url: string): Promise<never> {
    let msg: string;
    try {
      const err = (await res.json()) as { error?: { message?: string } };
      msg = err.error?.message ?? JSON.stringify(err);
    } catch {
      msg = await res.text();
    }

    if (res.status === 403) {
      throw new Error(
        `GSC API access denied (403). Check that your account has sufficient permissions for this property. Unverified sites cannot be queried.`,
      );
    }

    if (res.status === 401) {
      throw new Error(
        `GSC API authentication failed (401). Your credentials may have expired or been revoked.`,
      );
    }

    if (res.status === 429) {
      const retryAfter = res.headers.get("Retry-After");
      const hint = retryAfter ? ` Retry after ${retryAfter}s.` : " Try again later.";
      throw new Error(`GSC API rate limit exceeded (429).${hint}`);
    }

    throw new Error(`GSC API error (${res.status} ${method} ${url}): ${msg.slice(0, 500)}`);
  }
}
