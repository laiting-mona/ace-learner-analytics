# ACE Learner Analytics Dashboard

**ACE 學習者圖表報告系統** — A full-stack data analytics platform built entirely on Google Workspace (Apps Script + Sheets + Sites), serving the Center for Teaching and Learning Development at National Taiwan University.

---

## Problem Statement

The center collects learner registration data through SurveyCake survey forms. Before this system, generating any statistics required manually filtering a 1,000-row spreadsheet, then copying numbers into PowerPoint — a process that took hours and was prone to human error. Cross-referencing with NTU COOL enrollment data was done entirely by hand.

**Three core pain points addressed:**
1. No way to slice data by identity (faculty / student / researcher), college, or time period without manual work
2. Duplicate entries across multiple form submissions inflated raw counts
3. No audit trail for data access — a compliance gap for a university system handling personal data

---

## What I Built

### 1. Data Pipeline (Google Sheets + Apps Script)

A multi-stage data cleaning and normalization pipeline operating entirely within Google Sheets:

| Stage | Input | Output | Key Operation |
|-------|-------|--------|---------------|
| Raw ingestion | SurveyCake export (~980 rows) | `報名總表` | Import + timestamp normalization |
| Deduplication | `報名總表` | `去重報名總表` | ABC-column key dedup: 980 → 240 unique records |
| Enrichment | Survey responses | `彙整` (19 computed columns) | Identity classification, college normalization, time grouping |
| Cross-verification | `彙整` + NTU COOL roster | `對比` | Name-matching between two independent data sources |

**Deduplication result: 980 raw rows → 240 unique learner records (75% duplicate rate addressed)**

### 2. Web Analytics Dashboard (GAS Web App + Chart.js)

A single-page application embedded in Google Sites, with a secure backend served by Google Apps Script.

**Three chart modes:**

| Mode | Description |
|------|-------------|
| Progressive Filter | 5-step funnel: scope → identity → classification → rank → college. All selected combinations generate charts simultaneously. |
| Multi-line Comparison | Up to 30 custom filter sets plotted as separate lines on the same chart — enables side-by-side trend comparison |
| College Distribution | Bar chart with X-axis fixed at colleges, grouped by identity / rank / appointment type |

**Export options:** PNG bundle (ZIP) and full PDF report with auto-paginated charts and data tables.

---

## Security Architecture (v5.3.0)

The system handles university personal data, so security was built in from the start — not bolted on afterward.

```
User
 │
 ├─ Step 1: Google account whitelist check (ALLOWED_EMAILS)
 │           └─ Reject if not in list
 │
 ├─ Step 2: Password verification
 │           ├─ Track failed attempts per user (CacheService)
 │           ├─ Lock account after 5 failures (30-min lockout)
 │           └─ Issue Session Token (HMAC-SHA256, 48-char hex)
 │
 └─ Step 3: All subsequent API calls require valid token
             ├─ Token validated server-side on every request
             ├─ Token expires after 1 hour (SESSION_TTL)
             └─ Rate limit: 120 requests/hour per user
```

**Audit logging:** Every API call is logged to a dedicated `系統日誌` sheet with timestamp, user, action, and status — enabling compliance review.

---

## Technical Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla JS + Chart.js 4.4.0 + html2canvas + jsPDF + JSZip |
| Backend | Google Apps Script (`handleRequest` dispatcher pattern) |
| Data store | Google Sheets (no external database) |
| Auth | Google account SSO + HMAC-SHA256 session tokens via CacheService |
| Hosting | Google Sites (iframe embed of GAS Web App) |
| Export | Client-side PDF generation + ZIP packaging |

**Why no external backend?** The university's IT policy restricts external API calls from within the institutional network. Google Workspace is the approved infrastructure — building within GAS constraints was a deliberate design choice, not a limitation.

---

## Data Pipeline Detail

### Column Mapping (`_COL_MAP`)

The enrichment pipeline reads raw survey responses and derives structured fields:

```
Raw survey col C  →  填答時間      (timestamp → YYYY-MM for time grouping)
Raw survey col D  →  校內外身分    (inside/outside NTU)
Raw survey col H  →  校內身分      (faculty / student / researcher classification)
Raw survey col I  →  職稱/學籍     (job title / student status)
Raw survey col J  →  身分別(職級)  (appointment type: full-time / part-time / clinical)
Raw survey col K  →  職等          (academic rank: professor / associate / assistant / lecturer)
Raw survey col S  →  學院歸檔      (college, normalized from free-text entries)
```

### Identity Classification Logic

Free-text survey responses are normalized to structured categories using regex matching:

```javascript
// Example: faculty detection handles both Chinese and English inputs
'教師': row => /教師|Teacher/i.test(row['校內身分'])

// Edge case: staff/other = NTU-affiliated but not faculty/student/researcher
'教職員工/其他': row => {
  return row['校內外身分'] === '校內'
    && !/教師|Teacher|學生|Student|研究員/i.test(row['校內身分']);
}
```

### Time Grouping

Registration timestamps are grouped into four time granularities for flexible trend analysis:

```
Month    →  "2024-08"     → displayed as "2024.08"
Quarter  →  "2024-Q3"     → displayed as "2024 Q3"
Academic year  →  "113"   → displayed as "113學年"  (ROC calendar: year ≥ 8 → previous academic year)
Semester →  "113-1"       → displayed as "113學年第1學期"
```

---

## API Reference

The GAS backend uses a single dispatcher pattern. All calls go through `handleRequest(payload)`:

| `action` | Auth Required | Description |
|----------|--------------|-------------|
| `auth-check` | No | Verify Google account against whitelist |
| `login` | No | Password verification → returns session token + preloaded data |
| `chart` | Token | Mode 1: progressive filter chart data |
| `chart-multiline` | Token | Mode 2: multi-line comparison chart data |
| `chart-college` | Token | Mode 3: college distribution bar chart |
| `time-options` | Token | Available time periods (month/quarter/year/semester) |
| `labels` | Token | Available college names (dynamically scanned) |
| `cache-clear` | Token | Force cache flush and reload |

**Login response bundles `timeOptions` + `labels` in a single call** to prevent race conditions where the frontend might request data before the session token is written to CacheService.

---

## Repository Structure

```
ace-learner-analytics/
│
├── README.md                    ← This file
│
├── src/
│   ├── Code.gs                  ← GAS backend: auth, data pipeline, chart APIs
│   ├── index.html               ← Frontend: full SPA with Chart.js
│   └── appsscript.json          ← GAS project config and OAuth scopes
│
├── docs/
│   ├── architecture.md          ← System architecture and data flow
│   ├── data-dictionary.md       ← Column definitions and classification logic
│   └── security-model.md        ← Auth flow and security decisions
│
├── sample-data/
│   ├── sample_responses.csv     ← Anonymized sample with synthetic data (50 rows)
│   └── schema.md                ← Field definitions for the sample dataset
│
└── screenshots/
    ├── 01_login.png             ← Login page with dual-auth
    ├── 02_mode1_filter.png      ← Progressive filter mode
    ├── 03_mode2_multiline.png   ← Multi-line comparison mode
    ├── 04_mode3_college.png     ← College distribution chart
    ├── 05_export_pdf.png        ← PDF export output
    └── 06_data_pipeline.png     ← Google Sheets pipeline overview
```

---

## Deployment

This system is deployed on Google Workspace and cannot be run locally. To replicate:

1. Create a Google Apps Script project
2. Copy `src/Code.gs` and `src/index.html` into the project
3. In `Code.gs`, set `CONFIG.ALLOWED_EMAILS`, `CONFIG.SHEET_ID`, and `CONFIG.WEB_PASSWORD`
4. Deploy as Web App: execution as **Owner**, access to **Anyone with the link**
5. Copy the Web App URL and embed it in a Google Sites page via iframe
6. Prepare the source Google Sheet with columns matching `_COL_MAP`

**Required OAuth Scopes** (see `appsscript.json`):
- `https://www.googleapis.com/auth/spreadsheets` — read/write the data sheet
- `https://www.googleapis.com/auth/script.external_request` — not needed (no external calls)
- `https://www.googleapis.com/auth/userinfo.email` — Google account verification

---

## Impact

| Metric | Before | After |
|--------|--------|-------|
| Time to generate a statistics report | 6 to 8 hours (manual) | 10 minutes |
| Duplicate entries in active dataset | ~75% of raw rows | 0 (automated dedup) |
| Cross-system verification (SurveyCake vs NTU COOL) | Manual, error-prone | Automated name-matching sheet |
| Audit trail for data access | None | Full operation log with timestamp |
| Chart types available | Static, manual | 3 modes × fold combinations, real-time |

---

## Privacy & Data Notice

All data shown in `sample-data/` is **entirely synthetic** — generated to match the schema without containing any real personal information. The actual system handles university personnel data under NTU's data governance policy; no real names, emails, student IDs, or institutional affiliations are included in this repository.

---

## About This Project

Built as part of an automation role at NTU's Center for Teaching and Learning Development. The system replaced a fully manual reporting workflow and has been in active use since deployment.

**Core skills demonstrated:**
- Full-stack development within platform constraints (no external server)
- Data pipeline design: ingestion → deduplication → enrichment → normalization
- Security engineering: session management, rate limiting, audit logging
- Data visualization: Chart.js with dynamic configuration
- Client-side document generation: PDF and ZIP export without server involvement
