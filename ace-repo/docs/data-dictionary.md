# Data Dictionary

## Source Sheet: `彙整` (Primary Data Source)

This sheet is the output of the enrichment pipeline. Each row represents one registration event (after deduplication). The dashboard reads exclusively from this sheet.

### Column Reference

| Col | Internal Key | Source | Description |
|-----|-------------|--------|-------------|
| C (3) | `填答時間` | Raw survey | Submission timestamp. Parsed to `YYYY-MM` month key by `parseMonthKey()`. |
| D (4) | `校內外身分` | Derived | `校內` (NTU-affiliated) or `校外` (external). Used as the top-level scope filter. |
| F (6) | `_學院備用` | Raw survey | College field from the survey form. Used as backup when col S is empty. |
| H (8) | `校內身分` | Derived | Identity category within NTU. Source of truth for faculty/student/researcher classification. |
| I (9) | `職稱_學籍` | Raw survey | Free-text job title (faculty) or student status (student). |
| J (10) | `身分別_職級` | Derived | Appointment type for faculty: 專任/兼任/專案/臨床. Student degree level. |
| K (11) | `職等` | Derived | Academic rank: 教授/副教授/助理教授/講師. Blank for non-faculty. |
| S (19) | `學院歸檔` | Derived | **Primary college field.** Normalized from free-text responses to canonical college names. |

### Identity Classification Rules

The `校內身分` field (col H) is the authoritative source for identity classification. The MATCHERS dictionary implements these rules:

| UI Label | Column Used | Matching Rule |
|----------|-------------|---------------|
| 教師 (Faculty) | 校內身分 (H) | `/教師\|Teacher/i` — handles bilingual responses |
| 學生 (Student) | 校內身分 (H) | `/學生\|Student/i` |
| 研究員 (Researcher) | 校內身分 (H) | `/研究員\|Researcher/i` |
| 教職員工/其他 (Staff/Other) | 校內外身分 (D) + 校內身分 (H) | NTU-affiliated AND not faculty/student/researcher |
| 校外 (External) | 校內外身分 (D) | Exact match: `校外` |

### Appointment Type Rules (教師 only)

| UI Label | Column | Rule |
|----------|--------|------|
| 專任 (Full-time) | 身分別_職級 (J) | Contains `專任` |
| 兼任 (Part-time) | 身分別_職級 (J) | Contains `兼任` |
| 專案 (Project) | 身分別_職級 (J) | Contains `專案` |
| 臨床 (Clinical) | 身分別_職級 (J) | Contains `臨床` |

### Academic Rank Rules (教師 only)

| UI Label | Column | Rule |
|----------|--------|------|
| 教授 (Professor) | 職等 (K) | Exactly `教授`, or contains `教授` but NOT `副` or `助理` |
| 副教授 (Associate Prof.) | 職等 (K) | Contains `副教授` |
| 助理教授 (Assistant Prof.) | 職等 (K) | Contains `助理教授` |
| 講師 (Lecturer) | 職等 (K) | Contains `講師` |

### Student Degree Level Rules

| UI Label | Columns | Rule |
|----------|---------|------|
| 大學部 (Undergraduate) | 職稱_學籍 (I) + 身分別_職級 (J) | Contains `大學部`, `Undergraduate`, or `學士` |
| 碩士班 (Master's) | 職稱_學籍 (I) + 身分別_職級 (J) | Contains `碩士` or `Master` |
| 博士班 (Doctoral) | 職稱_學籍 (I) + 身分別_職級 (J) | Contains `博士`, `Doctoral`, or `PhD` |

### Time Grouping Logic

| Unit | Input Example | Output | Display |
|------|--------------|--------|---------|
| Month | `2024-08-12 06:42:16` | `2024-08` | `2024.08` |
| Quarter | `2024-08` | `2024-Q3` | `2024 Q3` |
| Academic Year | `2024-08` | `113` | `113學年` |
| Semester (1st) | `2024-08` (Aug–Dec or Jan) | `113-1` | `113學年第1學期` |
| Semester (2nd) | `2024-03` (Feb–Jul) | `112-2` | `112學年第2學期` |

Academic year conversion: `月 ≥ 8 → ROC year = Gregorian year - 1911`; `月 < 8 → ROC year = Gregorian year - 1912`

---

## Sample Data Schema

See [../sample-data/schema.md](../sample-data/schema.md) for the synthetic sample dataset structure.

---

## Cross-Reference Sheet: `對比`

Used during data quality review to verify that registrations in the SurveyCake survey match enrollment records in NTU COOL (the university LMS).

| Column | Description |
|--------|-------------|
| A | Name as recorded in SurveyCake |
| B | Name as recorded in NTU COOL |
| C–D | (Reserved for notes / match status) |

Rows where A ≠ B indicate potential name format mismatches (e.g., Chinese name vs. English name, name with student ID in parentheses). These are reviewed manually.
