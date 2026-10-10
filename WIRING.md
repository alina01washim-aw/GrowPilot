# Mushking IoT ESP32 — Wiring Diagram

## Pin Assignments

| Device | Pin | ESP32 GPIO | Notes |
|--------|-----|------------|-------|
| **Relay Module** (4-channel, Active LOW) | GND | GND | Common ground |
| | VCC | VIN (5V) | Relay coil power |
| | IN1 | **GPIO 18** | Exhaust Fan |
| | IN2 | **GPIO 17** | AC Compressor |
| | IN3 | **GPIO 23** | Mist Maker |
| | IN4 | **GPIO 5** | UV-C Light |
| **SCD40 / SCD41** (CO₂, Temp, Humidity) | SDA | **GPIO 21** | I2C Data |
| | SCL | **GPIO 22** | I2C Clock |
| | VDD | **3V3** | **3.3V ONLY — never connect to 5V/VIN** |
| | GND | GND | Common ground |
| | VCC | — | **Leave empty** (not used on 7SEMI boards) |
| **SHT40 / SHT41 / SHT45** (Air Temp + Humidity) | SDA | **GPIO 21** | Shared I2C bus with SCD40 |
| | SCL | **GPIO 22** | Shared I2C bus with SCD40 |
| | VCC | **3V3** | 3.3V |
| | GND | GND | Common ground |
| **DS18B20** (Compost Temperature) | Data | **GPIO 4** | 1-Wire bus |
| | VCC | **3V3** | 3.3V (parasitic or powered) |
| | GND | GND | Common ground |

---

## Required External Components

| Component | Location | Value | Purpose |
|-----------|----------|-------|---------|
| Pull-up resistor | SDA (GPIO21) → 3V3 | **4.7 kΩ** | I2C bus pull-up (ESP32 internal ~45 kΩ too weak) |
| Pull-up resistor | SCL (GPIO22) → 3V3 | **4.7 kΩ** | I2C bus pull-up |
| Pull-up resistor | DS18B20 Data (GPIO4) → 3V3 | **4.7 kΩ** | 1-Wire bus pull-up |
| Decoupling capacitor | SCD40 VDD → GND (near sensor) | 10 µF + 0.1 µF | Power stability for SCD40 |

---

## Common Wiring Mistakes (from debug logs)

1. **SCD40 VDD connected to 5V** — must be 3V3 only
2. **Missing I2C pull-ups** — causes "0 devices found" and NACK errors
3. **SCD40 VCC pin connected** — leave empty on 7SEMI boards
4. **WiFi password incorrect** — check `secrets.h`
5. **Long I2C wires without shielding** — keep <10 cm or use twisted pair

---

## I2C Addresses

| Sensor | Address | Notes |
|--------|---------|-------|
| SCD40 / SCD41 | **0x62** | Fixed |
| SHT40 / SHT41 / SHT45 | **0x44** | Fixed |

---

## Serial Monitor Diagnostic Output

On boot, firmware scans I2C bus and prints:
```
[I2C] Scanning bus...
[I2C] SDA=21 SCL=22 -> device at 0x44 (SHT40)
[I2C] SDA=21 SCL=22 -> device at 0x62 (SCD40)
[I2C] SDA=21 SCL=22 -> 2 device(s) found
[1W] Device found on GPIO 4
[SCD40] Initialized
[SHT40] Initialized
[DS18B20] Initialized
```

If you see:
- `0 device(s) found` → missing pull-ups or wrong pins
- `NACK on transmit of address (0x010C)` → SCD40 not responding (power/pull-up/wiring)
- `[SHT40] Failed to find SHT4x sensor` → SHT40 not detected
- `[1W] GPIO 4: none` → DS18B20 missing pull-up or not wired

---

## Config File Reference

All pins defined in `firmware/include/config.h`:
```cpp
static constexpr int PIN_I2C_SDA = 21;
static constexpr int PIN_I2C_SCL = 22;
static constexpr int PIN_ONE_WIRE_BUS = 4;
static constexpr int PIN_RELAY_FAN = 18;
static constexpr int PIN_RELAY_AC = 17;
static constexpr int PIN_RELAY_MIST = 23;
static constexpr int PIN_RELAY_UV = 5;
```