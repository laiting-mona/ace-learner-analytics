# Security Model

## Overview

The system handles university personnel data (names, emails, institutional affiliations) and requires access control that goes beyond simple "share with anyone." The security model is designed around three principles:

1. **Defense in depth** — multiple independent checks, not a single gate
2. **Fail closed** — any error in auth defaults to rejection, not access
3. **Auditability** — every access attempt is logged with timestamp and outcome

## Authentication Flow

```
1. Page load
   └─ Frontend calls auth-check
       └─ Backend: always returns { allowed: true }
          (whitelist check is enforced at login step instead)

2. User enters password
   └─ Frontend calls login({ password })
       ├─ Check lockout status (CacheService key: p_lock_{email})
       │   └─ If locked: return error with remaining minutes
       ├─ Compare password against CONFIG.WEB_PASSWORD
       │   └─ If wrong:
       │       ├─ Increment attempt counter (p_att_{email})
       │       └─ If counter >= PW_MAX_ATTEMPTS:
       │           ├─ Set lockout (p_lock_{email}, TTL = PW_LOCKOUT_SEC)
       │           └─ Clear attempt counter
       └─ If correct:
           ├─ Clear attempt counter
           ├─ Generate HMAC-SHA256 token (48-char hex)
           ├─ Store token (p_sess_{token}, TTL = SESSION_TTL + 60s)
           └─ Return { success, token, expiresIn, timeOptions, labels }

3. Subsequent API calls
   └─ Frontend attaches token to every request payload
       └─ _verifySession(token, email):
           ├─ Lookup p_sess_{token} in CacheService
           ├─ Parse stored { email, created }
           ├─ Verify email matches
           ├─ Verify age < SESSION_TTL
           └─ Return { ok: true } or { ok: false, reason }
```

## Rate Limiting

Rate limiting uses a sliding window keyed by user and hour bucket:

```
key = "rl_" + email + "_" + floor(timestamp / RATE_LIMIT_WIN)
```

On each authenticated request:
1. Read current count from CacheService
2. If count >= `RATE_LIMIT_MAX` (120): reject with error
3. Otherwise: increment count and proceed

The window resets automatically when the hour bucket changes (no explicit reset needed).

## Session Token Design

Tokens are generated using HMAC-SHA256:

```javascript
Utilities.computeHmacSha256Signature(
  String(Date.now()) + Math.random(),  // nonce
  'ace_salt_' + CONFIG.WEB_PASSWORD    // signing key
)
→ first 48 hex characters
```

Entropy: ~192 bits (48 hex chars). The signing key includes the current password, so changing `WEB_PASSWORD` implicitly invalidates existing tokens (they will fail signature-based regeneration on the next verification attempt — actually, tokens are looked up by value in CacheService, so they remain valid until they expire or are explicitly deleted).

**To immediately invalidate all sessions** without waiting for TTL expiration, clear the script cache:

```javascript
// Run from GAS editor
CacheService.getScriptCache().removeAll([]);
```

## Storage: CacheService vs PropertiesService

All auth state (sessions, lockout timers, attempt counters) uses `CacheService` rather than `PropertiesService`.

**Why:** When the Web App is deployed with "Execute as: Owner", all executions share the same script identity. `PropertiesService.getUserProperties()` scopes to the executing user — which is always the owner — so it cannot maintain per-user state. `CacheService.getScriptCache()` is shared across all executions, making it suitable for per-user state when keys are namespaced by user identifier.

**Trade-off:** `CacheService` is ephemeral (max 6-hour TTL, eviction possible under memory pressure). This means lockout timers and session tokens could theoretically be evicted before they expire. For a low-traffic university internal tool, this risk is accepted. A production system with stricter requirements should use a persistent store.

## Audit Log

Every `handleRequest` call writes a row to the `系統日誌` sheet:

| Column | Content |
|--------|---------|
| Timestamp | `yyyy-MM-dd HH:mm:ss` (Asia/Taipei) |
| User | `email` (fixed as `'user'` in Owner execution mode) |
| Action | `auth-check`, `login`, `chart`, etc. |
| Status | `OK`, `WRONG_PW:attempt_N`, `LOCKOUT_TRIGGERED`, `RATE_LIMITED`, `REJECTED:session_expired`, etc. |

The log sheet is auto-created with headers on the first write if it does not exist.

## What This Model Does NOT Protect Against

- **Shared passwords**: if an authorized user shares the password, the system has no way to detect or prevent this
- **Token theft via XSS**: the session token is stored in a JS variable; a successful XSS attack in the Sites iframe could extract it
- **Replay attacks within the TTL window**: tokens are bearer tokens with no per-request binding
- **Data exfiltration after login**: once authenticated, users can export all chart data as PDF or ZIP; there is no download logging

These are acceptable trade-offs for an internal university analytics tool. For higher-sensitivity use cases, additional controls (OAuth 2.0, per-request HMAC signatures, download logging) would be appropriate.
