# mcp-server-google-search-console

[![Node.js >= 22](https://img.shields.io/badge/node-%3E%3D22-brightgreen?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP compatible](https://img.shields.io/badge/MCP-compatible-0098FF?style=flat-square)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue?style=flat-square)](LICENSE)
[![npm version](https://img.shields.io/npm/v/mcp-server-google-search-console?style=flat-square)](https://www.npmjs.com/package/mcp-server-google-search-console)

Community-built MCP server for the Google Search Console API. Provides search analytics, performance summaries, URL inspection, sitemap management, and property listing through the [Model Context Protocol](https://modelcontextprotocol.io/).

## Features

- **9 tools** covering search analytics, performance summaries, URL inspection, sitemap management, and property listing
- **3 prompts** for guided multi-step SEO workflows
- **2 resources** for automatic property and sitemap discovery
- **Service Account & OAuth** — choose headless or interactive authentication
- **Read-only by default** — write tools are only registered when write scope is configured
- **Safety gates** — `delete_sitemap` requires explicit `confirm: true`
- **Minimal dependencies** — only `@modelcontextprotocol/sdk` and `zod`

## Quick Start

### 1. Set Up Credentials

**Service Account (recommended for servers & CI):**

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Create or select a project
3. Enable the **Google Search Console API**
4. Create a **Service Account** and download the JSON key file
5. In [Google Search Console](https://search.google.com/search-console), add the service account email as a user to your properties

**OAuth (recommended for personal use):**

1. In Google Cloud Console, create **OAuth 2.0 Client ID** (type: Desktop app)
2. Download the client credentials JSON
3. Set `GSC_OAUTH_CLIENT_FILE` — the server will open a browser for consent on first run
4. Tokens are cached at `~/.config/gsc-mcp/oauth-token.json` (or `GSC_OAUTH_TOKEN_FILE`)

### 2. Configure Your Client

<details open>
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add google-search-console \
  -e GSC_SERVICE_ACCOUNT_KEY_FILE=/path/to/service-account-key.json \
  -- npx -y mcp-server-google-search-console
```

Or add to `.mcp.json` manually:

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "mcp-server-google-search-console"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account-key.json"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Claude Desktop</strong></summary>

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "mcp-server-google-search-console"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account-key.json"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "mcp-server-google-search-console"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account-key.json"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code / Copilot</strong></summary>

Add to `.vscode/mcp.json`:

```json
{
  "servers": {
    "google-search-console": {
      "command": "npx",
      "args": ["-y", "mcp-server-google-search-console"],
      "env": {
        "GSC_SERVICE_ACCOUNT_KEY_FILE": "/path/to/service-account-key.json"
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Docker</strong></summary>

```bash
docker build -t gsc-mcp .
```

```json
{
  "mcpServers": {
    "google-search-console": {
      "command": "docker",
      "args": [
        "run", "--rm", "-i",
        "-e", "GSC_SERVICE_ACCOUNT_KEY_FILE=/key.json",
        "-v", "/path/to/service-account-key.json:/key.json:ro",
        "gsc-mcp"
      ]
    }
  }
}
```
</details>

## Tools

### Always available (read-only scope)

| Tool | Description |
|------|-------------|
| `list_sites` | List all GSC properties accessible by the current credentials |
| `get_site` | Get details for a specific property (permission level, verification) |
| `get_search_analytics` | Query search performance data with dimensions, filters, date ranges, and comparison mode |
| `get_performance_summary` | Quick performance overview: current vs previous period metrics, deltas, and top 10 queries in a single call |
| `inspect_url` | Check a URL's indexing status, mobile usability, and rich results |
| `batch_inspect_urls` | Inspect multiple URLs concurrently (up to 20) with a single call |
| `list_sitemaps` | List all sitemaps for a property with aggregated health summary |

### Write scope required

These tools are only registered when `GSC_SCOPES` includes the full write scope. They do not appear in the tool list otherwise.

| Tool | Description |
|------|-------------|
| `submit_sitemap` | Submit a sitemap to Google |
| `delete_sitemap` | Delete a sitemap (requires `confirm: true` safety gate) |

## Prompts

Guided multi-step SEO workflows that guide LLMs through structured analysis.

| Prompt | Parameters | Description |
|--------|------------|-------------|
| `seo_performance_analysis` | `site_url`, `period` (7d/28d/90d) | 5-step analysis: Top Queries → Top Pages → Device Split → Country Split → Trends. Produces a structured report with actionable insights. |
| `index_coverage_check` | `site_url`, `urls` (comma-separated) | Batch URL inspection with structured coverage report — flags indexing issues, canonical mismatches, and mobile problems. |
| `content_opportunity_analysis` | `site_url` | Full-funnel analysis: Low-Hanging Fruit (positions 5–20), Keyword Cannibalization detection, and Trending queries via comparison mode. |

## Resources

| URI | Description |
|-----|-------------|
| `sites://list` | Auto-discovery of all GSC properties accessible with current credentials. Enables LLMs to discover available sites without calling `list_sites` first. |
| `sitemaps://{site_url}` | Sitemaps for a specific property (e.g. `sitemaps://sc-domain:example.com`) with health summary, errors, warnings, and index rates. |

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GSC_SERVICE_ACCOUNT_KEY_FILE` | * | Path to service account JSON key file |
| `GSC_SERVICE_ACCOUNT_KEY` | * | Inline service account JSON (alternative to file) |
| `GSC_OAUTH_CLIENT_FILE` | * | Path to OAuth client credentials JSON (Desktop app type) |
| `GSC_OAUTH_TOKEN_FILE` | No | Custom path for cached OAuth tokens (default: `~/.config/gsc-mcp/oauth-token.json`) |
| `GSC_SCOPES` | No | OAuth scope. Default: `webmasters.readonly`. Set to `https://www.googleapis.com/auth/webmasters` for write access |

\* **Auth priority:** OAuth (`GSC_OAUTH_CLIENT_FILE`) > Service Account (`GSC_SERVICE_ACCOUNT_KEY_FILE` or `GSC_SERVICE_ACCOUNT_KEY`). At least one must be configured.

## Development

```bash
npm install      # Install dependencies
npm run build    # Build
npm run dev      # Watch mode
npm test         # Run tests
```

## License

[MIT](LICENSE)

> **Note:** This is an unofficial community project. It is not affiliated with or endorsed by Google.

---

Built by [Tobias Hein](https://github.com/thein-art) at [artaxo](https://artaxo.com) — a digital marketing agency specializing in AI Search Optimization.
