# Individual Device Control - Step by Step Guide (Hindi + English)

## 🎯 Kaise Use Karein

### Step 1: Device Ka Automation STOP Karna (Band Karna)

**API Call:**
```bash
POST http://localhost:3000/api/relays/fan/stop-automation
Authorization: Bearer YOUR_TOKEN
```

**Browser Console Se (Quick Test):**
```javascript
const token = localStorage.getItem('auth_token');

fetch('http://localhost:3000/api/relays/fan/stop-automation', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
})
.then(r => r.json())
.then(data => {
  console.log('✅ Fan automation stopped!', data);
  // Device: OFF
  // Automation: DISABLED
});
```

**Result:**
- ✅ Fan OFF ho jaayega
- ✅ Automation BAND ho jaayega
- ✅ Temperature/CO2/Humidity kuch bhi ho, fan OFF rahega
- ✅ Jab tak aap manually activate nahi karte

---

### Step 2: Device Ko AUTO MODE Mein Wapas Laana (Activate)

**API Call:**
```bash
POST http://localhost:3000/api/relays/fan/activate-automation
Authorization: Bearer YOUR_TOKEN
```

**Browser Console Se:**
```javascript
const token = localStorage.getItem('auth_token');

fetch('http://localhost:3000/api/relays/fan/activate-automation', {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  }
})
.then(r => r.json())
.then(data => {
  console.log('✅ Fan automation activated!', data);
  // Automation: ENABLED
  // Ab automation wapas control karega
});
```

**Result:**
- ✅ Automation CHALU ho jaayega
- ✅ Fan ko temperature/CO2 ke according control karega
- ✅ Agar CO2 > max → Fan ON
- ✅ Agar CO2 < min → Fan OFF

---

## 📱 Complete Example (All 3 Devices)

### Fan Ko Stop Aur Activate Karna:

```javascript
const token = localStorage.getItem('auth_token');
const baseURL = 'http://localhost:3000/api';

// 1. FAN STOP
fetch(`${baseURL}/relays/fan/stop-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('Fan stopped:', d));

// 2. FAN ACTIVATE (Auto mode mein wapas)
fetch(`${baseURL}/relays/fan/activate-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('Fan activated:', d));
```

### AC/Fridge Ko Stop Aur Activate:

```javascript
// AC STOP
fetch(`${baseURL}/relays/fridge/stop-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('AC stopped:', d));

// AC ACTIVATE
fetch(`${baseURL}/relays/fridge/activate-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('AC activated:', d));
```

### Humidifier Ko Stop Aur Activate:

```javascript
// HUMIDIFIER STOP
fetch(`${baseURL}/relays/humidifier/stop-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('Humidifier stopped:', d));

// HUMIDIFIER ACTIVATE  
fetch(`${baseURL}/relays/humidifier/activate-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(d => console.log('Humidifier activated:', d));
```

---

## 🔍 Status Check Karna

Kisi bhi device ka current status dekhne ke liye:

```javascript
const token = localStorage.getItem('auth_token');

fetch('http://localhost:3000/api/relays', {
  headers: { 'Authorization': `Bearer ${token}` }
})
.then(r => r.json())
.then(relays => {
  relays.forEach(relay => {
    console.log(`${relay.name}:`);
    console.log(`  State: ${relay.state ? 'ON' : 'OFF'}`);
    console.log(`  Automation: ${relay.automationEnabled ? 'ACTIVE ✅' : 'STOPPED 🛑'}`);
    console.log(`  Source: ${relay.source}`);
    console.log('---');
  });
});
```

**Example Output:**
```
fan:
  State: OFF
  Automation: STOPPED 🛑
  Source: manual
---
fridge:
  State: ON
  Automation: ACTIVE ✅
  Source: auto
---
humidifier:
  State: OFF
  Automation: ACTIVE ✅
  Source: auto
---
```

---

## 🎬 Complete Workflow Example

```javascript
const token = localStorage.getItem('auth_token');
const API = 'http://localhost:3000/api';

// Helper function
async function controlDevice(device, action) {
  const url = `${API}/relays/${device}/${action}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}` }
  });
  return response.json();
}

// EXAMPLE 1: Fan ka maintenance
// 1. Stop automation
await controlDevice('fan', 'stop-automation');
console.log('Fan stopped for maintenance');

// ... do maintenance work ...

// 2. Wapas auto mode mein laao
await controlDevice('fan', 'activate-automation');
console.log('Fan back in auto mode');

// EXAMPLE 2: AC temporarily off karna (but automation active rahega)
// Just turn OFF manually
await fetch(`${API}/relays/fridge`, {
  method: 'PATCH',
  headers: {
    'Authorization': `Bearer ${token}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({ state: false })
});
// Automation phir se ON kar sakta hai agar temp > max

// EXAMPLE 3: AC permanently off (automation stop)
await controlDevice('fridge', 'stop-automation');
// Ab AC tab tak OFF rahega jab tak activate na karo
```

---

## 📊 Quick Reference

| Kya Karna Hai | Endpoint | Method |
|---------------|----------|--------|
| **Device ko auto mode se nikaalo** (Stop) | `/relays/:name/stop-automation` | POST |
| **Device ko auto mode mein wapas laao** (Activate) | `/relays/:name/activate-automation` | POST |
| **Manual ON/OFF** | `/relays/:name` | PATCH |
| **Status check** | `/relays` | GET |

Device names: `fan`, `fridge`, `humidifier`

---

## ⚡ Super Quick Commands

Copy-paste these in browser console:

```javascript
const token = localStorage.getItem('auth_token');
const API = 'http://localhost:3000/api';

// STOP FAN AUTOMATION
fetch(`${API}/relays/fan/stop-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
}).then(r => r.json()).then(console.log);

// ACTIVATE FAN AUTOMATION (Auto mode mein wapas)
fetch(`${API}/relays/fan/activate-automation`, {
  method: 'POST',
  headers: { 'Authorization': `Bearer ${token}` }
}).then(r => r.json()).then(console.log);

// CHECK STATUS
fetch(`${API}/relays`, {
  headers: { 'Authorization': `Bearer ${token}` }
}).then(r => r.json()).then(console.log);
```

---

## ✅ Summary

**Auto mode se nikalne ke liye:**
```
POST /api/relays/:name/stop-automation
```

**Auto mode mein wapas laane ke liye:**
```
POST /api/relays/:name/activate-automation
```

Simple! 🚀
