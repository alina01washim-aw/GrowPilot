# Bug Report - Mushroom Farm Control System

**Analysis Date:** 2026-07-12  
**Severity Levels:** 🔴 Critical | 🟠 High | 🟡 Medium | 🟢 Low

---

## 🔴 CRITICAL BUGS

### 1. Security: Hardcoded Credentials in Source Files
**File:** `mockesp/mock_esp32.js` (Lines 21-23)  
**Issue:** MQTT broker credentials are hardcoded in the source code instead of using environment variables.

```javascript
const client = mqtt.connect("mqtt://75.119.133.7:1883", {
  username: "WRzhrAShevGFcn6g",
  password: "FXUFBy1U9dUXzWQJm4uebwF95Ao18NLI",
});
```

**Impact:** Security vulnerability - credentials exposed in source control  
**Fix:** Use environment variables for all credentials

---

### 2. Security: JWT Secret Not Sufficiently Random
**File:** `server/.env` (Line 2)  
**Issue:** JWT_SECRET uses a predictable pattern instead of a cryptographically random string

```
JWT_SECRET='Mushking@20#26@2001'
```

**Impact:** Token forgery risk if pattern is discovered  
**Fix:** Use cryptographically secure random string (minimum 32 bytes)

---

### 3. VPD Calculation - No Input Validation
**File:** `server/src/lib/vpd.ts` (Lines 11-17)  
**Issue:** Function doesn't validate inputs, can produce NaN/Infinity with invalid data

```typescript
export function calculateVpd(tempC: number, rh: number): number {
  const svp = 0.61078 * Math.exp((17.27 * tempC) / (tempC + 237.3));
  const avp = svp * (rh / 100);
  const vpd = svp - avp;
  return Math.round(vpd * 1000) / 1000;
}
```

**Impact:** Invalid sensor data could corrupt database with NaN values  
**Fix:** Add input validation and bounds checking

---

## 🟠 HIGH PRIORITY BUGS

### 4. Emergency Stop - No Guard Error Handling
**File:** `server/src/lib/emergencyStop.ts` (Lines 7-19)  
**Issue:** Emergency stop doesn't catch RelayGuardedError, could fail silently

```typescript
for (const name of RELAY_NAMES) {
  const relay = await setRelayState(name, false, "manual");
  publishRelayCommand(name, false);
  results.push(relay);
}
```

**Impact:** Emergency stop might not turn off all devices if one is guarded  
**Fix:** Add try-catch to handle guarded relays gracefully

---

### 5. Date Validation in Readings Route
**File:** `server/src/routes/readings.ts` (Lines 38-54)  
**Issue:** Invalid date strings are silently ignored instead of returning error

```typescript
const date = new Date(value);
if (!Number.isNaN(date.getTime())) {
  coerced[key] = date;
}
```

**Impact:** API accepts invalid dates without feedback  
**Fix:** Return 400 error for invalid date formats

---

### 6. MQTT Client - No Reconnection Logging
**File:** `server/src/lib/mqttClient.ts` (Lines 198-200)  
**Issue:** MQTT errors logged but no visibility into reconnection attempts

**Impact:** Difficult to debug connection issues  
**Fix:** Add more detailed logging for reconnection events

---

## 🟡 MEDIUM PRIORITY BUGS

### 7. Automation Cache - Potential Stale Data
**File:** `server/src/lib/automationControl.ts` (Lines 3-5)  
**Issue:** 5-second cache could serve stale data during critical state changes

```typescript
const CACHE_TTL_MS = 5_000;
let cachedPaused: boolean | null = null;
let cacheExpiry = 0;
```

**Impact:** Automation could run for up to 5 seconds after emergency stop  
**Fix:** Invalidate cache on emergency stop/resume

---

### 8. Settings Update - No Atomic Validation
**File:** `server/src/lib/settingsControl.ts` (Lines 84-114)  
**Issue:** Settings are validated after merge but before DB update (TOCTOU)

**Impact:** Race condition between validation and database write  
**Fix:** Use MongoDB transaction or single atomic update with validation

---

### 9. Relay Control - Retry Logic Missing
**File:** `server/src/lib/relayControl.ts` (Lines 135-142)  
**Issue:** Single retry on guard expiry race, but could still fail

**Impact:** Legitimate relay commands might fail unnecessarily  
**Fix:** Implement exponential backoff retry mechanism

---

### 10. MQTT Message Chain - No Error Recovery
**File:** `server/src/lib/mqttClient.ts` (Lines 190-196)  
**Issue:** If message handling fails, chain continues but error only logged

```typescript
messageChain = messageChain
  .then(() => handleMessage(topic, message))
  .catch((err) => {
    logger.error({ err }, "Unhandled error in MQTT message handler");
  });
```

**Impact:** Errors don't stop automation, could cause cascading failures  
**Fix:** Implement circuit breaker pattern

---

## 🟢 LOW PRIORITY BUGS

### 11. Reading Model - No Index on Timestamp
**File:** `server/src/models/reading.ts`  
**Issue:** Missing database index on timestamp field for efficient queries

**Impact:** Slow queries as data grows  
**Fix:** Add index to reading schema

---

### 12. Missing Type Guards in Relay Routes
**File:** `server/src/routes/relays.ts` (Line 37-38)  
**Issue:** Array check for params.name is redundant in Express 5

**Impact:** Dead code, minor performance overhead  
**Fix:** Simplify to direct string check

---

### 13. Hardcoded Batch ID
**File:** `server/src/lib/mqttClient.ts` (Line 18)  
**Issue:** DEFAULT_BATCH_ID falls back to hardcoded string

**Impact:** Cannot easily switch between mushroom batches  
**Fix:** Make batch ID configurable via API

---

### 14. No Health Check for MQTT Connection
**File:** `server/src/routes/health.ts`  
**Issue:** Health endpoint doesn't verify MQTT broker connectivity

**Impact:** System appears healthy even when IoT communication is down  
**Fix:** Add MQTT connection status to health check

---

### 15. Auth Middleware - No Rate Limiting
**File:** `server/src/middleware/requireAuth.ts`  
**Issue:** No protection against brute force token attacks

**Impact:** Vulnerable to token brute forcing  
**Fix:** Implement rate limiting middleware

---

## Summary

- **Critical:** 3 bugs (Security & Data Integrity)
- **High:** 3 bugs (Error Handling & Validation)
- **Medium:** 4 bugs (Race Conditions & Performance)
- **Low:** 5 bugs (Optimization & Features)

**Total:** 15 bugs identified

**Recommended Fix Order:**
1. Fix security issues (Bugs #1, #2)
2. Add VPD validation (Bug #3)
3. Fix emergency stop error handling (Bug #4)
4. Implement remaining high-priority fixes
5. Address medium and low priority issues


