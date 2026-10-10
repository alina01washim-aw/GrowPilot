#pragma once

// ─── Copy secrets.h.example → secrets.h and fill in your credentials ────────
#include "secrets.h"

// ─── ESP32 DevKit — ACTUAL PHYSICAL WIRING (Verified Jul 2026) ─────────────
//
//  Relay module:  GND | IN1 | IN2 | IN3 | IN4 | VCC
//  ┌────────────────┬──────────┬─────────────┬─────────────────────┐
//  │ Relay module   │ ESP32    │ Breadboard  │ Device              │
//  ├────────────────┼──────────┼─────────────┼─────────────────────┤
//  │ IN1            │ G18      │ Row 9       │ Exhaust Fan         │
//  │ IN2            │ G17      │ Row 8       │ AC Compressor       │
//  │ IN3            │ G23      │ Row 2       │ Mist Maker          │
//  │ IN4            │ G5       │ Row 10      │ UV-C Light          │
//  │ GND            │ GND      │ —           │ Common ground       │
//  │ VCC            │ V5 (VIN) │ —           │ Relay logic power   │
//  └────────────────┴──────────┴─────────────┴─────────────────────┘
//
//  7SEMI SCD4X CO2 sensor (Sensirion SCD40/SCD41 compatible, I2C 0x62):
//  │ SDA            │ G21      │
//  │ SCL            │ G22      │
//  │ VDD            │ 3V3      │ 3.3V ONLY — connecting 5V/VIN will damage the sensor
//  │ GND            │ GND      │
//  │ VCC            │ —        │ Leave empty (not used on 7SEMI boards)

// ─── I2C — Sensirion SCD40 & SHT40 ────────────────────────────────────────────
static constexpr int PIN_I2C_SDA = 21;  // ESP32: G21 (SDA)
static constexpr int PIN_I2C_SCL = 22;  // ESP32: G22 (SCL)

// ─── OneWire — DS18B20 ──────────────────────────────────────────────────────
static constexpr int PIN_ONE_WIRE_BUS = 4; // ESP32: G4

// ─── Relays — ACTIVE LOW (GPIO HIGH = OFF, GPIO LOW = ON) ───────────────────
static constexpr bool RELAY_ACTIVE_LOW = true;
static constexpr bool RELAY_BOOT_SELF_TEST = false;

static constexpr int PIN_RELAY_FAN = 18;   // IN1 → G18
static constexpr int PIN_RELAY_AC = 17;    // IN2 → G17
static constexpr int PIN_RELAY_MIST = 23;  // IN3 → G23
static constexpr int PIN_RELAY_UV = 5;     // IN4 → G5

static constexpr int RELAY_COUNT = 4;

// Single source of truth
static constexpr int PIN_RELAY_MAP[RELAY_COUNT] = {
    PIN_RELAY_FAN,
    PIN_RELAY_AC,
    PIN_RELAY_MIST,
    PIN_RELAY_UV,
};

static constexpr const char* RELAY_IN_LABEL[RELAY_COUNT] = {
    "IN1", "IN2", "IN3", "IN4",
};

static constexpr const char* RELAY_DEVICE_NAME[RELAY_COUNT] = {
    "Exhaust Fan",
    "AC Compressor",
    "Mist Maker",
    "UV-C Light",
};

// ─── MQTT topics ────────────────────────────────────────────────────────────
static constexpr const char* MQTT_TOPIC_SENSORS = "fridge/sensors";
static constexpr const char* MQTT_TOPIC_COMMANDS = "fridge/commands";
static constexpr const char* MQTT_TOPIC_CONFIG = "fridge/config";
static constexpr const char* MQTT_TOPIC_STATUS = "fridge/status";
static constexpr const char* MQTT_TOPIC_DEVICE_CONFIG = "fridge/device-config";
// Dynamic edge-executed automation rules (retained JSON published by server)
static constexpr const char* MQTT_TOPIC_RULES = "fridge/rules";

// PubSubClient RX/TX buffer. Rules payloads are larger than the old 512-byte
// threshold config, so allocate accordingly (dynamic on ESP32).
static constexpr uint16_t MQTT_BUFFER_SIZE = 4096;

// ─── Timing ─────────────────────────────────────────────────────────────────
static constexpr unsigned long SENSOR_SAMPLE_INTERVAL_MS = 5000UL;
static constexpr unsigned long HEARTBEAT_INTERVAL_MS = 120000UL;
static constexpr unsigned long WIFI_RECONNECT_INTERVAL_MS = 10000UL;
static constexpr unsigned long MQTT_RECONNECT_INTERVAL_MS = 5000UL;
static constexpr uint32_t SERIAL_BAUD = 115200;

// ─── Delta thresholds ───────────────────────────────────────────────────────
static constexpr float DELTA_TEMP_C = 0.2f;
static constexpr float DELTA_HUM_PCT = 1.0f;
static constexpr int DELTA_CO2_PPM = 25;