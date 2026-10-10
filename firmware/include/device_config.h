#pragma once

#include <Arduino.h>

// Live device network configuration. Persisted in NVS flash so credentials
// survive reboots and can be changed remotely from the dashboard — no more
// editing secrets.h and re-flashing every time the farm moves to a new place.
struct DeviceConfig {
  String wifiSsid;               // primary WiFi network
  String wifiPassword;
  String backupWifiSsid;         // optional fallback network (auto-failover)
  String backupWifiPassword;
  String mqttHost;               // MQTT broker
  uint16_t mqttPort = 1883;
  String mqttUsername;
  String mqttPassword;
};

// Loads persisted network/broker config from NVS, falling back to the
// compiled-in secrets.h defaults when nothing has been configured yet.
DeviceConfig loadDeviceConfig();

// Persists a full network/broker config to NVS flash.
void saveDeviceConfig(const DeviceConfig& cfg);

// Erases all persisted device config (falls back to secrets.h defaults).
void clearDeviceConfig();