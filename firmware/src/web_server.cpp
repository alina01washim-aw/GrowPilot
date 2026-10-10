#include "web_server.h"
#include "config.h"
#include "relay_controller.h"
#include "sensor_manager.h"
#include "wifi_manager.h"
#include "rule_engine.h"

extern RelayController relays;
extern SensorManager sensor;
extern WifiManager wifiManager;
extern RuleEngine ruleEngine;
extern bool emergencyStop;

void WebManager::begin() {
  server_.on("/", [this]() { handleRoot(); });
  server_.on("/api/status", [this]() { handleApiStatus(); });
  server_.on("/api/relay", HTTP_POST, [this]() { handleApiRelay(); });
  server_.on("/api/clear-manual", HTTP_POST, [this]() { handleApiClearManual(); });
  server_.on("/api/rules/master", HTTP_POST, [this]() { handleApiRulesMaster(); });
  server_.on("/api/rules/rule", HTTP_POST, [this]() { handleApiRulesRule(); });
  server_.on("/api/emergency-stop", HTTP_POST, [this]() { handleApiEmergencyStop(); });
  server_.on("/api/resume", HTTP_POST, [this]() { handleApiResume(); });
  server_.onNotFound([this]() { handleNotFound(); });
}

void WebManager::loop() {
  server_.handleClient();

  if (testActive_ && emergencyStop) {
    testActive_ = false;
    for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
      relays.setRelay(i, false);
    }
    Serial.println("[WEB] Test aborted — emergency stop active");
    return;
  }

  if (testActive_) {
    const unsigned long nowMs = millis();
    if (nowMs >= testNextMs_) {
      if (testIndex_ < RELAY_COUNT) {
        relays.setRelay(testIndex_, true);
        testNextMs_ = nowMs + 2000;
        testIndex_++;
      } else if (testIndex_ == RELAY_COUNT) {
        for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
          relays.setRelay(i, false);
        }
        testActive_ = false;
      }
    }
  }
}

bool WebManager::isStarted() const {
  return started_;
}

void WebManager::start() {
  if (started_) return;
  server_.begin();
  started_ = true;
  Serial.println("[WEB] HTTP server started on port 80");
}

void WebManager::handleRoot() {
  server_.send(200, "text/html", buildDashboard());
}

String WebManager::buildDashboard() {
  String html;
  html.reserve(4096);
  html += F("<!DOCTYPE html><html><head><meta charset='utf-8'>"
    "<meta name='viewport' content='width=device-width, initial-scale=1'>"
    "<title>Mushking IoT</title>"
    "<style>"
    "body{font-family:Arial,sans-serif;background:#f4f4f9;margin:0;padding:20px;color:#333}"
    ".card{background:#fff;border-radius:8px;box-shadow:0 2px 4px rgba(0,0,0,0.1);padding:16px;margin-bottom:16px}"
    "h1{margin:0 0 12px;font-size:1.4rem;color:#2c3e50}"
    "table{width:100%;border-collapse:collapse;margin-top:8px}"
    "th,td{text-align:left;padding:8px;border-bottom:1px solid #eee}"
    "th{font-weight:600;color:#555}"
    ".val{font-weight:700;color:#2c3e50}"
    ".on{color:#27ae60}.off{color:#e74c3c}"
    "button{padding:8px 16px;border:none;border-radius:4px;cursor:pointer;font-size:0.9rem}"
    ".btn-on{background:#27ae60;color:#fff}.btn-off{background:#e74c3c;color:#fff}"
    ".btn-test{background:#2980b9;color:#fff;margin-top:8px}"
    "</style></head><body>"
    "<div class='card'><h1>Mushking IoT Dashboard</h1>"
    "<div id='net'></div>"
    "<div id='ap-info' style='display:none;background:#fff3cd;padding:10px;border-radius:4px;margin-top:10px'>"
    "<b>AP Mode Active:</b> Connect phone to <b>Mushking IoT</b> (password: <b>mushroom123</b>)<br>"
    "Then open <a href='http://192.168.4.1'>http://192.168.4.1</a></div>"
    "</div>"
    "<div class='card'><h1>Sensors</h1>"
    "<table><tr><th>Sensor</th><th>Value</th><th>Status</th></tr>"
    "<tr><td>SHT40 Temp</td><td class='val' id='sht-temp'>--</td><td id='sht-ok'>--</td></tr>"
    "<tr><td>SHT40 Humidity</td><td class='val' id='sht-hum'>--</td><td id='sht-ok'>--</td></tr>"
    "<tr><td>SCD40 CO2</td><td class='val' id='scd-co2'>--</td><td id='scd-ok'>--</td></tr>"
    "<tr><td>SCD40 Temp</td><td class='val' id='scd-temp'>--</td><td id='scd-temp-ok'>--</td></tr>"
    "<tr><td>SCD40 Humidity</td><td class='val' id='scd-hum'>--</td><td id='scd-hum-ok'>--</td></tr>"
    "<tr><td>DS18B20 Compost</td><td class='val' id='ds-temp'>--</td><td id='ds-ok'>--</td></tr>"
    "</table></div>"
    "<div class='card'><h1>Relays</h1>"
    "<table><tr><th>Channel</th><th>Device</th><th>State</th><th>Action</th></tr>");

  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    html += "<tr><td>IN" + String(i + 1) + "</td><td>" + String(RELAY_DEVICE_NAME[i]) + "</td>";
    html += "<td id='relay-" + String(i) + "' class='off'>OFF</td>";
    html += "<td><button class='btn-on' onclick='setRelay(" + String(i) + ",true)'>ON</button> ";
    html += "<button class='btn-off' onclick='setRelay(" + String(i) + ",false)'>OFF</button>";
    html += "<br><button class='btn-off' onclick='clearManual(" + String(i) + ")'>Clear Manual</button></td></tr>";
  }

  html += F("</table>"
    "<button class='btn-test' onclick='testRelays()'>Test All Relays</button>"
    "<button class='btn-test' onclick='clearAllManual()'>Clear All Manual</button>"
    "</div>"
    "<div class='card'><h1>Emergency Control</h1>"
    "<button class='btn-off' onclick='emergencyStop()' style='background:#c0392b;color:#fff;padding:10px 20px;font-size:1rem;font-weight:bold'>EMERGENCY STOP ALL</button> "
    "<button class='btn-on' onclick='resume()' style='background:#27ae60;color:#fff;padding:10px 20px;font-size:1rem;font-weight:bold'>RESUME AUTOMATION</button>"
    "<span id='emergency-status' style='margin-left:10px;font-weight:bold'></span>"
    "</div>"
    "<div class='card'><h1>Automation Rules</h1>"
    "<div id='rules-master' style='margin-bottom:10px'>"
    "<button class='btn-on' onclick='setMasterRules(true)'>Enable All Rules</button> "
    "<button class='btn-off' onclick='setMasterRules(false)'>Disable All Rules</button>"
    "<span id='rules-master-status' style='margin-left:10px'></span>"
    "</div>"
    "<table><tr><th>#</th><th>Rule ID</th><th>Status</th><th>Action</th></tr>");

  for (uint16_t i = 0; i < 16; ++i) {
    html += "<tr id='rule-row-" + String(i) + "' style='display:none'>";
    html += "<td>" + String(i) + "</td>";
    html += "<td id='rule-id-" + String(i) + "'>--</td>";
    html += "<td id='rule-status-" + String(i) + "' class='off'>OFF</td>";
    html += "<td><button class='btn-on' onclick='setRule(" + String(i) + ",true)'>Enable</button> ";
    html += "<button class='btn-off' onclick='setRule(" + String(i) + ",false)'>Disable</button></td></tr>";
  }

  html += F("</table></div>"
    "<script>"
    "function refresh(){"
    "fetch('/api/status').then(r=>r.json()).then(d=>{"
    "document.getElementById('net').innerHTML='<b>WiFi:</b> '+(d.wifi_connected?'<span class=on>Connected</span> '+d.wifi_ssid+' ('+d.ip+')':'<span class=off>Disconnected</span>');"
    "document.getElementById('ap-info').style.display=d.ap_mode?'block':'none';"
    "document.getElementById('sht-temp').textContent=d.sensors.sht.valid?d.sensors.sht.temp.toFixed(1)+' C':'--';"
    "document.getElementById('sht-hum').textContent=d.sensors.sht.valid?d.sensors.sht.humidity.toFixed(1)+' %':'--';"
    "document.getElementById('sht-ok').textContent=d.sensors.sht.valid?'<span class=on>OK</span>':'<span class=off>N/A</span>';"
    "document.getElementById('scd-co2').textContent=d.sensors.scd.valid?d.sensors.scd.co2:'--';"
    "document.getElementById('scd-temp').textContent=d.sensors.scd.valid?d.sensors.scd.temp.toFixed(1)+' C':'--';"
    "document.getElementById('scd-temp-ok').innerHTML=d.sensors.scd.valid?'<span class=on>OK</span>':'<span class=off>N/A</span>';"
    "document.getElementById('scd-hum').textContent=d.sensors.scd.valid?d.sensors.scd.humidity.toFixed(1)+' %':'--';"
    "document.getElementById('scd-hum-ok').innerHTML=d.sensors.scd.valid?'<span class=on>OK</span>':'<span class=off>N/A</span>';"
    "document.getElementById('scd-ok').innerHTML=d.sensors.scd.valid?'<span class=on>OK</span>':'<span class=off>N/A</span>';"
    "document.getElementById('ds-temp').textContent=d.sensors.ds.valid?d.sensors.ds.temp.toFixed(1)+' C':'--';"
    "document.getElementById('ds-ok').textContent=d.sensors.ds.valid?'<span class=on>OK</span>':'<span class=off>N/A</span>';"
    "d.relays.forEach(r=>{"
    "const el=document.getElementById('relay-'+r.index);"
    "el.textContent=r.on?'ON':'OFF';"
    "el.className=r.on?'on':'off';"
    "el.title=r.manual?'Manual Override':'';"
    "});"
    "document.getElementById('rules-master-status').textContent=d.rules_master_enabled?'<span class=on>ENABLED</span>':'<span class=off>DISABLED</span>';"
    "document.getElementById('emergency-status').textContent=d.emergency_stop?'<span class=off style=font-size:1.2rem>EMERGENCY STOP ACTIVE</span>':'<span class=on>Automation Running</span>';"
    "d.rules.forEach(r=>{"
    "const row=document.getElementById('rule-row-'+r.index);"
    "if(row){row.style.display='table-row';}"
    "document.getElementById('rule-id-'+r.index).textContent='#'+r.id;"
    "const status=document.getElementById('rule-status-'+r.index);"
    "status.textContent=r.enabled?'ON':'OFF';"
    "status.className=r.enabled?'on':'off';"
    "});"
    "});}"
    "function setRelay(i,on){"
    "fetch('/api/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:i,on:on})}).then(refresh);}"
    "function clearManual(i){"
    "fetch('/api/clear-manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:i})}).then(refresh);}"
    "function clearAllManual(){"
    "fetch('/api/clear-manual',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({})}).then(refresh);}"
    "function testRelays(){"
    "fetch('/api/relay',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:-1,on:false})}).then(refresh);}"
    "function setMasterRules(enabled){"
    "fetch('/api/rules/master',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled:enabled})}).then(refresh);}"
    "function setRule(index,enabled){"
    "fetch('/api/rules/rule',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({index:index,enabled:enabled})}).then(refresh);}"
    "function emergencyStop(){"
    "fetch('/api/emergency-stop',{method:'POST'}).then(refresh);}"
    "function resume(){"
    "fetch('/api/resume',{method:'POST'}).then(refresh);}"
    "setInterval(refresh,5000);refresh();"
    "</script></body></html>");

  return html;
}

void WebManager::handleApiStatus() {
  SensorReading reading{};
  sensor.read(reading);

  int relayStates[RELAY_COUNT];
  relays.getRelayArray(relayStates);

  DynamicJsonDocument doc(1024);
  doc["wifi_connected"] = wifiManager.isConnected();
  doc["wifi_ssid"] = wifiManager.ssid();
  doc["ip"] = wifiManager.localIp();
  doc["ap_mode"] = wifiManager.isApMode();
  doc["emergency_stop"] = emergencyStop;

  JsonObject sht = doc.createNestedObject("sensors").createNestedObject("sht");
  sht["valid"] = reading.shtValid;
  sht["temp"] = reading.temperatureC;
  sht["humidity"] = reading.humidityPct;

  JsonObject scd = doc["sensors"].createNestedObject("scd");
  scd["valid"] = reading.scdValid;
  scd["co2"] = reading.co2Ppm;
  scd["temp"] = reading.scdTempC;
  scd["humidity"] = reading.scdHumPct;

  JsonObject ds = doc["sensors"].createNestedObject("ds");
  ds["valid"] = reading.dsValid;
  ds["temp"] = reading.compostTempC;

  JsonArray relaysJson = doc.createNestedArray("relays");
  for (int i = 0; i < RELAY_COUNT; i++) {
    JsonObject r = relaysJson.createNestedObject();
    r["index"] = i;
    r["name"] = RELAY_DEVICE_NAME[i];
    r["on"] = relayStates[i] != 0;
    r["manual"] = relays.isManualOverride(i);
  }

  doc["rules_master_enabled"] = ruleEngine.masterEnabled();
  JsonArray rulesJson = doc.createNestedArray("rules");
  for (uint16_t i = 0; i < ruleEngine.ruleCount(); ++i) {
    JsonObject rule = rulesJson.createNestedObject();
    rule["index"] = i;
    rule["id"] = ruleEngine.rules()[i].id;
    rule["enabled"] = ruleEngine.rules()[i].enabled;
  }

  String output;
  serializeJson(doc, output);
  server_.send(200, "application/json", output);
}

void WebManager::handleApiRelay() {
  if (!server_.hasArg("plain")) {
    server_.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server_.arg("plain");
  DynamicJsonDocument doc(256);
  DeserializationError err = deserializeJson(doc, body);

  if (err) {
    server_.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  int index = doc["index"] | -1;
  bool on = doc["on"] | false;

  if (emergencyStop && index != -1) {
    server_.send(403, "application/json", "{\"error\":\"Emergency stop active\"}");
    return;
  }

  if (index == -1) {
    if (emergencyStop) {
      server_.send(403, "application/json", "{\"error\":\"Emergency stop active\"}");
      return;
    }
    testActive_ = true;
    testIndex_ = 0;
    testNextMs_ = millis();
    server_.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  if (index < 0 || index >= RELAY_COUNT) {
    server_.send(400, "application/json", "{\"error\":\"Invalid relay index\"}");
    return;
  }

  relays.setRelay(index, on);
  relays.setManualOverride(index, true);
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleApiClearManual() {
  if (!server_.hasArg("plain")) {
    relays.clearManualOverride();
    server_.send(200, "application/json", "{\"ok\":true}");
    return;
  }

  String body = server_.arg("plain");
  DynamicJsonDocument doc(64);
  DeserializationError err = deserializeJson(doc, body);

  if (!err) {
    int index = doc["index"] | -1;
    if (index >= 0 && index < RELAY_COUNT) {
      relays.setManualOverride(index, false);
    }
  }

  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleApiRulesMaster() {
  if (!server_.hasArg("plain")) {
    server_.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server_.arg("plain");
  DynamicJsonDocument doc(64);
  DeserializationError err = deserializeJson(doc, body);

  if (err) {
    server_.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  bool enabled = doc["enabled"] | false;
  ruleEngine.setMasterEnabled(enabled);
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleApiRulesRule() {
  if (!server_.hasArg("plain")) {
    server_.send(400, "application/json", "{\"error\":\"Missing body\"}");
    return;
  }

  String body = server_.arg("plain");
  DynamicJsonDocument doc(64);
  DeserializationError err = deserializeJson(doc, body);

  if (err) {
    server_.send(400, "application/json", "{\"error\":\"Invalid JSON\"}");
    return;
  }

  int index = doc["index"] | -1;
  bool enabled = doc["enabled"] | false;

  if (index < 0 || index >= ruleEngine.ruleCount()) {
    server_.send(400, "application/json", "{\"error\":\"Invalid rule index\"}");
    return;
  }

  ruleEngine.setRuleEnabled(index, enabled);
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleApiEmergencyStop() {
  emergencyStop = true;
  for (uint8_t i = 0; i < RELAY_COUNT; ++i) {
    relays.setRelay(i, false);
    relays.setManualOverride(i, true);
  }
  Serial.println("[WEB] Emergency stop triggered — all relays OFF");
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleApiResume() {
  emergencyStop = false;
  relays.clearManualOverride();
  Serial.println("[WEB] Resume triggered — automation restarting");
  server_.send(200, "application/json", "{\"ok\":true}");
}

void WebManager::handleNotFound() {
  server_.send(404, "application/json", "{\"error\":\"Not found\"}");
}
