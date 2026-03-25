# Sample Data Schema

## About This Dataset

`sample_responses.csv` contains **50 synthetic rows** generated to match the schema of the `彙整` (enriched) sheet. All names, emails, student IDs, and identifying information have been removed. The data represents the structure and value distribution of real data but contains no actual personal information.

## Column Definitions

| Column | Type | Example Values | Notes |
|--------|------|---------------|-------|
| `填答時間` | Datetime string | `2024-08-05 09:15:22` | Registration timestamp. Format: `YYYY-MM-DD HH:MM:SS`. Used for all time-based groupings. |
| `校內外身分` | Categorical | `校內`, `校外` | Whether the registrant is affiliated with NTU. |
| `身分別 Background Information` | Categorical | `教師 Teacher`, `學生 Student`, `研究員 Researcher` | Identity from the survey form. Bilingual values are common. |
| `學院歸檔` | Categorical | `理學院`, `工學院`, `文學院`, … | Normalized college name. Empty for non-NTU registrants. |
| `校內身分` | Categorical | `校內教師 Teacher`, `校內學生 Student`, `校內研究員 Researcher`, `校內行政` | Derived identity label used for matching. |
| `職稱/學籍` | Text | `助理教授 Assistant Professor`, `碩士班`, `博士後研究員` | Job title (faculty) or degree level (student). |
| `身分別(職級)` | Categorical | `專任教師`, `兼任教師`, `專案教師`, `臨床教師`, `大學部`, `碩士班`, `博士班` | Appointment type (faculty) or degree level (student). |
| `職等` | Categorical | `教授`, `副教授`, `助理教授`, `講師` | Academic rank. Empty for students and researchers. |

## Value Distributions (Approximate, based on real data pattern)

**Identity:**
- Faculty (教師): ~55%
- Student (學生): ~30%
- Researcher (研究員): ~8%
- Staff/Other (教職員工/其他): ~5%
- External (校外): ~15% of total

**Faculty Appointment Type:**
- Full-time (專任): ~60%
- Part-time (兼任): ~20%
- Project (專案): ~10%
- Clinical (臨床): ~10%

**Faculty Rank:**
- Professor (教授): ~25%
- Associate Professor (副教授): ~35%
- Assistant Professor (助理教授): ~30%
- Lecturer (講師): ~10%

**Student Degree Level:**
- Undergraduate (大學部): ~20%
- Master's (碩士班): ~50%
- Doctoral (博士班): ~30%

## Usage

This sample data can be used to:

1. **Test the deduplication script** (`dedup.gs`): import into a Google Sheet named `報名總表` and run `testRemoveDuplicatesABC()`
2. **Test the chart APIs** (`Code.gs`): load into a `彙整` sheet and verify `getTimeOptions()`, `getAvailableLabels()`, and the chart generators return expected results
3. **Understand the schema** before adapting the system for a different data source

## Generating Additional Sample Data

If you need more rows for testing, the following fields drive most of the interesting logic:

```python
# Key fields and their valid values
校內外身分 = ['校內', '校外']
校內身分 = ['校內教師 Teacher', '校內學生 Student', '校內研究員 Researcher', '校內行政']
身分別(職級) = ['專任教師', '兼任教師', '專案教師', '臨床教師', '大學部', '碩士班', '博士班']
職等 = ['教授', '副教授', '助理教授', '講師', '']  # empty for non-faculty
學院歸檔 = ['理學院', '工學院', '文學院', '生命科學學院', '醫學院',
            '電機資訊學院', '社會科學院', '管理學院', '法律學院', '公共衛生學院', '']
```
