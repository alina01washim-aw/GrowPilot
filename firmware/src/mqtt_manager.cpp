#include "mqtt_manager.h"
#include "config.h"
#include "device_config.h"

#include <PubSubClient.h>
#include <WiFi.h>
#include <ArduinoJson.h>
#include <cmath>

static WiFiClient wifiClient;
static PubSubClient mqttClient(wifiClient);

MqttManager* MqttManager::instance_ = nullptr;

void MqttManager::begin(CommandCallback onMessage) {
  instance_ = this;
  onMessage_ = std::move(onMessage);

  uint64_t chipId = ESP.getEfuseMac();
  clientId_ = String("myco-esp32-") + String((uint32_t)(chipId >> 16), HEX);

  setBrokerFromConfig();
  mqttClient.setCallback(staticCallback);
  mqttClient.setBufferSize(MQTT_BUFFER_SIZE);
  mqttClient.setKeepAlive(30);

  Serial.printf("[MQTT] Client ID: %s\n", clientId_.c_str());
}

void MqttManager::setBrokerFromConfig() {
  const DeviceConfig cfg = loadDeviceConfig();
  host_ = cfg.mqttHost.length() > 0 ? cfg.mqttHost : MQTT_HOST;
  port_ = cfg.mqttPort > 0 ? cfg.mqttPort : MQTT_PORT;
  username_ = cfg.mqttUsername.length() > 0 ? cfg.mqttUsername : MQTT_USERNAME;
  password_ = cfg.mqttPassword.length() > 0 ? cfg.mqttPassword : MQTT_PASSWORD;
  mqttClient.setServer(host_.c_str(), port_);
}

bool MqttManager::connect() {
  if (!WiFi.isConnected()) return false;

  Serial.printf("[MQTT] Connecting to %s:%u...\n", host_.c_str(), port_);

  // Last Will and Testament — dashboard marks ESP32 stale/offline
  const bool ok = mqttClient.connect(
      clientId_.c_str(),
      username_.c_str(),
      password_.c_str(),
      MQTT_TOPIC_STATUS,
      1,
      true,
      "offline");

  if (!ok) {
    Serial.printf("[MQTT] Connect failed, rc=%d\n", mqttClient.state());
    return false;
  }

  Serial.println("[MQTT] Connected");

  const bool commandsSubscribed = mqttClient.subscribe(MQTT_TOPIC_COMMANDS);
  const bool configSubscribed = mqttClient.subscribe(MQTT_TOPIC_CONFIG);
  const bool deviceConfigSubscribed = mqttClient.subscribe(MQTT_TOPIC_DEVICE_CONFIG);
  const bool rulesSubscribed = mqttClient.subscribe(MQTT_TOPIC_RULES);
  if (!commandsSubscribed || !configSubscribed || !deviceConfigSubscribed || !rulesSubscribed) {
    Serial.printf(
        "[MQTT] Subscribe failed (commands=%d config=%d deviceConfig=%d rules=%d)\n",
        commandsSubscribed,
        configSubscribed,
        deviceConfigSubscribed,
        rulesSubscribed);
    mqttClient.disconnect();
    return false;
  }
  Serial.printf("[MQTT] Subscribed: %s, %s, %s, %s\n",
                MQTT_TOPIC_COMMANDS, MQTT_TOPIC_CONFIG, MQTT_TOPIC_DEVICE_CONFIG, MQTT_TOPIC_RULES);

  publishStatusOnline();
  return true;
}

void MqttManager::publishStatusOnline() {
  if (!mqttClient.connected()) return;
  mqttClient.publish(MQTT_TOPIC_STATUS, "online", true);
  Serial.println("[MQTT] Status: online (retained)");
}

void MqttManager::publishStatusOffline() {
  if (!mqttClient.connected()) return;
  mqttClient.publish(MQTT_TOPIC_STATUS, "offline", true);
}

bool MqttManager::publishSensor(const SensorReading& reading, const RelayController& relays) {
  if (!mqttClient.connected() || !reading.valid) return false;

  int relayArray[RELAY_COUNT];
  relays.getRelayArray(relayArray);

  JsonDocument doc;
  if (reading.shtValid) {
    doc["t"] = roundf(reading.temperatureC * 100.0f) / 100.0f;
    doc["h"] = roundf(reading.humidityPct * 100.0f) / 100.0f;
  }
  if (reading.scdValid) {
    doc["c"] = reading.co2Ppm;
    doc["scdT"] = roundf(reading.scdTempC * 100.0f) / 100.0f;
    doc["scdH"] = roundf(reading.scdHumPct * 100.0f) / 100.0f;
  }
  if (reading.dsValid) {
    doc["compT"] = roundf(reading.compostTempC * 100.0f) / 100.0f;
  }

  JsonArray r = doc["r"].to<JsonArray>();
  for (int i = 0; i < RELAY_COUNT; ++i) {
    r.add(relayArray[i]);
  }

  char payload[192];
  const size_t needed = measureJson(doc);
  if (needed == 0 || needed >= sizeof(payload)) {
    Serial.printf("[MQTT] Sensor payload too large (%u bytes)\n", static_cast<unsigned>(needed));
    return false;
  }

  const size_t len = serializeJson(doc, payload, sizeof(payload));
  if (len == 0 || len >= sizeof(payload)) return false;

  const bool published = mqttClient.publish(MQTT_TOPIC_SENSORS, payload, false);
  if (published) {
    Serial.printf(
        "[MQTT] Published %s -> SHT40 T:%.2f H:%.2f | SCD40 CO2:%u T:%.2f H:%.2f | Compost:%.2f | r:[%d,%d,%d,%d]\n",
        MQTT_TOPIC_SENSORS,
        reading.temperatureC,
        reading.humidityPct,
        reading.co2Ppm,
        reading.scdTempC,
        reading.scdHumPct,
        reading.compostTempC,
        relayArray[0],
        relayArray[1],
        relayArray[2],
        relayArray[3]);
  }
  return published;
}

void MqttManager::loop() {
  if (mqttClient.connected()) {
    mqttClient.loop();
    return;
  }
  if (!WiFi.isConnected()) return;

  const unsigned long now = millis();
  if (now - lastReconnectAttemptMs_ < MQTT_RECONNECT_INTERVAL_MS) return;

  lastReconnectAttemptMs_ = now;
  connect();
}

bool MqttManager::isConnected() const {
  return mqttClient.connected();
}

void MqttManager::applyBroker(const String& host, uint16_t port,
                              const String& username, const String& password) {
  DeviceConfig cfg = loadDeviceConfig();
  cfg.mqttHost = host;
  cfg.mqttPort = port;
  cfg.mqttUsername = username;
  cfg.mqttPassword = password;
  saveDeviceConfig(cfg);

  host_ = host;
  port_ = port;
  username_ = username;
  password_ = password;
  mqttClient.setServer(host_.c_str(), port_);

  if (mqttClient.connected()) {
    publishStatusOffline();
    mqttClient.disconnect();
  }
  lastReconnectAttemptMs_ = 0;
  Serial.printf("[MQTT] Broker updated -> %s:%u\n", host_.c_str(), port_);
}

void MqttManager::staticCallback(char* topic, byte* payload, unsigned int length) {
  if (!instance_ || !instance_->onMessage_) return;
  instance_->onMessage_(topic, payload, length);
}