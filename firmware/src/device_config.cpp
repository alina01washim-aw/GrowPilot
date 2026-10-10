#include "device_config.h"
#include "secrets.h"

#include <Preferences.h>

static const char* NVS_NS = "myco";

static String getOrDefault(Preferences& prefs, const char* key, const char* defaultVal) {
  if (prefs.isKey(key)) {
    return prefs.getString(key);
  }
  return String(defaultVal);
}

static uint16_t getUShortOrDefault(Preferences& prefs, const char* key, uint16_t defaultVal) {
  if (prefs.isKey(key)) {
    return prefs.getUShort(key);
  }
  return defaultVal;
}

DeviceConfig loadDeviceConfig() {
  DeviceConfig cfg;
  Preferences prefs;
  prefs.begin(NVS_NS, true);

  cfg.wifiSsid = getOrDefault(prefs, "wifiSsid", WIFI_SSID);
  cfg.wifiPassword = getOrDefault(prefs, "wifiPass", WIFI_PASSWORD);
  cfg.backupWifiSsid = getOrDefault(prefs, "wifi2Ssid", "");
  cfg.backupWifiPassword = getOrDefault(prefs, "wifi2Pass", "");
  cfg.mqttHost = getOrDefault(prefs, "mqttHost", MQTT_HOST);
  cfg.mqttPort = getUShortOrDefault(prefs, "mqttPort", MQTT_PORT);
  cfg.mqttUsername = getOrDefault(prefs, "mqttUser", MQTT_USERNAME);
  cfg.mqttPassword = getOrDefault(prefs, "mqttPass", MQTT_PASSWORD);

  prefs.end();
  return cfg;
}

void saveDeviceConfig(const DeviceConfig& cfg) {
  Preferences prefs;
  prefs.begin(NVS_NS, false);

  prefs.putString("wifiSsid", cfg.wifiSsid);
  prefs.putString("wifiPass", cfg.wifiPassword);
  prefs.putString("wifi2Ssid", cfg.backupWifiSsid);
  prefs.putString("wifi2Pass", cfg.backupWifiPassword);
  prefs.putString("mqttHost", cfg.mqttHost);
  prefs.putUShort("mqttPort", cfg.mqttPort);
  prefs.putString("mqttUser", cfg.mqttUsername);
  prefs.putString("mqttPass", cfg.mqttPassword);

  prefs.end();
}

void clearDeviceConfig() {
  Preferences prefs;
  prefs.begin(NVS_NS, false);
  prefs.clear();
  prefs.end();
}