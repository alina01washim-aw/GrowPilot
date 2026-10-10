#pragma once

#include <Arduino.h>
#include <WiFi.h>

class WifiManager {
public:
  void begin();
  void loop();
  bool isConnected() const;
  String localIp() const;
  String ssid() const;
  bool isApMode() const;

  void applyConfig(const String& ssid, const String& password,
                   const String& backupSsid = "", const String& backupPassword = "");

  void resetConfig();

private:
  static constexpr uint8_t MAX_NETWORKS = 2;
  static constexpr const char* AP_SSID = "Mushking IoT";
  static constexpr const char* AP_PASSWORD = "mushroom123";
  static constexpr unsigned long AP_FALLBACK_DELAY_MS = 15000UL;

  struct Network { String ssid; String password; };

  Network networks_[MAX_NETWORKS];
  uint8_t networkCount_ = 0;
  uint8_t currentNetwork_ = 0;
  unsigned long lastReconnectAttemptMs_ = 0;
  bool connecting_ = false;
  bool apMode_ = false;

  void loadNetworks();
  void connectTo(uint8_t index);
  void tryNextNetwork();
  void startApMode();
};