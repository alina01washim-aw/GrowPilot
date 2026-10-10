# Individual Device Stop/Activate Feature - Implementation Plan

## 🎯 Feature Request

Aapko har device (Fan, AC, Humidifier) ke liye alag-alag control chahiye:

### Current Status: ❌ NOT IMPLEMENTED
**This feature does NOT exist in the current codebase.**

---

## 📋 Required Feature

### For Each Device (Fan, AC/Compressor, Humidifier):

#### Stop Button:
- Device ko OFF kar de
- Us device ka automation DISABLE ho jaaye
- Tab tak OFF rahe jab tak "Activate" na click karo
- Baaki devices ka automation normal chale

#### Activate Button:
- Us device ka automation ENABLE ho jaaye
- Device ko automation control kare (temperature/humidity/CO2 ke according)

---

## 🔧 Implementation Required

### 1. Database Schema Change
**File:** `server/src/models/relay.ts`

Add new field to track if automation is enabled for each relay:

```typescript
const relaySchema = new Schema({
  name: { type: String, required: true, unique: true, enum: RELAY_NAMES },
  state: { type: Boolean, required: true, default: false },
  updatedAt: { type: Date, required: true, default: () => new Date() },
  guardedUntil: { type: Date, default: null },
  source: { type: String, enum: ["manual", "auto"], default: "manual" },
  
  // NEW FIELD - Track if automation is enabled for this relay
  automationEnabled: { type: Boolean, required: true, default: true },
});
```

---

### 2. Update Automation Logic
**File:** `server/src/lib/mqttClient.ts`

Modify `runAutomation` to check if automation is enabled for each relay:

```typescript
async function runAutomation(data: IncomingPayload) {
  if (await isAutomationPaused()) {
    logger.debug("Automation skipped — emergency stop active");
    return;
  }

  const s = await getSettings();
  
  // Get relay documents to check automationEnabled flag
  const relayDocs = await RelayModel.find(
    { name: { $in: ["fan", "fridge", "humidifier"] } }
  ).lean();

  const desired: Array<{ 
    name: "fan" | "fridge" | "humidifier"; 
    on: boolean | null;
    automationEnabled: boolean;
  }> = [
    {
      name: "fridge",
      on: data.t > s.tempMax ? true : data.t < s.tempMin ? false : null,
      automationEnabled: relayDocs.find(r => r.name === "fridge")?.automationEnabled ?? true,
    },
    {
      name: "fan",
      on: data.c > s.co2Max ? true : data.c < s.co2Min ? false : null,
      automationEnabled: relayDocs.find(r => r.name === "fan")?.automationEnabled ?? true,
    },
    {
      name: "humidifier",
      on: data.h < s.humidityMin ? true : data.h > s.humidityMax ? false : null,
      automationEnabled: relayDocs.find(r => r.name === "humidifier")?.automationEnabled ?? true,
    },
  ];

  for (const { name, on, automationEnabled } of desired) {
    // Skip if automation is disabled for this specific relay
    if (!automationEnabled) {
      logger.debug({ name }, "Automation skipped for this relay - manually stopped");
      continue;
    }
    
    if (on === null) continue; // reading in-band

    try {
      const relay = await setRelayState(name, on, "auto");
      publishRelayCommand(name, relay.state);
    } catch (err) {
      if (err instanceof RelayGuardedError) {
        logger.warn({ name, guardedUntil: err.guardedUntil }, "Automation blocked by safety guard");
      } else {
        logger.error({ err, name }, "Automation failed to set relay state");
      }
    }
  }
}
```

---

### 3. Add New API Endpoints
**File:** `server/src/routes/relays.ts`

Add endpoints to stop/activate individual device automation:

```typescript
// Stop automation for specific relay
router.post("/relays/:name/stop-automation", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

  if (!raw || !isRelayName(raw)) {
    res.status(400).json({ error: `Unknown relay name: ${String(raw)}` });
    return;
  }

  try {
    // Turn OFF the relay
    const relay = await setRelayState(raw, false, "manual");
    publishRelayCommand(raw, false);
    
    // Disable automation for this relay
    const updated = await RelayModel.findOneAndUpdate(
      { name: raw },
      { $set: { automationEnabled: false, updatedAt: new Date() } },
      { new: true }
    ).lean();

    res.json({
      ok: true,
      relay: serializeRelay({
        name: updated!.name,
        state: updated!.state,
        updatedAt: updated!.updatedAt,
        guardedUntil: updated!.guardedUntil ?? null,
        source: updated!.source ?? "manual",
      }),
      automationEnabled: false,
    });
  } catch (err) {
    throw err;
  }
});

// Activate automation for specific relay
router.post("/relays/:name/activate-automation", async (req, res): Promise<void> => {
  const raw = Array.isArray(req.params.name) ? req.params.name[0] : req.params.name;

  if (!raw || !isRelayName(raw)) {
    res.status(400).json({ error: `Unknown relay name: ${String(raw)}` });
    return;
  }

  try {
    // Enable automation for this relay
    const updated = await RelayModel.findOneAndUpdate(
      { name: raw },
      { $set: { automationEnabled: true, updatedAt: new Date() } },
      { new: true }
    ).lean();

    res.json({
      ok: true,
      relay: serializeRelay({
        name: updated!.name,
        state: updated!.state,
        updatedAt: updated!.updatedAt,
        guardedUntil: updated!.guardedUntil ?? null,
        source: updated!.source ?? "manual",
      }),
      automationEnabled: true,
    });
  } catch (err) {
    throw err;
  }
});
```

---

### 4. Update GET /relays Endpoint
Include `automationEnabled` in the response:

```typescript
function serializeRelay(relay: {
  name: string;
  state: boolean;
  updatedAt: Date;
  guardedUntil: Date | null;
  source: string;
  automationEnabled?: boolean; // Add this
}) {
  return {
    name: relay.name as "fan" | "fridge" | "humidifier",
    state: relay.state,
    updatedAt: relay.updatedAt.toISOString(),
    guardedUntil: relay.guardedUntil ? relay.guardedUntil.toISOString() : null,
    source: relay.source as "manual" | "auto",
    automationEnabled: relay.automationEnabled ?? true, // Add this
  };
}
```

---

### 5. Update Relay Initialization
**File:** `server/src/lib/relayControl.ts`

```typescript
export async function ensureRelaysInitialized(): Promise<void> {
  await Promise.all(
    RELAY_NAMES.map((name) =>
      RelayModel.updateOne(
        { name },
        { 
          $setOnInsert: { 
            name, 
            state: false, 
            updatedAt: new Date(),
            automationEnabled: true, // Add this default
          } 
        },
        { upsert: true },
      ),
    ),
  );
}
```

---

## 📱 Frontend Integration (Client Side)

Update the UI to show Stop/Activate buttons for each device:

```typescript
// Example UI structure needed
<DeviceCard name="Fan">
  <StatusBadge state={relay.state} />
  <AutomationBadge enabled={relay.automationEnabled} />
  
  {relay.automationEnabled ? (
    <Button onClick={() => stopDeviceAutomation('fan')}>
      Stop Automation
    </Button>
  ) : (
    <Button onClick={() => activateDeviceAutomation('fan')}>
      Activate Automation
    </Button>
  )}
  
  <Button onClick={() => toggleRelay('fan', !relay.state)}>
    Turn {relay.state ? 'OFF' : 'ON'}
  </Button>
</DeviceCard>
```

---

## 🔄 API Usage Examples

### Stop Automation for Fan
```bash
POST /api/relays/fan/stop-automation
Authorization: Bearer <token>

Response:
{
  "ok": true,
  "relay": {
    "name": "fan",
    "state": false,
    "automationEnabled": false,
    ...
  }
}
```

### Activate Automation for Fan
```bash
POST /api/relays/fan/activate-automation
Authorization: Bearer <token>

Response:
{
  "ok": true,
  "relay": {
    "name": "fan",
    "state": false,
    "automationEnabled": true,
    ...
  }
}
```

### Check Current Status
```bash
GET /api/relays

Response:
[
  {
    "name": "fan",
    "state": false,
    "automationEnabled": true,  // ← Automation is ON
    ...
  },
  {
    "name": "fridge",
    "state": true,
    "automationEnabled": false, // ← Automation is OFF (manually stopped)
    ...
  },
  {
    "name": "humidifier",
    "state": false,
    "automationEnabled": true,  // ← Automation is ON
    ...
  }
]
```

---

## 🎬 User Experience Flow

### Example: Stop Fan Automation

1. User clicks "Stop" button for Fan
2. API call: `POST /api/relays/fan/stop-automation`
3. System:
   - Turns Fan OFF immediately
   - Sets `automationEnabled: false` for Fan
   - Saves to database
4. Result:
   - Fan stays OFF
   - Automation does NOT control Fan anymore
   - AC and Humidifier automation still works normally

### Example: Activate Fan Automation

1. User clicks "Activate" button for Fan
2. API call: `POST /api/relays/fan/activate-automation`
3. System:
   - Sets `automationEnabled: true` for Fan
   - Saves to database
4. Result:
   - Fan automation resumes
   - Next sensor reading will control Fan based on CO2 levels
   - Fan turns ON if CO2 > max, OFF if CO2 < min

---

## 🆚 Comparison

### Emergency Stop (All) vs Individual Stop

| Feature | Emergency Stop | Individual Stop |
|---------|---------------|-----------------|
| Scope | All devices | One device at a time |
| Fan | ❌ OFF, No automation | Your choice |
| AC | ❌ OFF, No automation | Your choice |
| Humidifier | ❌ OFF, No automation | Your choice |
| Use Case | Complete shutdown | Maintenance on one device |
| Resume | One button for all | Separate button per device |

---

## ⚠️ Implementation Status

**Current Status:** ❌ **NOT IMPLEMENTED**

This feature requires:
1. Database schema migration (add `automationEnabled` field)
2. Backend API endpoints (stop/activate per relay)
3. Automation logic update (check `automationEnabled` flag)
4. Frontend UI changes (add Stop/Activate buttons)

**Estimated Effort:** 2-3 hours of development + testing

---

## 🚀 Would you like me to implement this feature?

Main ye feature implement kar sakta hoon. Ye bataye:
1. Kya aapko ye feature chahiye?
2. Kya main ab code likhun?
