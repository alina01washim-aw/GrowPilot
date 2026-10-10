# Testing Individual Device Control Feature

## ⚠️ IMPORTANT: Difference Between Buttons

### Current "Stop" Button (Wrong - Just turns OFF)
```bash
# This only turns the device OFF but automation is STILL ENABLED
PATCH /api/relays/:name
Body: { "state": false }
```
**Problem:** Device turns OFF, but automation can turn it back ON!

### NEW "Stop Automation" Button (Correct - Disables automation)
```bash
# This turns OFF + DISABLES automation
POST /api/relays/:name/stop-automation
```
**Result:** Device stays OFF until you click "Activate"

---

## 🧪 Test the New Feature

### Step 1: Check Current Relay Status
```bash
curl http://localhost:3000/api/relays \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response:**
```json
[
  {
    "name": "fan",
    "state": false,
    "automationEnabled": true,  // ← Automation is ON
    "source": "manual",
    ...
  }
]
```

### Step 2: Stop Automation for Fan (NEW ENDPOINT)
```bash
curl -X POST http://localhost:3000/api/relays/fan/stop-automation \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response:**
```json
{
  "ok": true,
  "relay": {
    "name": "fan",
    "state": false,           // ← Device is OFF
    "automationEnabled": false,  // ← Automation is DISABLED
    "source": "manual"
  },
  "message": "Automation stopped for fan"
}
```

### Step 3: Verify Automation is Stopped
Wait for sensor data to come in (high CO2, high temp, etc.)

**Expected:** Fan stays OFF even if CO2 > max

**Check logs:** Should see:
```
"Automation skipped for this relay — manually stopped"
```

### Step 4: Activate Automation (NEW ENDPOINT)
```bash
curl -X POST http://localhost:3000/api/relays/fan/activate-automation \
  -H "Authorization: Bearer YOUR_TOKEN"
```

**Expected Response:**
```json
{
  "ok": true,
  "relay": {
    "name": "fan",
    "state": false,
    "automationEnabled": true,  // ← Automation is RE-ENABLED
    "source": "manual"
  },
  "message": "Automation activated for fan"
}
```

### Step 5: Verify Automation Resumed
Wait for next sensor reading with high CO2

**Expected:** Fan turns ON automatically

---

## 🔧 Frontend Integration Required

The **frontend needs to be updated** to use the new endpoints!

### Current Frontend Code (WRONG):
```typescript
// This just turns device OFF
// Automation can turn it back ON!
async function stopDevice(name: string) {
  await fetch(`/api/relays/${name}`, {
    method: 'PATCH',
    body: JSON.stringify({ state: false })
  });
}
```

### Updated Frontend Code (CORRECT):
```typescript
// Stop automation endpoint
async function stopDeviceAutomation(name: string) {
  await fetch(`/api/relays/${name}/stop-automation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
}

// Activate automation endpoint  
async function activateDeviceAutomation(name: string) {
  await fetch(`/api/relays/${name}/activate-automation`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    }
  });
}
```

### UI Component Example:
```tsx
<DeviceCard>
  <h3>{relay.name}</h3>
  <p>Status: {relay.state ? 'ON' : 'OFF'}</p>
  <p>Automation: {relay.automationEnabled ? 'ACTIVE' : 'STOPPED'}</p>
  
  {relay.automationEnabled ? (
    <Button onClick={() => stopDeviceAutomation(relay.name)}>
      🛑 Stop Automation
    </Button>
  ) : (
    <Button onClick={() => activateDeviceAutomation(relay.name)}>
      ✅ Activate Automation
    </Button>
  )}
  
  {/* Manual ON/OFF control */}
  <Button onClick={() => toggleRelay(relay.name, !relay.state)}>
    Turn {relay.state ? 'OFF' : 'ON'}
  </Button>
</DeviceCard>
```

---

## 📊 Comparison Table

| Action | Endpoint | Device State | Automation | Effect |
|--------|----------|--------------|------------|---------|
| **Manual OFF** | `PATCH /relays/:name` | OFF | ✅ Still enabled | Automation can turn it back ON |
| **Stop Automation** | `POST /relays/:name/stop-automation` | OFF | ❌ Disabled | Stays OFF until "Activate" |
| **Activate** | `POST /relays/:name/activate-automation` | No change | ✅ Enabled | Automation controls it again |

---

## 🎯 Solution for Your Problem

**Problem:** "Single stop ko temperature co2 or humidity effect kr raha hain"

**Root Cause:** Frontend is calling wrong endpoint

**Solution:**
1. ✅ Backend is ready (we just implemented it)
2. ❌ Frontend needs to be updated to call:
   - `POST /api/relays/:name/stop-automation` instead of `PATCH /api/relays/:name`
   - `POST /api/relays/:name/activate-automation` to resume

---

## 🧪 Quick Test in Browser Console

Open your dashboard and run in browser console:

```javascript
// Get current token from localStorage
const token = localStorage.getItem('auth_token');

// Stop Fan automation
fetch('http://localhost:3000/api/relays/fan/stop-automation', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
}).then(r => r.json()).then(console.log);

// Wait 30 seconds for sensor data...
// Fan should stay OFF even with high CO2

// Activate Fan automation
fetch('http://localhost:3000/api/relays/fan/activate-automation', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
}).then(r => r.json()).then(console.log);

// Fan should start working with automation again
```

---

## ✅ Checklist

- [x] Backend: Database schema updated
- [x] Backend: Automation logic updated  
- [x] Backend: API endpoints created
- [ ] **Frontend: Update button to call new endpoint**
- [ ] **Frontend: Show automation status**
- [ ] **Frontend: Add Activate button**

**The backend is 100% ready. Frontend needs to be updated to use the new endpoints!**
