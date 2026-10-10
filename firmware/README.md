# Mushking IoT ESP32 Firmware

Production C++ firmware for the Mushroom Farm Control system. Replaces `mockesp/mock_esp32.js` with real hardware.

## Hardware wiring (your ESP32 + relay module)

Matches the annotated breadboard setup:

```
Relay module          ESP32 pin       Device
────────────────────────────────────────────
IN1                   G18 (GPIO 18)   Exhaust Fan
IN2                   G17 (GPIO 17)   AC Compressor
IN3                   G23 (GPIO 23)   Mist Maker
IN4                   G5  (GPIO 5)    UV-C Light
GND                   GND             Common ground
VCC                   5V (VIN pin)    Relay logic power
```

**SCD40 sensor** (add when ready — not in current photos):

| SCD40 | ESP32 |
|-------|-------|
| SDA | G21 |
| SCL | G22 |
| VDD | 3V3 |
| GND | GND |

**Important:** `IN1` must wire to **G18**, not G23. G23 is only for `IN3` (Mist Maker).

**Relay logic:** Active LOW — firmware sets all GPIOs **HIGH at boot** (relays OFF).

**JD-VCC jumper:** Keep the yellow cap on VCC/JD-VCC if powering relay coils from the same 5V supply.

## MQTT Protocol (matches Node.js backend)

| Topic | Direction | Format |
|-------|-----------|--------|
| `fridge/sensors` | Publish | `{"t":22.5,"h":88.2,"c":920,"r":[0,1,0,0]}` |
| `fridge/commands` | Subscribe | `FAN_ON` / `AC_OFF` / `MIST_ON` (backend) **or** `{"r1":1,"r2":0}` (JSON override) |
| `fridge/config` | Subscribe | Retained thresholds from dashboard |
| `fridge/status` | LWT | `offline` on disconnect, `online` on connect |

### Delta reporting (MongoDB optimization)

Publishes only when:
- Temperature changes by **> 0.2°C**
- Humidity changes by **> 1.0%**
- CO₂ changes by **> 25 ppm**
- Relay state changes
- **120 s heartbeat** if no delta

Sensor is **sampled every 5 s** (non-blocking `millis()` timers).

## Setup

### 1. Install PlatformIO

- [VS Code + PlatformIO extension](https://platformio.org/install/ide?install=vscode), or
- `pip install platformio`

### 2. Configure credentials

```bash
cd firmware
cp include/secrets.h.example include/secrets.h
```

Edit `include/secrets.h`:

```cpp
static constexpr const char* WIFI_SSID = "YourNetwork";
static constexpr const char* WIFI_PASSWORD = "YourPassword";
static constexpr const char* MQTT_USERNAME = "your_mqtt_user";
static constexpr const char* MQTT_PASSWORD = "your_mqtt_pass";
```

Use the same MQTT credentials as `server/.env`.

### 3. Build & flash

```bash
pio run -t upload
pio device monitor -b 115200
```

## Project structure

```
firmware/
├── include/
│   ├── config.h           # Pins, topics, timing constants
│   ├── secrets.h          # Wi-Fi + MQTT credentials (gitignored)
│   ├── wifi_manager.h
│   ├── mqtt_manager.h
│   ├── sensor_manager.h   # SCD40 (CO2), SHT40 (air temp/hum), DS18B20 (compost)
│   └── relay_controller.h
├── src/
│   ├── main.cpp           # Setup, delta logic, command routing
│   ├── wifi_manager.cpp
│   ├── mqtt_manager.cpp
│   ├── sensor_manager.cpp
│   └── relay_controller.cpp
└── platformio.ini
```

## Relay index map

| Index | JSON key | Backend command | GPIO | Device |
|-------|----------|-----------------|------|--------|
| 0 | `r1` | FAN_ON / FAN_OFF | 18 | Exhaust Fan |
| 1 | `r2` | AC_ON / AC_OFF | 17 | Compressor |
| 2 | `r3` | MIST_ON / MIST_OFF | 23 | Mist Maker |
| 3 | `r4` | — | 5 | UV-C Light |

## Troubleshooting

| Issue | Fix |
|-------|-----|
| SCD40 init fails | Check I2C wiring (3.3V, SDA=21, SCL=22), pull-ups |
| MQTT rc=-2 | Wi-Fi not connected yet |
| Dashboard shows STALE | Verify `fridge/sensors` publishes; check broker credentials |
| Relay always ON | Confirm active-low wiring; firmware sets HIGH at boot |
| Mist maker clicks but no mist | Check water level; clean piezoelectric disc with vinegar; ensure device runs continuously for 30-60s before expecting mist |

## Stop using mock script

Once firmware is flashed and publishing, stop the mock:

```bash
# Do not run mockesp/mock_esp32.js on the same broker
```

Only one device should publish to `fridge/sensors` at a time.
