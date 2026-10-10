#pragma once

#include <Arduino.h>
#include <functional>
#include "sensor_manager.h"
#include "relay_controller.h"

using CommandCallback = std::function<void(const char* topic, const uint8_t* payload, unsigned int length)>;

class MqttManager {
public:
  void begin(CommandCallback onMessage);
  void loop();
  bool isConnected() const;
  bool publishSensor(const SensorReading& reading, const RelayController& relays);
  void publishStatusOnline();
  void publishStatusOffline();

  // Applies a new broker endpoint, persists to NVS and reconnects.
  // Call from the MQTT device-config handler.
  void applyBroker(const String& host, uint16_t port,
                   const String& username, const String& password);

private:
  CommandCallback onMessage_;
  unsigned long lastReconnectAttemptMs_ = 0;
  String clientId_;
  String host_;
  uint16_t port_ = 1883;
  String username_;
  String password_;

  void setBrokerFromConfig();
  bool connect();
  static void staticCallback(char* topic, byte* payload, unsigned int length);
  static MqttManager* instance_;
};