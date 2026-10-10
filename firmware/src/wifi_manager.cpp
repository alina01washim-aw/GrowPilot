#include "wifi_manager.h"
#include "config.h"
#include "device_config.h"

void WifiManager::begin() {
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(false); // we manage reconnection to roam networks
  WiFi.persistent(false);       // credentials live in our NVS store instead
  loadNetworks();
  apMode_ = false;

  if (networkCount_ > 0) {
    connectTo(0);
  } else {
    Serial.println("[WIFI] No networks configured — starting AP mode");
    startApMode();
  }
}

void WifiManager::loadNetworks() {
  const DeviceConfig cfg = loadDeviceConfig();
  networkCount_ = 0;

  if (cfg.wifiSsid.length() > 0) {
    networks_[networkCount_++] = {cfg.wifiSsid, cfg.wifiPassword};
  }
  if (cfg.backupWifiSsid.length() > 0) {
    networks_[networkCount_++] = {cfg.backupWifiSsid, cfg.backupWifiPassword};
  }
  currentNetwork_ = 0;
}

void WifiManager::connectTo(uint8_t index) {
  if (index >= networkCount_) return;
  const Network& n = networks_[index];
  Serial.printf("[WIFI] Connecting to \"%s\"...\n", n.ssid.c_str());
  WiFi.begin(n.ssid.c_str(), n.password.c_str());
  lastReconnectAttemptMs_ = millis();
  connecting_ = true;
}

void WifiManager::loop() {
  if (apMode_) return;

  if (!connecting_) return;

  if (WiFi.status() == WL_CONNECTED) {
    if (currentNetwork_ != 0) {
      Serial.printf("[WIFI] Connected via backup \"%s\"\n",
                    networks_[currentNetwork_].ssid.c_str());
    }
    connecting_ = false;
    return;
  }

  const unsigned long now = millis();

  if (now - lastReconnectAttemptMs_ >= AP_FALLBACK_DELAY_MS) {
    Serial.println("[WIFI] STA connect timeout — falling back to AP mode");
    startApMode();
    return;
  }

  if (now - lastReconnectAttemptMs_ < WIFI_RECONNECT_INTERVAL_MS) return;

  if (networkCount_ > 1) {
    tryNextNetwork();
    return;
  }

  Serial.println("[WIFI] Disconnected — retrying...");
  if (!WiFi.isConnected()) {
    const Network& n = networks_[0];
    WiFi.begin(n.ssid.c_str(), n.password.c_str());
  }
  lastReconnectAttemptMs_ = now;
}

void WifiManager::tryNextNetwork() {
  currentNetwork_ = (currentNetwork_ + 1) % networkCount_;
  Serial.printf("[WIFI] Network %d unreachable — trying backup...\n",
                currentNetwork_);
  connectTo(currentNetwork_);
}

bool WifiManager::isConnected() const {
  if (apMode_) return true;
  return WiFi.status() == WL_CONNECTED;
}

bool WifiManager::isApMode() const {
  return apMode_;
}

String WifiManager::localIp() const {
  return WiFi.localIP().toString();
}

String WifiManager::ssid() const {
  if (apMode_) return AP_SSID;
  if (!isConnected()) return "";
  return WiFi.SSID();
}

void WifiManager::startApMode() {
  apMode_ = true;
  connecting_ = false;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_AP);
  WiFi.softAP(AP_SSID, AP_PASSWORD);
  Serial.printf("[WIFI] AP mode started — SSID: %s, Password: %s, IP: %s\n",
                AP_SSID, AP_PASSWORD, WiFi.softAPIP().toString().c_str());
}

void WifiManager::applyConfig(const String& ssid, const String& password,
                              const String& backupSsid, const String& backupPassword) {
  DeviceConfig cfg = loadDeviceConfig();
  cfg.wifiSsid = ssid;
  cfg.wifiPassword = password;
  cfg.backupWifiSsid = backupSsid;
  cfg.backupWifiPassword = backupPassword;
  saveDeviceConfig(cfg);

  loadNetworks();
  apMode_ = false;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  currentNetwork_ = 0;
  connectTo(0);
}

void WifiManager::resetConfig() {
  clearDeviceConfig();
  loadNetworks();
  apMode_ = false;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_STA);
  currentNetwork_ = 0;

  if (networkCount_ > 0) {
    connectTo(0);
  } else {
    startApMode();
  }
}