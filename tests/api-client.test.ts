import { describe, it, expect, vi, beforeEach } from "vitest";
import { GscApiClient } from "../src/api-client.js";

const mockTokenProvider = async () => "ya29.mock-token";

describe("GscApiClient", () => {
  let client: InstanceType<typeof GscApiClient>;

  beforeEach(() => {
    client = new GscApiClient(mockTokenProvider);
  });

  it("GET request sends auth header and parses JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ siteEntry: [{ siteUrl: "https://example.com/" }] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.get<{ siteEntry: unknown[] }>("/sites");

    expect(result.siteEntry).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledOnce();

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toBe("https://www.googleapis.com/webmasters/v3/sites");
    expect(init.method).toBe("GET");
    expect(init.headers.Authorization).toBe("Bearer ya29.mock-token");

    vi.unstubAllGlobals();
  });

  it("POST request sends body as JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ rows: [] }),
    });
    vi.stubGlobal("fetch", mockFetch);

    const body = { startDate: "2024-01-01", endDate: "2024-01-31" };
    await client.post("/sites/https%3A%2F%2Fexample.com%2F/searchAnalytics/query", body);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/searchAnalytics/query");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(body));

    vi.unstubAllGlobals();
  });

  it("throws on API error with message and method/url context", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Forbidden" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow("GSC API access denied (403)");

    vi.unstubAllGlobals();
  });

  it("throws specific message on 429 rate limit", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "Retry-After": "30" }),
      text: async () => JSON.stringify({ error: { message: "Rate limit exceeded" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow("rate limit exceeded (429). Retry after 30s.");

    vi.unstubAllGlobals();
  });

  it("PUT request handles empty response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.put("/sites/x/sitemaps/y")).resolves.toBeUndefined();

    vi.unstubAllGlobals();
  });

  it("throws on empty response for GET request", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow("empty response");

    vi.unstubAllGlobals();
  });

  it("throws on whitespace-only response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "   \n  ",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow("empty response");

    vi.unstubAllGlobals();
  });

  it("trims whitespace before parsing JSON", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => '  {"siteEntry": []}  \n',
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await client.get<{ siteEntry: unknown[] }>("/sites");
    expect(result.siteEntry).toEqual([]);

    vi.unstubAllGlobals();
  });

  it("throws on 5xx server error with context", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Internal Server Error" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow("GSC API error (500");

    vi.unstubAllGlobals();
  });

  it("handles network errors (fetch rejection)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));

    await expect(client.get("/sites")).rejects.toThrow("ECONNREFUSED");

    vi.unstubAllGlobals();
  });

  it("throws on malformed JSON response", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => "not valid json {",
    });
    vi.stubGlobal("fetch", mockFetch);

    await expect(client.get("/sites")).rejects.toThrow();

    vi.unstubAllGlobals();
  });

  it("403 error does not include raw API message", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "User sa@project.iam.gserviceaccount.com does not have access" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await client.get("/sites");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("GSC API access denied (403)");
      expect(msg).not.toContain("sa@project");
      expect(msg).not.toContain("gserviceaccount");
    }

    vi.unstubAllGlobals();
  });

  it("401 error returns sanitized message", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers(),
      text: async () => JSON.stringify({ error: { message: "Invalid token for sa@project.iam" } }),
    });
    vi.stubGlobal("fetch", mockFetch);

    try {
      await client.get("/sites");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toContain("authentication failed (401)");
      expect(msg).not.toContain("sa@project");
    }

    vi.unstubAllGlobals();
  });

  it("postInspection uses searchconsole base URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ inspectionResult: {} }),
    });
    vi.stubGlobal("fetch", mockFetch);

    await client.postInspection("/urlInspection/index:inspect", { inspectionUrl: "https://example.com" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");

    vi.unstubAllGlobals();
  });
});
