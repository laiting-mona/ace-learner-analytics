# System Architecture

## Overview

The ACE Learner Analytics Dashboard is a zero-external-dependency analytics platform built entirely on Google Workspace. There is no separate server, database, or cloud provider — all computation happens in Google Apps Script, and all data lives in Google Sheets.

## Data Flow

```
External survey platform (SurveyCake)
    │
    │  Manual export (CSV/XLSX)
    ▼
Google Sheets — 報名總表 (~980 rows, raw)
    │
    │  dedup.gs (daily trigger, 09:00)
    │  Composite key: Name | Email | Identity
    ▼
Google Sheets — 去重報名總表 (~240 rows, deduplicated)
    │
    │  Manual enrichment pipeline (formula columns)
    │  + identity normalization
    │  + college name standardization
    │  + time grouping fields
    ▼
Google Sheets — 彙整 (primary data source, 19 computed columns)
    │
    │  Also: cross-reference vs NTU COOL enrollment roster
    │         → 對比 sheet (name-matching verification)
    │
    ▼
Google Apps Script (Code.gs)
    │  fetchAllData() → cached in CacheService (60s TTL)
    │  handleRequest() dispatcher
    │  ├── auth-check → whitelist verification
    │  ├── login      → password + session token
    │  ├── chart      → mode 1: progressive filter
    │  ├── chart-multiline → mode 2: multi-line
    │  └── chart-college  → mode 3: college distribution
    │
    ▼
index.html (served via HtmlService)
    │  Chart.js 4.4.0 — rendering
    │  html2canvas + jsPDF — PDF export
    │  JSZip — PNG bundle download
    │
    ▼
Google Sites (iframe embed)
    └── End user (browser)
```

## Component Responsibilities

### `Code.gs`

The backend is structured around a single dispatcher function `handleRequest(payload)`. All frontend calls route through this entry point, which handles:

1. **Auth pipeline**: whitelist check → password → session token issuance
2. **Security middleware**: token validation → rate limiting → audit logging
3. **Data layer**: cached spreadsheet reads via `fetchAllData()`
4. **Chart APIs**: three independent chart generators

### `index.html`

A self-contained single-page application with no build step. Key design decisions:

- **No npm / bundler** — deployed as raw HTML+JS via `HtmlService.createHtmlOutputFromFile()`
- **No fetch() calls** — all backend communication uses `google.script.run.handleRequest()`, which bypasses CORS entirely
- **Session state** stored in a JS variable (`sessionToken`), not `localStorage` — avoids cross-origin storage issues in the Sites iframe context

### `dedup.gs`

Standalone deduplication script with its own daily trigger. Kept separate from `Code.gs` to maintain clear separation of concerns between the ETL pipeline and the API layer.

## Security Model

See [security-model.md](./security-model.md) for the full authentication and authorization design.

## Key Constraints

| Constraint | Origin | Impact |
|-----------|--------|--------|
| No external HTTP calls | University IT policy | All dependencies loaded from CDN at page load; no server-side fetch |
| `CacheService` max TTL: 6 hours | GAS platform | Session tokens expire at 1 hour (well within limit) |
| `CacheService` max value size: ~100KB | GAS platform | Data cache uses 60s TTL and skips caching if serialized data > 90KB |
| No persistent storage across GAS instances | GAS platform | All state (sessions, lockouts) uses CacheService; not PropertiesService (incompatible with Owner execution mode) |
| GAS execution timeout: 6 minutes | GAS platform | All chart queries complete in < 5s on ~1,000 rows; no pagination needed at current scale |

## Scaling Considerations

The current architecture works well at ~1,000 rows. If the dataset grows significantly:

- **> 90KB serialized**: The cache will stop working (`_cacheSet` has a size guard). Consider filtering columns before caching, or implementing per-sheet partial caching.
- **> ~5,000 rows**: `fetchAllData()` may approach the 6-minute timeout. Consider pre-computing aggregations in a separate Apps Script trigger that runs nightly.
- **> 30 concurrent users**: Rate limiting (120 req/hour per user) provides per-user protection, but CacheService is shared — heavy simultaneous use could cause cache evictions.
