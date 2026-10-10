#include <Arduino.h>
#include <ArduinoJson.h>
#include <cmath>
#include <cstring>
#include <algorithm>

#include "config.h"
#include "mqtt_manager.h"
#include "relay_controller.h"
#include "sensor_manager.h"
#include "wifi_manager.h"
#include "device_config.h"
#include "rule_engine.h"
#include "web_server.h"

// ─── Module instances ───────────────────────────────────────────────────────
WifiManager wifiManager;
MqttManager mqttManager;
SensorManager sensor;
RelayController relays;
RuleEngine ruleEngine;
WebManager webManager;

// Device-config updates arrive inside the MQTT callback, where it is unsafe
// to disconnect/reconnect network stacks immediately. We stash the request
// and apply it from loop() instead.
static bool pendingWifiReconnect = false;
static bool pendingBrokerReconnect = false;
static unsigned long lastPendingApplyMs = 0;

// ─── Publish state (delta + heartbeat) ──────────────────────────────────────
static SensorReading lastPublished{};
static bool hasPublished = false;
static unsigned long lastSampleMs = 0;
static unsigned long lastPublishMs = 0;
static bool pendingRelayPublish = false;
static bool pendingSyncPublish = false;
static bool wasMqttConnected = false;
static unsigned long lastPendingPublishMs = 0;

// ─── Staggered relay startup ─────────────────────────────────────────────────
static bool startupComplete = false;
static uint8_t startupRelayIndex = 0;
static unsigned long startupStartMs = 0;
static constexpr unsigned long STARTUP_INITIAL_DELAY_MS = 5000UL;
static constexpr unsigned long STARTUP_RELAY_GAP_MS = 5000UL;

// ─── Emergency Stop ───────────────────────────────────────────────────────────
bool emergencyStop = false;

// ─── Stored automation config (from fridge/config retained message) ─────────
struct AutomationConfig {
  float tempMin = 21.0f;
  float tempMax = 23.0f;
  float co2Min = 700.0f;
  float co2Max = 1200.0f;
  float humidityMin = 85.0f;
  float humidityMax = 95.0f;
} config;

// ─── Command handling ───────────────────────────────────────────────────────

static bool isWhitespaceChar(char c) {
  return c == ' ' || c == '\t' || c == '\r' || c == '\n';
}

static void trimWhitespace(char* s) {
  char* start = s;
  while (*start && isWhitespaceChar(*start)) ++start;
  if (start != s) {
    memmove(s, start, strlen(start) + 1);
  }

  const size_t len = strlen(s);
  size_t end = len;
  while (end > 0 && isWhitespaceChar(s[end - 1])) {
    --end;
  }
  s[end] = '\0';
}

static void applyBackendStringCommand(const char* command) {
  if (strcmp(command, "EMERGENCY_STOP") == 0) {
    Serial.println("[CMD] EMERGENCY STOP — all relays OFF, automation paused");
    emergencyStop = true;
    for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
      relays.setRelay(i, false);
      relays.setManualOverride(i, true);
    }
    return;
  } else if (strcmp(command, "RESUME") == 0) {
    Serial.println("[CMD] RESUME — automation restarting");
    emergencyStop = false;
    relays.clearManualOverride();
    return;
  }

  if (emergencyStop) {
    Serial.println("[CMD] Ignored — EMERGENCY STOP active");
    return;
  }
  if (strcmp(command, "FAN_ON") == 0) { relays.setRelay(0, true); relays.setManualOverride(0, true); }
  else if (strcmp(command, "FAN_OFF") == 0) { relays.setRelay(0, false); relays.setManualOverride(0, true); }
  else if (strcmp(command, "AC_ON") == 0) { relays.setRelay(1, true); relays.setManualOverride(1, true); }
  else if (strcmp(command, "AC_OFF") == 0) { relays.setRelay(1, false); relays.setManualOverride(1, true); }
  else if (strcmp(command, "MIST_ON") == 0) { relays.setRelay(2, true); relays.setManualOverride(2, true); }
  else if (strcmp(command, "MIST_OFF") == 0) { relays.setRelay(2, false); relays.setManualOverride(2, true); }
  else if (strcmp(command, "RELAY_TEST") == 0) {
    Serial.println("[CMD] RELAY_TEST — cycling each channel 2s ON (watch LED + listen for click)");
    for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
      relays.setRelay(i, true);
      relays.setManualOverride(i, true);
      Serial.printf("[RELAY_TEST] %s (GPIO %d) -> ON — check LED, click, load\n",
                    RELAY_IN_LABEL[i], PIN_RELAY_MAP[i]);
      delay(2000);
      relays.setRelay(i, false);
      relays.setManualOverride(i, true);
      delay(500);
    }
    Serial.println("[RELAY_TEST] done — all channels back OFF");
  } else if (strcmp(command, "REBOOT") == 0) {
    Serial.println("[CMD] REBOOT requested — restarting in 500ms");
    delay(500);
    ESP.restart();
  } else if (strcmp(command, "WIFI_RESET") == 0) {
    Serial.println("[CMD] WIFI_RESET — clearing stored credentials");
    wifiManager.resetConfig();
  } else if (strcmp(command, "CLEAR_MANUAL") == 0) {
    Serial.println("[CMD] CLEAR_MANUAL — clearing all manual overrides");
    relays.clearManualOverride();
  } else Serial.printf("[CMD] Unknown string command: %s\n", command);
}

static void applyJsonRelayCommand(JsonVariantConst doc) {
  if (emergencyStop) {
    Serial.println("[CMD] JSON relay command ignored — EMERGENCY STOP active");
    return;
  }
  // {"r1":1} / {"r2":0} — 1-based relay index mapping
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    char key[4];
    snprintf(key, sizeof(key), "r%u", i + 1);
    const JsonVariantConst value = doc[key];
    if (value.isNull()) continue;

    bool on = false;
    if (value.is<bool>()) {
      on = value.as<bool>();
    } else if (value.is<int>() || value.is<float>()) {
      on = value.as<int>() != 0;
    } else {
      continue;
    }

    relays.setRelay(i, on);
    relays.setManualOverride(i, true);
    Serial.printf("[CMD] JSON %s -> %s\n", key, on ? "ON" : "OFF");
  }
}

static void applyConfigField(JsonVariantConst value, float& target) {
  if (value.isNull()) return;
  target = value.as<float>();
}

static void handleConfigMessage(const uint8_t* payload, unsigned int length) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[CONFIG] JSON parse error: %s\n", err.c_str());
    return;
  }

  applyConfigField(doc["tempMin"], config.tempMin);
  applyConfigField(doc["tempMax"], config.tempMax);
  applyConfigField(doc["co2Min"], config.co2Min);
  applyConfigField(doc["co2Max"], config.co2Max);
  applyConfigField(doc["humidityMin"], config.humidityMin);
  applyConfigField(doc["humidityMax"], config.humidityMax);

  Serial.printf(
      "[CONFIG] Thresholds: T[%.1f-%.1f] H[%.0f-%.0f] CO2[%.0f-%.0f]\n",
      config.tempMin,
      config.tempMax,
      config.humidityMin,
      config.humidityMax,
      config.co2Min,
      config.co2Max);
}

// {"wifiSsid":"...","wifiPassword":"...","backupWifiSsid":"...",
//  "backupWifiPassword":"...","mqttHost":"...","mqttPort":1883,
//  "mqttUsername":"...","mqttPassword":"..."}
// Retained and re-published whenever the dashboard profile is saved, so the
// ESP32 picks it up on every reconnect/boot.
static void handleDeviceConfigMessage(const uint8_t* payload, unsigned int length) {
  JsonDocument doc;
  const DeserializationError err = deserializeJson(doc, payload, length);
  if (err) {
    Serial.printf("[DEVCFG] JSON parse error: %s\n", err.c_str());
    return;
  }

  const char* ssid = doc["wifiSsid"] | "";
  const char* password = doc["wifiPassword"] | "";
  const char* backupSsid = doc["backupWifiSsid"] | "";
  const char* backupPassword = doc["backupWifiPassword"] | "";
  const char* mqttHost = doc["mqttHost"] | "";
  const uint16_t mqttPort = doc["mqttPort"] | 1883;
  const char* mqttUsername = doc["mqttUsername"] | "";
  const char* mqttPassword = doc["mqttPassword"] | "";

  DeviceConfig cfg = loadDeviceConfig();

  // The backend publishes the full profile (retained) on every MQTT connect,
  // which this ESP32 receives again on every subscribe. Only apply — and thus
  // only disconnect/reconnect WiFi + MQTT — when a value actually changed.
  // Empty fields mean "keep what's already stored", so a blank SSID never
  // wipes the credentials the device is currently running on.
  bool wifiChanged = false;
  bool brokerChanged = false;

  if (strlen(ssid) > 0) {
    if (cfg.wifiSsid != ssid || cfg.wifiPassword != password) wifiChanged = true;
    cfg.wifiSsid = ssid;
    cfg.wifiPassword = password;
  }
  if (strlen(backupSsid) > 0) {
    if (cfg.backupWifiSsid != backupSsid || cfg.backupWifiPassword != backupPassword) wifiChanged = true;
    cfg.backupWifiSsid = backupSsid;
    cfg.backupWifiPassword = backupPassword;
  }
  if (strlen(mqttHost) > 0) {
    if (cfg.mqttHost != mqttHost || cfg.mqttPort != mqttPort || cfg.mqttUsername != mqttUsername || cfg.mqttPassword != mqttPassword) {
      brokerChanged = true;
    }
    cfg.mqttHost = mqttHost;
    cfg.mqttPort = mqttPort;
    cfg.mqttUsername = mqttUsername;
    cfg.mqttPassword = mqttPassword;
  }

  if (!wifiChanged && !brokerChanged) {
    Serial.println("[DEVCFG] Profile unchanged — nothing to do");
    return;
  }

  saveDeviceConfig(cfg);

  Serial.printf(
      "[DEVCFG] New profile: wifi=\"%s\" backup=\"%s\" mqtt=%s:%u\n",
      cfg.wifiSsid.c_str(),
      cfg.backupWifiSsid.c_str(),
      cfg.mqttHost.c_str(),
      cfg.mqttPort);

  pendingWifiReconnect = wifiChanged;
  pendingBrokerReconnect = brokerChanged;
}

static bool publishRelayStateUpdate() {
  if (!mqttManager.isConnected()) return false;

  SensorReading reading = lastPublished;
  if (!reading.valid) {
    sensor.read(reading);
  }
  if (!reading.valid) return false;

  if (mqttManager.publishSensor(reading, relays)) {
    lastPublished = reading;
    hasPublished = true;
    lastPublishMs = millis();
    relays.consumeStateChanged();
    return true;
  }
  return false;
}

static void applyPendingDeviceConfig() {
  if (!pendingWifiReconnect && !pendingBrokerReconnect) return;

  const unsigned long nowMs = millis();
  if (nowMs - lastPendingApplyMs < 1000UL) return;
  lastPendingApplyMs = nowMs;

  const DeviceConfig cfg = loadDeviceConfig();

  // Broker first (still on the old network), then WiFi. Reapplying the same
  // retained message after a reconnect is harmless — values are equal.
  if (pendingBrokerReconnect) {
    pendingBrokerReconnect = false;
    mqttManager.applyBroker(cfg.mqttHost, cfg.mqttPort,
                            cfg.mqttUsername, cfg.mqttPassword);
  }

  if (pendingWifiReconnect) {
    pendingWifiReconnect = false;
    wifiManager.applyConfig(cfg.wifiSsid, cfg.wifiPassword,
                            cfg.backupWifiSsid, cfg.backupWifiPassword);
  }
}

static void processPendingPublishes() {
  if (!mqttManager.isConnected()) return;
  if (!pendingRelayPublish && !pendingSyncPublish) return;

  const unsigned long nowMs = millis();
  if (nowMs - lastPendingPublishMs < SENSOR_SAMPLE_INTERVAL_MS) return;
  lastPendingPublishMs = nowMs;

  if (pendingRelayPublish) {
    if (!relays.hasStateChanged()) {
      pendingRelayPublish = false;
    } else if (publishRelayStateUpdate()) {
      pendingRelayPublish = false;
    }
    if (pendingRelayPublish) return;
  }

  if (pendingSyncPublish && publishRelayStateUpdate()) {
    pendingSyncPublish = false;
  }
}

static void onMqttMessage(const char* topic, const uint8_t* payload, unsigned int length) {
  if (strcmp(topic, MQTT_TOPIC_COMMANDS) == 0) {
    if (length == 0) return;

    char buffer[128];
    const size_t copyLen = std::min(static_cast<size_t>(length), sizeof(buffer) - 1);
    memcpy(buffer, payload, copyLen);
    buffer[copyLen] = '\0';
    trimWhitespace(buffer);
    if (buffer[0] == '\0') return;

    Serial.printf("[CMD] Received on %s: %s\n", topic, buffer);

    JsonDocument doc;
    const DeserializationError err = deserializeJson(doc, buffer);
    if (!err && doc.is<JsonObject>()) {
      applyJsonRelayCommand(doc.as<JsonObjectConst>());
    } else if (!err && doc.is<const char*>()) {
      applyBackendStringCommand(doc.as<const char*>());
    } else {
      applyBackendStringCommand(buffer);
    }

    // Defer publish to loop() — PubSubClient cannot reliably publish inside
    // its own message callback.
    pendingRelayPublish = true;
    return;
  }

  if (strcmp(topic, MQTT_TOPIC_CONFIG) == 0) {
    handleConfigMessage(payload, length);
    return;
  }

  if (strcmp(topic, MQTT_TOPIC_DEVICE_CONFIG) == 0) {
    handleDeviceConfigMessage(payload, length);
    return;
  }

  // Dynamic edge-executed rules (retained JSON). Parsed, compiled and persisted
  // to NVS so automation survives network drops and reboots.
  if (strcmp(topic, MQTT_TOPIC_RULES) == 0) {
    ruleEngine.loadFromJson(payload, length);
    return;
  }
}

// ─── Delta-based publish decision ───────────────────────────────────────────

static bool shouldPublish(const SensorReading& reading, unsigned long nowMs) {
  if (!hasPublished) return true;
  if (relays.hasStateChanged()) return true;

  if (fabsf(reading.temperatureC - lastPublished.temperatureC) > DELTA_TEMP_C) return true;
  if (fabsf(reading.humidityPct - lastPublished.humidityPct) > DELTA_HUM_PCT) return true;
  if (abs((int)reading.co2Ppm - (int)lastPublished.co2Ppm) > DELTA_CO2_PPM) return true;

  if (nowMs - lastPublishMs >= HEARTBEAT_INTERVAL_MS) return true;

  return false;
}

// Reads the sensors every SAMPLE_INTERVAL — unconditionally, even with no
// network — so the edge rule engine can keep controlling relays offline.
// Publishing to MQTT is then a network-dependent side effect.
static void sampleAndControl() {
  SensorReading reading{};
  if (!sensor.read(reading) || !reading.valid) return;

  if (!emergencyStop) {
    ruleEngine.evaluate(reading, relays);
  } else if (ruleEngine.masterEnabled()) {
    Serial.println("[RULES] Recovering from emergency stop — master enabled, clearing flag");
    emergencyStop = false;
    relays.clearManualOverride();
    ruleEngine.evaluate(reading, relays);
  }

  const unsigned long nowMs = millis();
  if (!mqttManager.isConnected()) return;
  if (!shouldPublish(reading, nowMs)) return;

  if (mqttManager.publishSensor(reading, relays)) {
    lastPublished = reading;
    hasPublished = true;
    lastPublishMs = nowMs;
    relays.consumeStateChanged();
  }
}

// ─── Arduino entry points ───────────────────────────────────────────────────

void setup() {
  Serial.begin(SERIAL_BAUD);
  while (!Serial && millis() < 2000) { /* USB CDC ready — boot only */ }

  Serial.println();
  Serial.println("============================================");
  Serial.println(" Mushking IoT ESP32 Firmware");
  Serial.println(" SCD40 + 4-Channel Relay (Active LOW)");
  Serial.println("============================================");

  Serial.println("[PINMAP] Expected wiring:");
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    Serial.printf("  %s -> GPIO %d (%s)\n",
                  RELAY_IN_LABEL[i], PIN_RELAY_MAP[i], RELAY_DEVICE_NAME[i]);
  }
  Serial.printf("  SCD40 SDA -> GPIO %d | SCL -> GPIO %d\n", PIN_I2C_SDA, PIN_I2C_SCL);

  relays.begin();

#if RELAY_BOOT_SELF_TEST
  Serial.println("[RELAY] Boot self-test — each channel ON 0.5s (watch module LEDs)");
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    relays.setRelay(i, true);
    delay(500);
    relays.setRelay(i, false);
    delay(200);
  }
  Serial.println("[RELAY] Boot self-test done");
#endif

  if (!sensor.begin()) {
    Serial.println("[BOOT] WARNING: SCD40 init failed — will retry in loop");
  }

  wifiManager.begin();

  mqttManager.begin(onMqttMessage);

  ruleEngine.begin();

  SensorReading bootReading{};
  if (sensor.read(bootReading) && bootReading.valid) {
    ruleEngine.bootstrap(bootReading, relays);
  }

  sampleAndControl();

  lastSampleMs = 0;
  lastPublishMs = 0;

  startupComplete = false;
  startupRelayIndex = 0;
  startupStartMs = millis();
  Serial.println("[STARTUP] Staggered relay startup in 5s...");
}

void loop() {
  if (!startupComplete && !emergencyStop) {
    const unsigned long nowMs = millis();
    if (nowMs - startupStartMs >= STARTUP_INITIAL_DELAY_MS) {
      if (startupRelayIndex < RELAY_COUNT) {
        if (relays.getRelay(startupRelayIndex)) {
          relays.setRelay(startupRelayIndex, true);
          Serial.printf("[STARTUP] %s (GPIO %d) -> ON\n",
                        RELAY_IN_LABEL[startupRelayIndex], PIN_RELAY_MAP[startupRelayIndex]);
        }
        startupRelayIndex++;
        startupStartMs = nowMs;
      }
      if (startupRelayIndex >= RELAY_COUNT) {
        startupComplete = true;
        relays.clearManualOverride();
        Serial.println("[STARTUP] All relays initialized — manual override cleared, automation active");
      }
    }
  }

  if (emergencyStop) {
    for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
      if (relays.getRelay(i)) {
        relays.setRelay(i, false);
        Serial.printf("[EMERGENCY] %s (GPIO %d) forced OFF\n",
                      RELAY_IN_LABEL[i], PIN_RELAY_MAP[i]);
      }
    }
  }

  webManager.loop();
  wifiManager.loop();

  if (!webManager.isStarted() && wifiManager.isConnected()) {
    webManager.start();
  }

  mqttManager.loop();
  applyPendingDeviceConfig();

  const bool mqttConnected = mqttManager.isConnected();
  if (mqttConnected && !wasMqttConnected) {
    pendingSyncPublish = true;
  }
  wasMqttConnected = mqttConnected;

  processPendingPublishes();

  const unsigned long nowMs = millis();
  if (nowMs - lastSampleMs < SENSOR_SAMPLE_INTERVAL_MS) return;
  lastSampleMs = nowMs;

  sampleAndControl();
}
