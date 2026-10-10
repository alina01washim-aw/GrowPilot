# Emergency Stop Behavior - Complete Guide

## 🛑 How Emergency Stop Works

### Current Implementation Status: ✅ CORRECT (Toggle/Persistent Mode)

---

## Behavior Overview

### When Emergency Stop is ACTIVATED:
1. ✅ **All Relays Turn OFF Immediately**
   - Fan → OFF
   - AC/Fridge → OFF  
   - Humidifier → OFF

2. ✅ **Automation COMPLETELY STOPS**
   - Does NOT check temperature
   - Does NOT check humidity
   - Does NOT check CO2
   - Does NOT control any relays

3. ✅ **State is PERSISTENT (Saved in Database)**
   - Server restart → Emergency stop remains ACTIVE
   - Power loss → Emergency stop remains ACTIVE when system restarts
   - Application close → Emergency stop remains ACTIVE

4. ✅ **Stays Stopped UNTIL Manual Resume**
   - Will NOT auto-resume
   - Will NOT resume after time delay
   - Only resumes when user clicks "Resume Automation"

---

## Code Verification

### 1. Persistent Storage (Database)
**File:** `server/src/lib/automationControl.ts`

```typescript
export async function setAutomationPaused(paused: boolean): Promise<void> {
  await SettingsModel.findByIdAndUpdate(
    "default",
    {
      $set: { automationPaused: paused, updatedAt: new Date() },
      $setOnInsert: { _id: "default" },
    },
    { upsert: true }, // ← Saves to MongoDB database
  );
  cachedPaused = paused;
  cacheExpiry = Date.now() + CACHE_TTL_MS;
}
```

**Result:** Emergency stop state is saved in MongoDB and survives restarts ✅

---

### 2. Automation Completely Stops
**File:** `server/src/lib/mqttClient.ts`

```typescript
async function runAutomation(data: IncomingPayload) {
  if (await isAutomationPaused()) {
    logger.debug("Automation skipped — emergency stop active");
    return; // ← Exits immediately, NO checks happen
  }

  // Temperature, humidity, CO2 checks only run if NOT paused
  const s = await getSettings();
  // ... automation logic ...
}
```

**Result:** When paused, automation does NOTHING (no temp/humidity/CO2 checks) ✅

---

### 3. Manual Resume Only
**File:** `server/src/routes/system.ts`

```typescript
// Emergency Stop Endpoint
router.post("/system/emergency-stop", async (_req, res): Promise<void> => {
  const relays = await emergencyStopAll();
  res.json({
    ok: true,
    automationPaused: true, // ← Sets to TRUE
    relays: relays.map(serializeRelay),
  });
});

// Resume Endpoint (separate, requires explicit call)
router.post("/system/resume-automation", async (_req, res): Promise<void> => {
  await resumeAutomation();
  res.json({ automationPaused: false }); // ← Sets to FALSE
});
```

**Result:** Two separate endpoints - no auto-resume logic ✅

---

## User Flow

### Scenario 1: Normal Operation
```
Sensor Reading → Check Temp/Humidity/CO2 → Control Relays
     ↓                    ↓                       ↓
  22°C, 90%, 800ppm  → All in range        → No changes
```

### Scenario 2: Emergency Stop Activated
```
1. User clicks "Emergency Stop" button
2. System immediately:
   ✅ Turns OFF all relays (Fan, AC, Humidifier)
   ✅ Sets automationPaused = true in database
   ✅ Invalidates cache for instant effect

3. From this point onwards:
   ❌ Sensor readings still received BUT
   ❌ NO temperature checks
   ❌ NO humidity checks
   ❌ NO CO2 checks
   ❌ NO relay control
   
4. State persists through:
   ✅ Server restart
   ✅ System reboot
   ✅ Power failure
   ✅ Application closure
```

### Scenario 3: Resume Automation
```
1. User clicks "Resume Automation" button
2. System:
   ✅ Sets automationPaused = false in database
   ✅ Invalidates cache for instant effect
   
3. Next sensor reading:
   ✅ Automation checks resume
   ✅ Relays controlled based on thresholds
```

---

## API Endpoints

### Check Emergency Stop Status
```bash
GET /api/system/status

Response:
{
  "automationPaused": true  # or false
}
```

### Activate Emergency Stop
```bash
POST /api/system/emergency-stop
Authorization: Bearer <token>

Response:
{
  "ok": true,
  "automationPaused": true,
  "relays": [
    { "name": "fan", "state": false, ... },
    { "name": "fridge", "state": false, ... },
    { "name": "humidifier", "state": false, ... }
  ]
}
```

### Resume Automation
```bash
POST /api/system/resume-automation
Authorization: Bearer <token>

Response:
{
  "automationPaused": false
}
```

---

## Database Schema

**Collection:** `settings`  
**Document ID:** `"default"`

```javascript
{
  _id: "default",
  automationPaused: true,  // ← Emergency stop state
  tempMin: 21,
  tempMax: 23,
  co2Min: 700,
  co2Max: 1200,
  humidityMin: 85,
  humidityMax: 95,
  updatedAt: ISODate("2026-07-12T06:55:31.000Z")
}
```

---

## Testing the Toggle Behavior

### Test 1: Activate and Verify Persistence
```bash
# 1. Activate emergency stop
curl -X POST http://localhost:3000/api/system/emergency-stop \
  -H "Authorization: Bearer YOUR_TOKEN"

# 2. Check status
curl http://localhost:3000/api/system/status \
  -H "Authorization: Bearer YOUR_TOKEN"
# Should return: {"automationPaused": true}

# 3. Restart the server
# Stop server with Ctrl+C
# Start server again with npm run dev

# 4. Check status again (should STILL be paused)
curl http://localhost:3000/api/system/status \
  -H "Authorization: Bearer YOUR_TOKEN"
# Should STILL return: {"automationPaused": true}
```

### Test 2: Verify Automation Stops
```bash
# 1. Activate emergency stop
curl -X POST http://localhost:3000/api/system/emergency-stop \
  -H "Authorization: Bearer YOUR_TOKEN"

# 2. Send sensor data via MQTT
mosquitto_pub -h 75.119.133.7 -u WRzhrAShevGFcn6g \
  -P FXUFBy1U9dUXzWQJm4uebwF95Ao18NLI \
  -t fridge/sensors \
  -m '{"t": 30, "h": 50, "c": 1500}'
# Even with extreme values, relays should NOT change

# 3. Check server logs
# Should see: "Automation skipped — emergency stop active"
```

### Test 3: Manual Resume
```bash
# 1. Resume automation
curl -X POST http://localhost:3000/api/system/resume-automation \
  -H "Authorization: Bearer YOUR_TOKEN"

# 2. Check status
curl http://localhost:3000/api/system/status \
  -H "Authorization: Bearer YOUR_TOKEN"
# Should return: {"automationPaused": false}

# 3. Send sensor data - automation should work again
```

---

## Important Notes

### ✅ What Emergency Stop DOES:
- Immediately turns OFF all relays
- Stops ALL automation logic
- Saves state permanently in database
- Requires manual resume to restart
- Works like a safety KILL SWITCH

### ❌ What Emergency Stop DOES NOT Do:
- Does NOT auto-resume
- Does NOT resume after timeout
- Does NOT allow partial automation
- Does NOT check sensors while paused

---

## Conclusion

**The Emergency Stop is already implemented as a PERSISTENT TOGGLE:**
- ✅ Single click activates
- ✅ Stays active permanently
- ✅ Survives server restarts
- ✅ Only deactivates when you manually click "Resume"
- ✅ Completely stops all automation (no temp/humidity/CO2 checks)

This is exactly the behavior you described - emergency stop ke baad system completely band ho jata hai aur jab tak aap manually resume nahi karte, tab tak kuch nahi hota!
