import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { OAuthClientConfig } from "../src/types.js";

// Mock fs at module level (hoisted by vitest)
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  writeFile: vi.fn().mockResolvedValue(undefined),
  mkdir: vi.fn().mockResolvedValue(undefined),
  chmod: vi.fn().mockResolvedValue(undefined),
}));

import { readFile, writeFile, mkdir } from "node:fs/promises";
import {
  loadServiceAccountKey,
  getScopes,
  hasWriteScope,
  getSaAccessToken,
  resetTokenCache,
  loadOAuthConfig,
  loadSavedToken,
  refreshOAuthToken,
  getOAuthTokenPath,
  createTokenProvider,
  createOAuthTokenProvider,
} from "../src/auth.js";

const mockedReadFile = vi.mocked(readFile);

const FAKE_KEY = {
  type: "service_account",
  project_id: "test-project",
  private_key_id: "key123",
  private_key: `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDWO0oy02nTpcFu
qm+PB3ScROo905xm+bPSzVDFRmLdB4fGFyKzCYZ+rVSW59axyIW0h5Mw1OMhsLBQ
5SvldxXOO0IP/Gp+C8Jqxd3fhhyq0jEovBq7ngZg6jI9He6CBfXQ4JQhMXX8N7nj
5MCKUJQdFABAy75yXfYJxdRmixq31mPhv09/hGxQTczEqCJqi9vr3E9jjuExuHyI
9ZGgLt74s1PMGugaCuU9VXd33cjfTDN3YuJlOW8w5ykQ410gtn/Phyy4Uo5kJPZ2
EEhibVILtobu9BycTQf9w2GqSdHL3WaqSIxk+W2pZsVEEBH5c2W2L8vmaB0H2uWo
d1fAqaGjAgMBAAECggEAQprRYUbwfoBoyLbNk1reit00NH+vfyaAHXh+9a6B+zUl
pdU4kRBTk9vg0kAHNGPjCfMitIpjiWxtDOGLSb7B9UngKqcwFrsiOV8GMcH49LT/
2qnM5+rkEcqOTwkYx60BtWy1MTK2+3D55twObpJJ0laPE5YkwlrrLTOn6y+xYVkA
xrPRZ2ZxEjlZE9DsEFVrOThWF6skyHykXL4ShJqw18O4X1STbp2q35yesDYJEXK+
3m82VjeBfo6vvPLq7Wrh9zTQu5+B48oJx/3mj4NjDZCTHn7yd5aBmV+kHcWR3cpD
JqBlb0T2aUuz1GRkbrJCLamuNV/dgglSxzCW/vkuvQKBgQD9cOlWFEPq20KgR6aZ
StxQJa5t0CtKALuL7OHwfrJwvjtVkmlVuArTPv0+Cwjvyewd0JzPiz9H7xNPiXOX
9Svp2QpHnuSzH2D9Cfe4wiDBGCheRTJLv2NI/3A2zXcQZ+quK/26yHvK+BFoT6TF
G4L34dx7QuJ4B6rB9AKxq63IXwKBgQDYZQfaO2qDn1d8ASYmIlyykgMljcUYT6IC
UF9Zm35Vr1oR5m6ToWqWxHyrRUh40uNum/+9T0PdRCy8sVYAtQn/+K1BQ53LcllZ
Hczn1WVKow/OOcwoFr1eBnHOHY0cYAucZSUE1uCh1C23KfO3n4F24gDVTwvcstuq
wZ/fjKX9PQKBgGE+Q6mNmQmyG3xYQaoruSDfdHAaIaIBafSkbYTTeDAeLbIFvXjw
ZubrEkwN+93Vwk0mUCSqLxuwtd4cxUeXAMR3TKRyaRn5fkNY4b34bozocgTJ1CSQ
SM4nhKziZT7cQIWXx4E1j5ovWK6HcJdYmQX3mZuJ7E9V0cUdlTMKxmFNAoGARSoN
l3gUNFuyp6TqX5fuDvlSXidxDrMtMhYkU8y6VYLFhCElyLP4EJZezpNHda7aGJlt
5UE3jLpkni8EMResSY9fORP2lHdJDY3T12nChVeXDrA0i7+w6SOgLmQNnTspmuRN
L73KcI8TyY50IoWt6KSV5ZftT64vPeXDRr16tHUCgYAkGfoqRH+JZOvxbUnZ1b4o
g1uP4ydwNl53opTsJ077TBT/K5413ziSAdDq8GmsvuNNl+h7Twl6sAtbvFH/8th9
tWFwarIyDnulz3TLc1Gqgpj0sLMJ1vBQ+jiP7B7iUa+UWIRPs4CTew8/pMgCKgr/
TCCROnFgmWuMLlzz1jIklw==
-----END PRIVATE KEY-----`,
  client_email: "test@test-project.iam.gserviceaccount.com",
  client_id: "123456789",
};

const FAKE_OAUTH_CONFIG: OAuthClientConfig = {
  installed: {
    client_id: "390318056688-tqtfaoro9i0tntutrei8dpc84ug4tc58.apps.googleusercontent.com",
    client_secret: "GOCSPX-fake-secret",
    auth_uri: "https://accounts.google.com/o/oauth2/v2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    redirect_uris: ["http://localhost:3847"],
  },
};

describe("auth", () => {
  beforeEach(() => {
    resetTokenCache();
    vi.unstubAllEnvs();
    vi.mocked(readFile).mockReset();
    vi.mocked(writeFile).mockReset().mockResolvedValue(undefined);
    vi.mocked(mkdir).mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  describe("loadServiceAccountKey", () => {
    it("loads key from inline env var", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify(FAKE_KEY));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");
      const key = await loadServiceAccountKey();
      expect(key.client_email).toBe("test@test-project.iam.gserviceaccount.com");
      expect(key.project_id).toBe("test-project");
    });

    it("loads key from file", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", "");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "/fake/sa-key.json");
      mockedReadFile.mockResolvedValue(JSON.stringify(FAKE_KEY));

      const key = await loadServiceAccountKey();
      expect(key.client_email).toBe("test@test-project.iam.gserviceaccount.com");
      expect(mockedReadFile).toHaveBeenCalledWith("/fake/sa-key.json", "utf-8");
    });

    it("throws when no credentials are set", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", "");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");
      await expect(loadServiceAccountKey()).rejects.toThrow("Missing service account credentials");
    });

    it("throws on invalid key missing required fields", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify({ type: "service_account" }));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");
      await expect(loadServiceAccountKey()).rejects.toThrow('missing or has invalid field: "private_key"');
    });

    it("throws on invalid private_key format", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify({
        ...FAKE_KEY,
        private_key: "not-a-pem-key",
      }));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");
      await expect(loadServiceAccountKey()).rejects.toThrow("invalid private_key format");
    });
  });

  describe("loadServiceAccountKey — env var cleanup (S3)", () => {
    it("deletes GSC_SERVICE_ACCOUNT_KEY from env after parsing", async () => {
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify(FAKE_KEY));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");

      // Before loading, env var exists
      expect(process.env["GSC_SERVICE_ACCOUNT_KEY"]).toBeTruthy();

      await loadServiceAccountKey();

      // After loading, env var is deleted
      expect(process.env["GSC_SERVICE_ACCOUNT_KEY"]).toBeUndefined();
    });
  });

  describe("createJwt — error handling (S1)", () => {
    it("wraps crypto errors with safe message (no key material leaked)", async () => {
      const badKey = {
        ...FAKE_KEY,
        private_key: "-----BEGIN PRIVATE KEY-----\nINVALID_KEY_DATA\n-----END PRIVATE KEY-----",
      };

      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify(badKey));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");
      vi.stubEnv("GSC_SCOPES", "");

      // getSaAccessToken calls createJwt internally
      const mockFetch = vi.fn(); // won't be reached
      vi.stubGlobal("fetch", mockFetch);

      try {
        await getSaAccessToken(badKey);
      } catch (e) {
        const msg = (e as Error).message;
        expect(msg).toBe("Failed to create JWT. Check service account key format.");
        expect(msg).not.toContain("INVALID_KEY_DATA");
      }
    });
  });

  describe("getScopes", () => {
    it("returns readonly scope by default", () => {
      vi.stubEnv("GSC_SCOPES", "");
      expect(getScopes()).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    });

    it("returns custom scope when set", () => {
      vi.stubEnv("GSC_SCOPES", "https://www.googleapis.com/auth/webmasters");
      expect(getScopes()).toBe("https://www.googleapis.com/auth/webmasters");
    });
  });

  describe("hasWriteScope", () => {
    it("returns false for readonly scope", () => {
      vi.stubEnv("GSC_SCOPES", "");
      expect(hasWriteScope()).toBe(false);
    });

    it("returns true for write scope", () => {
      vi.stubEnv("GSC_SCOPES", "https://www.googleapis.com/auth/webmasters");
      expect(hasWriteScope()).toBe(true);
    });

    it("returns false for partial match (webmasters_extended)", () => {
      vi.stubEnv("GSC_SCOPES", "https://www.googleapis.com/auth/webmasters_extended");
      expect(hasWriteScope()).toBe(false);
    });
  });

  describe("getSaAccessToken", () => {
    it("exchanges JWT for access token and caches", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ access_token: "ya29.test-token", expires_in: 3600 }),
      });
      vi.stubGlobal("fetch", mockFetch);
      vi.stubEnv("GSC_SCOPES", "");

      const token = await getSaAccessToken(FAKE_KEY);
      expect(token).toBe("ya29.test-token");
      expect(mockFetch).toHaveBeenCalledOnce();

      // Second call should use cache
      const token2 = await getSaAccessToken(FAKE_KEY);
      expect(token2).toBe("ya29.test-token");
      expect(mockFetch).toHaveBeenCalledOnce();
    });

    it("coalesces concurrent refresh requests", async () => {
      let resolveToken: (value: Response) => void;
      const mockFetch = vi.fn().mockReturnValue(
        new Promise<Response>((resolve) => { resolveToken = resolve; }),
      );
      vi.stubGlobal("fetch", mockFetch);
      vi.stubEnv("GSC_SCOPES", "");

      const p1 = getSaAccessToken(FAKE_KEY);
      const p2 = getSaAccessToken(FAKE_KEY);

      expect(mockFetch).toHaveBeenCalledOnce();

      resolveToken!({
        ok: true,
        json: async () => ({ access_token: "ya29.coalesced", expires_in: 3600 }),
      } as unknown as Response);

      const [t1, t2] = await Promise.all([p1, p2]);
      expect(t1).toBe("ya29.coalesced");
      expect(t2).toBe("ya29.coalesced");
    });

    it("throws on token exchange failure", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => '{"error": "invalid_grant"}',
      });
      vi.stubGlobal("fetch", mockFetch);
      vi.stubEnv("GSC_SCOPES", "");

      await expect(getSaAccessToken(FAKE_KEY)).rejects.toThrow("Token exchange failed (400)");
    });

    it("throws when access_token is missing from response", async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ token_type: "Bearer" }),
      });
      vi.stubGlobal("fetch", mockFetch);
      vi.stubEnv("GSC_SCOPES", "");

      await expect(getSaAccessToken(FAKE_KEY)).rejects.toThrow("missing access_token");
    });
  });

  describe("OAuth", () => {
    describe("getOAuthTokenPath", () => {
      it("returns default path when no override", () => {
        vi.stubEnv("GSC_OAUTH_TOKEN_FILE", "");
        const path = getOAuthTokenPath();
        expect(path).toContain(".config/gsc-mcp/oauth-token.json");
      });

      it("returns override path when set", () => {
        vi.stubEnv("GSC_OAUTH_TOKEN_FILE", "/tmp/my-token.json");
        expect(getOAuthTokenPath()).toBe("/tmp/my-token.json");
      });
    });

    describe("loadOAuthConfig", () => {
      it("loads valid OAuth config", async () => {
        mockedReadFile.mockResolvedValue(JSON.stringify(FAKE_OAUTH_CONFIG));
        const config = await loadOAuthConfig("/fake/client_secret.json");
        expect(config.installed.client_id).toBe(FAKE_OAUTH_CONFIG.installed.client_id);
      });

      it("throws on invalid config", async () => {
        mockedReadFile.mockResolvedValue(JSON.stringify({ web: {} }));
        await expect(loadOAuthConfig("/fake/bad.json")).rejects.toThrow("invalid");
      });
    });

    describe("loadSavedToken", () => {
      it("returns token data when file exists", async () => {
        vi.stubEnv("GSC_OAUTH_TOKEN_FILE", "/fake/token.json");
        mockedReadFile.mockResolvedValue(JSON.stringify({
          access_token: "ya29.test",
          refresh_token: "1//refresh",
          expires_at: 9999999999,
          scope: "test",
        }));

        const token = await loadSavedToken();
        expect(token?.refresh_token).toBe("1//refresh");
      });

      it("returns null when file does not exist", async () => {
        vi.stubEnv("GSC_OAUTH_TOKEN_FILE", "/fake/missing.json");
        mockedReadFile.mockRejectedValue(new Error("ENOENT"));

        const token = await loadSavedToken();
        expect(token).toBeNull();
      });
    });

    describe("refreshOAuthToken", () => {
      it("refreshes token and returns new token data", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: "ya29.new-token",
            expires_in: 3600,
            scope: "https://www.googleapis.com/auth/webmasters.readonly",
          }),
        });
        vi.stubGlobal("fetch", mockFetch);

        const result = await refreshOAuthToken(FAKE_OAUTH_CONFIG, "1//old-refresh-token");

        expect(result.access_token).toBe("ya29.new-token");
        expect(result.refresh_token).toBe("1//old-refresh-token"); // preserved when not returned
        expect(result.expires_at).toBeGreaterThan(Math.floor(Date.now() / 1000));

        const [url, init] = mockFetch.mock.calls[0];
        expect(url).toBe("https://oauth2.googleapis.com/token");
        expect(init.method).toBe("POST");
      });

      it("throws on refresh failure", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          text: async () => '{"error": "invalid_grant"}',
        });
        vi.stubGlobal("fetch", mockFetch);

        await expect(
          refreshOAuthToken(FAKE_OAUTH_CONFIG, "1//bad-token"),
        ).rejects.toThrow("OAuth token refresh failed (401)");
      });
    });

    describe("createOAuthTokenProvider", () => {
      it("refreshes then caches token in memory", async () => {
        const mockFetch = vi.fn().mockResolvedValue({
          ok: true,
          json: async () => ({
            access_token: "ya29.refreshed",
            expires_in: 3600,
          }),
        });
        vi.stubGlobal("fetch", mockFetch);

        // loadSavedToken reads from disk — mock it to return expired token with refresh_token
        mockedReadFile.mockResolvedValue(JSON.stringify({
          access_token: "ya29.old",
          refresh_token: "1//refresh",
          expires_at: 0, // expired
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
        }));

        const provider = createOAuthTokenProvider(FAKE_OAUTH_CONFIG);
        const token1 = await provider();
        expect(token1).toBe("ya29.refreshed");
        expect(mockFetch).toHaveBeenCalledOnce();

        // Second call should use in-memory cache
        const token2 = await provider();
        expect(token2).toBe("ya29.refreshed");
        expect(mockFetch).toHaveBeenCalledOnce();
      });
    });
  });

  describe("createTokenProvider", () => {
    it("prefers OAuth when GSC_OAUTH_CLIENT_FILE is set", async () => {
      vi.stubEnv("GSC_OAUTH_CLIENT_FILE", "/fake/client_secret.json");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify(FAKE_KEY));

      const futureExpiry = Math.floor(Date.now() / 1000) + 7200;
      mockedReadFile.mockImplementation((path: unknown) => {
        if (String(path) === "/fake/client_secret.json") {
          return Promise.resolve(JSON.stringify(FAKE_OAUTH_CONFIG)) as never;
        }
        // Token file
        return Promise.resolve(JSON.stringify({
          access_token: "ya29.oauth",
          refresh_token: "1//refresh",
          expires_at: futureExpiry,
          scope: "https://www.googleapis.com/auth/webmasters.readonly",
        })) as never;
      });

      const { provider, label } = await createTokenProvider();
      expect(label).toContain("OAuth");
      expect(typeof provider).toBe("function");
    });

    it("falls back to SA when no OAuth config", async () => {
      vi.stubEnv("GSC_OAUTH_CLIENT_FILE", "");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", JSON.stringify(FAKE_KEY));
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");

      const { provider, label } = await createTokenProvider();
      expect(label).toContain("Service Account");
      expect(typeof provider).toBe("function");
    });

    it("throws when no credentials at all", async () => {
      vi.stubEnv("GSC_OAUTH_CLIENT_FILE", "");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY", "");
      vi.stubEnv("GSC_SERVICE_ACCOUNT_KEY_FILE", "");

      await expect(createTokenProvider()).rejects.toThrow("No credentials configured");
    });
  });
});
