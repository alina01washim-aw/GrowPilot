# Automation Rules — Guide (Automation Rules kaise kaam karta hai)

Agar aap sirf operate karna chahte hain to **Section 1** (Quick Start) padhein.
Agar logic samajhna hai to poora document padhein.

---

## 1. Quick Start (operate kaise karein)

1. Dashboard → **Automation Rules** section par jayein.
2. **Load examples** button dabayein → 3 ready-made rules aa jayenge:
   - `Cooling + Mist (heat burst)` — temp + humidity dono zyada ho to AC + Mist chalu
   - `Humidity target (misting)` — humidity kam ho to misting
   - `CO₂ exhaust fan` — CO₂ zyada ho to fan chalu
3. Har rule card ke top par ek **highlighted line** hai jo poora logic English mein batati hai —
   pehle use padhein, phir values apne farm ke hisaab se badlein.
4. Changes ke baad **Save** dabayein. Rule turant ESP32 par publish ho jata hai
   (retained MQTT message) — device ke flash mein store hota hai.
5. **Relay Controls** section mein har device (Fan / AC / Mist / UV) ka
   **AUTO / MANUAL** toggle hai:
   - **AUTO** = rule engine is device ko chala sakta hai
   - **MANUAL** = aap manually ON/OFF karte hain, rules is device ko touch nahi karenge

> Note: "STOP block needs at least 1 cutoff condition" jaisi galti nahi aayegi —
> ab UI mein har block mein kam se kam 1 condition rehti hi hai (delete button
> tab tak band rehta hai jab tak sirf 1 condition ho).

---

## 2. Kaam kaise karta hai (concept)

Har rule teen blocks ka combination hai:

```
┌─────────────────────────────────────────────────────────────┐
│  IF     Temp < 30 AND Humidity < 80        (trigger)         │
│  THEN   Turn ON: AC Compressor, Mist Maker (action)          │
│  STOP   Temp >= 25  →  Release: AC, Mist   (target/cutoff)   │
└─────────────────────────────────────────────────────────────┘
```

### IF block — "kab chalu karna hai"
- Har **5 second** mein ESP32 saare sensors ka data check karta hai.
- `ALL` mode = saari conditions true honi chahiye
  (e.g. `Temp < 30 AND Humidity < 80` — dono).
- `ANY` mode = koi ek bhi true ho to kaafi hai
  (e.g. `Temp > 35 OR CO₂ > 1500` — koi ek bhi).

### THEN block — "kya karna hai"
- `Turn ON` / `Turn OFF` relays ko **group** mein control karta hai —
  ek rule ek saath multiple devices ON kar sakta hai (gang control).
- Sirf selected devices group me hote hain — baaki rules unhe apni taraf se chala sakte hain.

### STOP block — "kab band karna hai" (target reached)
- Jab STOP condition true hoti hai, **Release** wale relays OFF ho jate hain.
- Rule phir se tab tak ON nahi hoga jab tak IF dobara true na ho.
- Ye hi **hysteresis / deadband** hai — ON aur OFF ke thresholds ke beech ka gap.
  Isi gap ki wajah se relay baar-baar flicker nahi karta.

```
Example:  IF Temp < 30  →  AC ON
          STOP Temp >= 25 →  AC OFF

Temp 32°C → AC ON (30 se kam ho gaya... actually: jab temp 30 se upar tha,
engine "Temp < 30" true hone par ON karega — e.g. 29°C par ON, phir 25°C par OFF)
Gap 29 → 25 = 4°C deadband: AC ek baar ON, phir compress hone ke baad OFF.
```

### Dwell timers (seconds)
- **min ON** — group ON hone ke baad minimum itne second ON hi rahega
  (compressor/compressor protection, motor surge se bachane ke liye).
- **min OFF** — group OFF hone ke baad minimum itne second OFF rahega.
- **Cooldown** — ek switch ke baad itne second tak dobara check hi nahi hoga
  (rapid switching rokti hai).

### Priority
- Ek hi device ko do rules control karte hon aur dono alag action maangein,
  to **chhota priority number** jeet-ta hai (0 = sabse zyada important).
- Ye sirf tab matter karta hai jab conflict ho — normal case mein koi conflict nahi hota.

---

## 3. Ye system kahan chalta hai (edge execution)

1. Aap Save karte hain → server validate karke rule ko **MongoDB** mein store karta hai.
2. Server poori rules list ko MQTT par `fridge/rules` topic par publish karta hai
   (**retained** message — naya device connect hote hi latest rules mil jaate hain).
3. ESP32 firmware message parse karke rules ko **flash (NVS)** mein save kar leta hai.
4. Har 5 second mein ESP32 khud rules evaluate karta hai — **WiFi/internet band ho
   jaye, tab bhi automation chalta rahega** (kuki logic device par hi hai).

> Har save/delete par pura set republish hota hai, isliye device kabhi bhi
> purana rule nahi rakhta. Agar aap Relay Controls mein AUTO/MANUAL badalte hain,
> to bhi registry sync ke liye republish hota hai (manual device rule engine
> ke evaluation mein skip ho jata hai — `enabled: false` flag).

---

## 4. Example rules (mushroom farm)

| Rule | IF | THEN | STOP | Use |
|------|----|----|------|-----|
| Cooling + Mist | Temp < 30 AND Humidity < 80 | ON: AC, Mist | Temp >= 25 | garmi + dry me dono on |
| Humidity target | Humidity < 85 | ON: Mist | Humidity >= 95 | pin block humidity |
| CO₂ exhaust | CO₂ > 1200 | ON: Fan | CO₂ < 900 | fresh air / CO₂ control |
| UV disinfection | Time based nahi (sensor only) | — | — | UV sirf manual/priority se |

Sensors available: `Temp (SHT40)`, `Humidity (SHT40)`, `CO₂ (SCD40)`,
`SCD40 Temp`, `SCD40 Hum`, `Compost Temp`.

---

## 5. Common mistakes / troubleshooting

| Problem | Reason | Fix |
|---------|--------|-----|
| `STOP block needs at least 1 cutoff condition` | Cutoffs me koi condition nahi thi (pehle UI me delete ho sakta tha) | Ab UI me last condition delete nahi ho sakti. Ek STOP condition + kam se kam 1 Release relay select karein |
| `THEN block must turn at least one relay ON or OFF` | THEN me koi bhi relay select nahi | Turn ON ya Turn OFF me koi device chunein |
| `STOP block must release at least one relay` | STOP block me condition hai par Release me koi device nahi | Release (STOP ke neeche) me wahi devices chunein jo ON hote hain |
| Device AUTO mode me bhi nahi chalta | Device Relay Controls me MANUAL hai | Relay Controls → device → AUTO par toggle karein |
| Rule save ho gaya par device behave nahi karta | ESP restart hua / MQTT miss hua | Dashboard refresh karein — ESP connect hote hi retained rules mil jaate hain. Firmware ka `fridge/rules` topic check karein |
| Compressor guard (AC) | AC compressor 300s cooldown guard | Control panel me guard countdown dikhta hai — wait karein |
| `rule-not-found` | Rule kisi aur session me delete ho chuka | Page refresh karein |

---

## 7. AI Farm Assistant (chatbot)

Dashboard ke bottom-right par **Bot icon** hai — ye ek mushroom-farm specialist chatbot hai
jo app ko control bhi kar sakta hai:

| Kya kar sakta hai | Example bolen |
|-------------------|---------------|
| Farm analyze kare | "Farm analyze karo, kya theek hai kya nahi" |
| Rule bana de | "Mist on karo jab humidity 85 se kam ho, 95 par band, min on 30 sec" |
| Rule update/delete | "Cooling rule ka STOP 24°C kar do" / "CO2 rule delete karo" |
| Device mode change | "AC ko manual karo" |
| Emergency stop / resume | "Emergency stop" (AI confirm karega) |
| History analysis | "Pichle 24 ghante ka temp trend batao" |

**Setup (ek baar):**
1. `server/.env` mein ye daalein aur server restart karein:
   ```
   AI_API_KEY=sk-...           # OpenAI (ya kisi bhi OpenAI-compatible provider ka key)
   AI_MODEL=gpt-4o-mini        # optional
   AI_BASE_URL=https://api.openai.com/v1   # optional (Azure/OpenRouter/LM Studio etc.)
   ```
2. AI_API_KEY khali hai to bot "AI not configured" notice dikhayega — kaam tabhi
   chalega jab key set ho.

**Note:** AI sirf bataye hue kaam karta hai. Delete / emergency stop se pehle confirm
mangta hai. Jo bhi rule/device change hota hai, dashboard turant refresh ho jata hai.

**Technical:** Chat ek WebSocket connection (`/api/ws/ai`) par chalta hai aur jawab
**token-by-token stream** hota hai — type karte hi answer likhte hue dikhta hai (chunking).
Tool calls bhi live dikhte hain (green chips). Chat history localStorage mein save hoti hai;
aap "Stop" se beech mein rok sakte hain. 

---

## 8. Ek nazar me — blocks vs old-style ranges

Pehle Ideal Ranges the (fixed thresholds). Ab **Automation Rules** unse zyada flexible hain:

| Capability | Old Ranges | Automation Rules |
|-----------|-----------|------------------|
| Multiple sensors ek rule me | ❌ | ✅ (AND/OR) |
| Hysteresis (anti-flicker) | fixed | ✅ har rule me |
| Gang control (multiple relays) | ❌ | ✅ |
| min ON / OFF timers | ❌ | ✅ |
| Edge execution (offline) | ✅ | ✅ |
| Multiple rules with priority | ❌ | ✅ (0 = highest) |

> Ideal Ranges UI ab dashboard se hata di gayi hai — same kaam `Humidity target`
> wale example rule jaisa rule karta hai.
