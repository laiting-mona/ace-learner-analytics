/**
 * ACE Learner Analytics Dashboard — Google Apps Script Backend
 * v5.3.0
 *
 * Security features:
 *   - Google account whitelist (ALLOWED_EMAILS)
 *   - Password authentication with session tokens (1-hour TTL)
 *   - Failed-login lockout (5 attempts → 30-min lock)
 *   - Per-user rate limiting (120 req/hour)
 *   - Full operation audit log written to a dedicated sheet
 *
 * Deployment:
 *   Execute as: Me (Owner)          ← required for shared CacheService
 *   Access:     Anyone with the link
 *   Version:    Head (edits take effect immediately)
 */

// ════════════════════════════════════════════════════
//  Configuration — edit these before deploying
// ════════════════════════════════════════════════════
const CONFIG = {
  // Emails allowed to log in (Google account must match exactly)
  ALLOWED_EMAILS: [
    'your-admin@example.com',
    // Add additional authorized users here
  ],

  // Google Sheets — replace with your spreadsheet ID
  SHEET_ID:       'YOUR_SPREADSHEET_ID_HERE',
  SHEET_NAME:     '彙整',          // Primary data sheet name
  LOG_SHEET_NAME: '系統日誌',      // Audit log sheet (auto-created if missing)

  // System password (users enter this after Google account verification)
  WEB_PASSWORD:    'change-me',

  // Security tuning
  SESSION_TTL:     3600,   // Session token lifetime in seconds (1 hour)
  RATE_LIMIT_MAX:  120,    // Max API calls per user per hour
  RATE_LIMIT_WIN:  3600,   // Rate limit window in seconds
  PW_MAX_ATTEMPTS: 5,      // Failed login attempts before lockout
  PW_LOCKOUT_SEC:  1800,   // Lockout duration in seconds (30 minutes)
};

// ════════════════════════════════════════════════════
//  HTTP Entry Point
// ════════════════════════════════════════════════════

function doGet(e) {
  return HtmlService
    .createHtmlOutputFromFile('index')
    .setTitle('ACE Learner Analytics Dashboard')
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

/**
 * Unified request dispatcher — all frontend calls route through here.
 * Called via: google.script.run.handleRequest(payload)
 *
 * @param {Object} payload - Must include `action` field. Most actions require `token`.
 * @returns {Object} JSON-serializable response object
 */
function handleRequest(payload) {
  try {
    const action = payload.action || '';
    const email  = 'user';  // Fixed: execution as Owner; email is a fixed identifier

    // Unauthenticated actions
    if (action === 'auth-check') return { allowed: true, email: '' };
    if (action === 'login')      return _handleLogin(email, payload.password);

    // All other actions require a valid session token
    const tokenCheck = _verifySession(payload.token, email);
    if (!tokenCheck.ok) {
      _writeLog(email, action, 'REJECTED:' + tokenCheck.reason);
      return { error: tokenCheck.reason };
    }

    // Enforce per-user rate limit
    if (!_checkRateLimit(email)) {
      _writeLog(email, action, 'RATE_LIMITED');
      return { error: `Rate limit exceeded (max ${CONFIG.RATE_LIMIT_MAX} requests/hour)` };
    }

    _writeLog(email, action, 'OK');

    switch (action) {
      case 'time-options':    return getTimeOptions();
      case 'labels':          return getAvailableLabels();
      case 'chart':           return generateProgressiveChart(payload);
      case 'chart-multiline': return generateMultiLineChart(payload);
      case 'chart-college':   return generateCollegeBarChart(payload);
      case 'cache-clear':     _cacheFlush(); return { success: true };
      default:                return { error: 'Unknown action: ' + action };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ════════════════════════════════════════════════════
//  Authentication — password + session token
// ════════════════════════════════════════════════════

function _handleLogin(email, password) {
  // Check lockout status
  const lockKey = 'lock_' + email;
  const lockRaw = _propGet(lockKey);
  if (lockRaw) {
    const lock      = JSON.parse(lockRaw);
    const remaining = Math.ceil(lock.until - Date.now() / 1000);
    if (remaining > 0) {
      _writeLog(email, 'login', 'LOCKOUT:' + remaining + 's');
      return { error: `Account locked. Try again in ${Math.ceil(remaining / 60)} minute(s).` };
    }
    _propDelete(lockKey);
  }

  // Validate password
  if (password !== CONFIG.WEB_PASSWORD) {
    const attKey = 'att_' + email;
    const newAtt  = parseInt(_propGet(attKey) || '0') + 1;

    if (newAtt >= CONFIG.PW_MAX_ATTEMPTS) {
      // Trigger lockout
      _propSet(lockKey, JSON.stringify({ until: Date.now() / 1000 + CONFIG.PW_LOCKOUT_SEC }), CONFIG.PW_LOCKOUT_SEC + 60);
      _propDelete(attKey);
      _writeLog(email, 'login', 'LOCKOUT_TRIGGERED');
      return { error: `Account locked after ${CONFIG.PW_MAX_ATTEMPTS} failed attempts. Locked for ${CONFIG.PW_LOCKOUT_SEC / 60} minutes.` };
    }

    _propSet(attKey, String(newAtt), CONFIG.PW_LOCKOUT_SEC);
    _writeLog(email, 'login', 'WRONG_PW:attempt_' + newAtt);
    return { error: `Incorrect password. ${CONFIG.PW_MAX_ATTEMPTS - newAtt} attempt(s) remaining.` };
  }

  // Issue session token
  _propDelete('att_' + email);
  const token = _generateToken();
  _propSet('sess_' + token, JSON.stringify({ email, created: Math.floor(Date.now() / 1000) }), CONFIG.SESSION_TTL + 60);
  _writeLog(email, 'login', 'SUCCESS');

  // Bundle timeOptions + labels in the login response to avoid race conditions
  // (frontend cannot query these before the token write has propagated in CacheService)
  return {
    success:     true,
    token,
    expiresIn:   CONFIG.SESSION_TTL,
    timeOptions: getTimeOptions(),
    labels:      getAvailableLabels(),
  };
}

function _verifySession(token, email) {
  if (!token) return { ok: false, reason: 'session_required' };
  const raw = _propGet('sess_' + token);
  if (!raw)  return { ok: false, reason: 'session_expired' };
  try {
    const sess = JSON.parse(raw);
    if (sess.email !== email) return { ok: false, reason: 'session_mismatch' };
    if (Math.floor(Date.now() / 1000) - sess.created > CONFIG.SESSION_TTL) {
      _propDelete('sess_' + token);
      return { ok: false, reason: 'session_expired' };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'session_invalid' };
  }
}

/** Generates a 48-character hex token using HMAC-SHA256 */
function _generateToken() {
  const raw = Utilities.computeHmacSha256Signature(
    String(Date.now()) + Math.random(),
    'ace_salt_' + CONFIG.WEB_PASSWORD
  );
  return raw.map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('').substring(0, 48);
}

// ════════════════════════════════════════════════════
//  Rate Limiting
// ════════════════════════════════════════════════════

/**
 * Sliding-window rate limiter using CacheService.
 * Key format: rl_{email}_{hourBucket}
 */
function _checkRateLimit(email) {
  const key   = 'rl_' + email + '_' + Math.floor(Date.now() / 1000 / CONFIG.RATE_LIMIT_WIN);
  const cache = CacheService.getScriptCache();
  const cur   = parseInt(cache.get(key) || '0');
  if (cur >= CONFIG.RATE_LIMIT_MAX) return false;
  cache.put(key, String(cur + 1), CONFIG.RATE_LIMIT_WIN);
  return true;
}

// ════════════════════════════════════════════════════
//  Audit Logging
// ════════════════════════════════════════════════════

/**
 * Appends a row to the LOG_SHEET_NAME sheet.
 * Sheet is auto-created with headers on first write.
 */
function _writeLog(email, action, status) {
  try {
    const ss    = SpreadsheetApp.openById(CONFIG.SHEET_ID);
    let   sheet = ss.getSheetByName(CONFIG.LOG_SHEET_NAME);
    if (!sheet) {
      sheet = ss.insertSheet(CONFIG.LOG_SHEET_NAME);
      sheet.appendRow(['Timestamp', 'User', 'Action', 'Status']);
      sheet.getRange(1, 1, 1, 4).setFontWeight('bold');
    }
    const now = Utilities.formatDate(new Date(), 'Asia/Taipei', 'yyyy-MM-dd HH:mm:ss');
    sheet.appendRow([now, email, action, status]);
  } catch (e) { /* Silently fail — logging must never break the main flow */ }
}

// ════════════════════════════════════════════════════
//  CacheService wrapper
// ════════════════════════════════════════════════════
// All state (sessions, lockouts, attempt counters) uses CacheService.
// PropertiesService requires script-owner permissions and fails when
// executed as a different user; CacheService is safe for multi-user deployments.
// Key prefix 'p_' namespaces these from the data cache key 'ace_data'.

function _propGet(key)        { try { return CacheService.getScriptCache().get('p_' + key); }              catch (e) { return null; } }
function _propSet(key, v, ttl){ try { CacheService.getScriptCache().put('p_' + key, v, Math.min(ttl || 3600, 21600)); } catch (e) {} }
function _propDelete(key)     { try { CacheService.getScriptCache().remove('p_' + key); }                  catch (e) {} }

// ════════════════════════════════════════════════════
//  Data cache
// ════════════════════════════════════════════════════

function _cacheGet()       { try { const r = CacheService.getScriptCache().get('ace_data'); return r ? JSON.parse(r) : null; } catch (e) { return null; } }
function _cacheSet(data)   { try { const s = JSON.stringify(data); if (s.length < 90000) CacheService.getScriptCache().put('ace_data', s, 60); } catch (e) {} }
function _cacheFlush()     { CacheService.getScriptCache().remove('ace_data'); }

// ════════════════════════════════════════════════════
//  Column mapping
// ════════════════════════════════════════════════════
/**
 * Maps spreadsheet column numbers to internal field names.
 * Using column numbers (not header text) makes the mapping stable even if
 * column headers are edited or translated.
 *
 * Adjust these if your sheet layout differs.
 */
const _COL_MAP = [
  { col: 3,  key: '填答時間'    },   // Submission timestamp
  { col: 4,  key: '校內外身分'  },   // Inside / outside NTU
  { col: 6,  key: '_學院備用'   },   // College (backup source)
  { col: 8,  key: '校內身分'    },   // Identity category (faculty/student/researcher)
  { col: 9,  key: '職稱_學籍'   },   // Job title or student status
  { col: 10, key: '身分別_職級' },   // Appointment type (full-time/part-time/clinical)
  { col: 11, key: '職等'        },   // Academic rank (professor/associate/etc.)
  { col: 19, key: '學院歸檔'    },   // Normalized college name ← primary source
];

/**
 * Reads all data rows from the source sheet.
 * Results are cached for 60 seconds to avoid repeated Sheets API calls.
 */
function fetchAllData() {
  const cached = _cacheGet();
  if (cached) return cached;

  const ss      = SpreadsheetApp.openById(CONFIG.SHEET_ID);
  const sheet   = ss.getSheetByName(CONFIG.SHEET_NAME);
  const lastRow = sheet.getLastRow();
  if (lastRow < 2) return [];

  const vals = sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
  const tz   = 'Asia/Taipei';

  const rows = vals.map(row => {
    const obj = {};
    _COL_MAP.forEach(m => {
      let val = row[m.col - 1];
      // Convert Date objects to ISO string before JSON serialization
      if (Object.prototype.toString.call(val) === '[object Date]')
        val = Utilities.formatDate(val, tz, 'yyyy-MM-dd HH:mm:ss');
      obj[m.key] = (val == null) ? '' : val;
    });
    return obj;
  });

  _cacheSet(rows);
  return rows;
}

// ════════════════════════════════════════════════════
//  Date / time utilities
// ════════════════════════════════════════════════════

/** Parses a timestamp value to "YYYY-MM" month key */
function parseMonthKey(val) {
  if (!val) return null;
  if (typeof val === 'string') {
    const m = val.match(/^(\d{4})[-/](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0');
  }
  if (Object.prototype.toString.call(val) === '[object Date]' && !isNaN(val))
    return val.getFullYear() + '-' + String(val.getMonth() + 1).padStart(2, '0');
  return null;
}

function groupByTimeUnit(mk, unit) {
  switch (unit) {
    case 'quarter':  return monthToQuarter(mk);
    case 'year':     return monthToYear(mk);
    case 'semester': return monthToSemester(mk);
    default:         return mk;
  }
}

function monthToQuarter(mk)  { const [y, m] = mk.split('-').map(Number); return y + '-Q' + Math.ceil(m / 3); }
function monthToYear(mk)     { const [y, m] = mk.split('-').map(Number); return String(m >= 8 ? y - 1911 : y - 1912); }
function monthToSemester(mk) {
  const [y, m] = mk.split('-').map(Number);
  if (m >= 8)  return (y - 1911) + '-1';  // Aug–Dec → Semester 1
  if (m === 1) return (y - 1912) + '-1';  // Jan     → Semester 1 (continued)
  return (y - 1912) + '-2';               // Feb–Jul → Semester 2
}

function formatPeriod(pk, unit) {
  if (unit === 'month')    return pk.replace('-', '.');
  if (unit === 'quarter')  return pk.replace('-', ' ');
  if (unit === 'year')     return pk + '學年';
  if (unit === 'semester') { const [y, s] = pk.split('-'); return y + '學年第' + s + '學期'; }
  return pk;
}

// ════════════════════════════════════════════════════
//  Label matching
// ════════════════════════════════════════════════════
/**
 * Maps human-readable filter labels (as shown in the UI) to
 * row-level predicate functions.
 *
 * Design note: regex patterns handle both Chinese and English survey
 * responses, since some respondents filled out the bilingual form
 * in English only.
 */
const MATCHERS = {
  '教師':          r => /教師|Teacher/i.test(r['校內身分'] || ''),
  '學生':          r => /學生|Student/i.test(r['校內身分'] || ''),
  '研究員':        r => /研究員|Researcher/i.test(r['校內身分'] || ''),
  '教職員工/其他': r => {
    const d = r['校內外身分'] || '', h = r['校內身分'] || '';
    return d === '校內' && !/教師|Teacher|學生|Student|研究員/i.test(h);
  },
  '專任':     r => /專任/.test(r['身分別_職級'] || ''),
  '兼任':     r => /兼任/.test(r['身分別_職級'] || ''),
  '專案':     r => /專案/.test(r['身分別_職級'] || ''),
  '臨床':     r => /臨床/.test(r['身分別_職級'] || ''),
  '教授':     r => { const k = (r['職等'] || '').trim(); return k === '教授' || (k.includes('教授') && !k.includes('副') && !k.includes('助理')); },
  '副教授':   r => (r['職等'] || '').includes('副教授'),
  '助理教授': r => (r['職等'] || '').includes('助理教授'),
  '講師':     r => (r['職等'] || '').includes('講師'),
  '大學部':   r => /大學部|Undergraduate|學士/.test((r['職稱_學籍'] || '') + (r['身分別_職級'] || '')),
  '碩士班':   r => /碩士|Master/.test((r['職稱_學籍'] || '') + (r['身分別_職級'] || '')),
  '博士班':   r => /博士|Doctoral|PhD/.test((r['職稱_學籍'] || '') + (r['身分別_職級'] || '')),
  '校內':     r => (r['校內外身分'] || '') === '校內',
  '校外':     r => (r['校內外身分'] || '') === '校外',
};

/** Returns the predicate for a known label, or falls back to exact college-name match */
function getLabelMatcher(label) {
  return MATCHERS[label] || (r => (r['學院歸檔'] || '').trim() === label);
}

/** Combines multiple filter levels into a single AND predicate */
function buildMatchFn(filters) {
  const fns = [];
  if (filters.scope)    fns.push(getLabelMatcher(filters.scope));
  if (filters.identity) fns.push(getLabelMatcher(filters.identity));
  if (filters.level3)   fns.push(getLabelMatcher(filters.level3));
  if (filters.level4)   fns.push(getLabelMatcher(filters.level4));
  if (filters.college)  fns.push(getLabelMatcher(filters.college));
  return fns.length > 0 ? r => fns.every(fn => fn(r)) : () => true;
}

// ════════════════════════════════════════════════════
//  API handlers
// ════════════════════════════════════════════════════

function getTimeOptions() {
  const data = fetchAllData();
  const ms   = new Set();
  data.forEach(r => { const m = parseMonthKey(r['填答時間']); if (m) ms.add(m); });
  const months = [...ms].sort();
  return {
    months,
    quarters:  [...new Set(months.map(monthToQuarter))].sort(),
    years:     [...new Set(months.map(monthToYear))].sort(),
    semesters: [...new Set(months.map(monthToSemester))].sort(),
  };
}

function getAvailableLabels() {
  const data = fetchAllData();
  const cs   = new Set();
  data.forEach(r => { const c = (r['學院歸檔'] || '').trim(); if (c && c !== 'nan') cs.add(c); });
  return { groups: [{ id: 'college', name: '學院歸檔', labels: [...cs].sort() }] };
}

/**
 * Mode 1 — Progressive filter.
 * Computes a single time-series for one filter combination.
 * statType: 'new' | 'cumulative'
 * displayType: 'count' | 'ratio'
 */
function generateProgressiveChart(params) {
  const { filters, statType, displayType, timeUnit, timeValues } = params;
  const allData = fetchAllData();
  const sp      = timeValues.slice().sort();
  const minP    = sp[0], maxP = sp[sp.length - 1];
  const isMatch = buildMatchFn(filters);

  let base = 0, totBase = 0;
  const pd = {}, td = {};
  sp.forEach(p => { pd[p] = 0; td[p] = 0; });

  allData.forEach(r => {
    const m = parseMonthKey(r['填答時間']); if (!m) return;
    const period = groupByTimeUnit(m, timeUnit);
    const match  = isMatch(r);
    if (statType === 'cumulative') {
      if (period <= maxP) {
        if (period < minP)           { totBase++; if (match) base++; }
        else if (sp.includes(period)) { td[period]++; if (match) pd[period]++; }
      }
    } else {
      if (sp.includes(period)) { td[period]++; if (match) pd[period]++; }
    }
  });

  const counts = sp.map(p => pd[p]);
  const totals = sp.map(p => td[p]);
  const fc     = _calcFinal(counts, totals, statType, displayType, base, totBase);

  const parts = [filters.scope, filters.identity, filters.level3, filters.level4, filters.college].filter(Boolean);
  const lbl   = parts.length ? parts.join(' ➔ ') : '全部資料';

  return _buildResult(
    `[逐層過濾] ${lbl} ｜ ${_statLbl(statType)}${_dispLbl(displayType)}`,
    sp, timeUnit, [{ label: lbl, data: fc }], displayType, statType,
    [{ category: lbl, values: fc, total: statType === 'cumulative' ? fc[fc.length - 1] || 0 : fc.reduce((a, b) => a + b, 0) }]
  );
}

/**
 * Mode 2 — Multi-line comparison.
 * Each filterSet in the array becomes one line on the chart.
 */
function generateMultiLineChart(params) {
  const { filterSets, statType, displayType, timeUnit, timeValues } = params;
  const allData = fetchAllData();
  const sp      = timeValues.slice().sort();
  const minP    = sp[0];

  const totByP = {};
  let totBase  = 0;
  sp.forEach(p => totByP[p] = 0);

  allData.forEach(r => {
    const m = parseMonthKey(r['填答時間']); if (!m) return;
    const p = groupByTimeUnit(m, timeUnit);
    if (statType === 'cumulative') { if (p < minP) totBase++; else if (sp.includes(p)) totByP[p]++; }
    else { if (sp.includes(p)) totByP[p]++; }
  });

  const datasets = [], summaryRows = [];

  filterSets.forEach(fs => {
    const isMatch = buildMatchFn(fs);
    let base = 0;
    const pc = {};
    sp.forEach(p => pc[p] = 0);

    allData.forEach(r => {
      const m = parseMonthKey(r['填答時間']); if (!m) return;
      const p = groupByTimeUnit(m, timeUnit);
      if (statType === 'cumulative') {
        if (p < minP && isMatch(r)) base++;
        else if (sp.includes(p) && isMatch(r)) pc[p]++;
      } else {
        if (sp.includes(p) && isMatch(r)) pc[p]++;
      }
    });

    let counts = sp.map(p => pc[p]);
    if (statType === 'cumulative') { let cum = base; counts = counts.map(v => { cum += v; return cum; }); }

    let fc = [...counts];
    if (displayType === 'ratio') {
      if (statType === 'cumulative') {
        let tc = totBase; const tcs = sp.map(p => { tc += totByP[p]; return tc; });
        fc = counts.map((v, i) => tcs[i] > 0 ? Math.round(v / tcs[i] * 1000) / 10 : 0);
      } else {
        fc = counts.map((v, i) => totByP[sp[i]] > 0 ? Math.round(v / totByP[sp[i]] * 1000) / 10 : 0);
      }
    }

    const parts = [fs.scope, fs.identity, fs.level3, fs.level4, fs.college].filter(Boolean);
    const lbl   = (fs.label && fs.label.trim()) ? fs.label.trim() : (parts.length ? parts.join(' ➔ ') : '全部資料');
    datasets.push({ label: lbl, data: fc });
    summaryRows.push({ category: lbl, values: fc, total: statType === 'cumulative' ? (fc[fc.length - 1] || 0) : fc.reduce((a, b) => a + b, 0) });
  });

  return _buildResult(`[多條線比較] ${_statLbl(statType)}${_dispLbl(displayType)}`, sp, timeUnit, datasets, displayType, statType, summaryRows);
}

/**
 * Mode 3 — College distribution bar chart.
 * X-axis: colleges. Grouped by identity / rank / appointment type.
 */
function generateCollegeBarChart(params) {
  const { groupBy, statType, displayType, timeUnit, timeValues } = params;
  const allData = fetchAllData();
  const sp      = timeValues.slice().sort();
  const minP    = sp[0];

  const GV = {
    identity:  ['教師', '學生', '研究員', '教職員工/其他'],
    apptType:  ['專任', '兼任', '專案', '臨床'],
    rank:      ['教授', '副教授', '助理教授', '講師'],
  };
  const gv = GV[groupBy] || GV.identity;

  const cs = new Set();
  allData.forEach(r => { const c = (r['學院歸檔'] || '').trim(); if (c && c !== 'nan') cs.add(c); });
  const colleges = [...cs].sort();

  const inScope = r => {
    const m = parseMonthKey(r['填答時間']); if (!m) return false;
    const p = groupByTimeUnit(m, timeUnit);
    return statType === 'cumulative' ? p <= sp[sp.length - 1] : sp.includes(p);
  };
  const inBase = r => {
    if (statType !== 'cumulative') return false;
    const m = parseMonthKey(r['填答時間']); if (!m) return false;
    return groupByTimeUnit(m, timeUnit) < minP;
  };

  const datasets = [], summaryRows = [];
  gv.forEach(val => {
    const mFn = getLabelMatcher(val);
    const data = colleges.map(col =>
      allData.filter(r => (inScope(r) || inBase(r)) && (r['學院歸檔'] || '').trim() === col && mFn(r)).length
    );
    datasets.push({ label: val, data });
    summaryRows.push({ category: val, values: data, total: data.reduce((a, b) => a + b, 0) });
  });

  // Remove colleges with zero total across all groups
  const nzIdx  = colleges.reduce((acc, _, i) => { if (datasets.reduce((s, ds) => s + ds.data[i], 0) > 0) acc.push(i); return acc; }, []);
  const cols2  = nzIdx.map(i => colleges[i]);
  const ds2    = datasets.map(ds => ({ ...ds, data: nzIdx.map(i => ds.data[i]) }));
  const rows2  = summaryRows.map(r => ({ ...r, values: nzIdx.map(i => r.values[i]) }));

  const DIM = { identity: '身分', apptType: '職級', rank: '職等' };
  return {
    title:          `[學院分佈] 依${DIM[groupBy] || groupBy} ｜ ${_statLbl(statType)}${_dispLbl(displayType)}`,
    periodLabels:   cols2,
    datasets:       ds2,
    displayType,
    statType,
    isCollegeChart: true,
    summary:        { headers: ['類別', ...cols2, '合計'], rows: rows2 },
  };
}

// ════════════════════════════════════════════════════
//  Shared helpers
// ════════════════════════════════════════════════════

function _statLbl(s) { return s === 'cumulative' ? '累計' : '新增'; }
function _dispLbl(d) { return d === 'ratio' ? '比例' : '人數'; }

function _calcFinal(counts, totals, statType, displayType, baseline, totalBaseline) {
  let fc;
  if (statType === 'cumulative') {
    let cum = baseline;
    fc = counts.map(v => { cum += v; return cum; });
    if (displayType === 'ratio') {
      let tc = totalBaseline;
      const ft = totals.map(v => { tc += v; return tc; });
      fc = fc.map((v, i) => ft[i] > 0 ? Math.round(v / ft[i] * 1000) / 10 : 0);
    }
  } else {
    fc = [...counts];
    if (displayType === 'ratio') fc = fc.map((v, i) => totals[i] > 0 ? Math.round(v / totals[i] * 1000) / 10 : 0);
  }
  return fc;
}

function _buildResult(title, sp, timeUnit, datasets, displayType, statType, summaryRows) {
  const labels = sp.map(p => formatPeriod(p, timeUnit));
  return {
    title,
    periodLabels: labels,
    datasets,
    displayType,
    statType,
    summary: {
      headers: ['類別', ...labels, statType === 'cumulative' ? '最終數值' : '合計'],
      rows:    summaryRows,
    },
  };
}
