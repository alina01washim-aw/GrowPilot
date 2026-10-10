#pragma once

#include <Arduino.h>
#include <WebServer.h>
#include <ArduinoJson.h>

class WebManager {
public:
  void begin();
  void loop();
  bool isStarted() const;
  void start();

private:
  WebServer server_{80};

  void handleRoot();
  void handleApiStatus();
  void handleApiRelay();
  void handleApiClearManual();
  void handleApiRulesMaster();
  void handleApiRulesRule();
  void handleApiEmergencyStop();
  void handleApiResume();
  void handleNotFound();

  String buildDashboard();

  bool testActive_ = false;
  uint8_t testIndex_ = 0;
  unsigned long testNextMs_ = 0;
  bool started_ = false;
};
