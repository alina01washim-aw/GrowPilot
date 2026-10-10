// Relay end-to-end test: sends ON/OFF commands for all 4 relays via MQTT
// and reports the relay array reflected back in fridge/sensors payloads.
//
// Usage: RELAY_E2E=1 node relay-test.cjs   (uses server/.env broker credentials)
// Expected: each relay's state in "r" array flips 1 -> 0 -> 1 as commanded.
//
// THIS SWITCHES REAL HARDWARE, including the AC compressor.
//
// The RELAY_E2E guard exists because the filename matches Node's default test
// glob (**/*-test.?js). A bare `node --test` from the repository root therefore
// picks this file up and physically actuates the farm — which has happened. The
// guard makes accidental invocation harmless while keeping the filename and the
// documented usage intact.

require("dotenv").config();
const mqtt = require("mqtt");

if (process.env.RELAY_E2E !== "1") {
  console.error(
    "Refusing to run: this script switches real relays (including the AC compressor).\n" +
      "Re-run deliberately with:  RELAY_E2E=1 node relay-test.cjs",
  );
  process.exit(0);
}

const url = process.env.MQTT_URL;
const username = process.env.MQTT_USERNAME;
const password = process.env.MQTT_PASSWORD;

if (!url) {
  console.error("MQTT_URL not set in .env — aborting test.");
  process.exit(1);
}

console.log("== Mushroom Farm Relay E2E Test ==");
console.log("Broker:", url.replace(/\/\/.*@/, "//<hidden-creds>@"));

const client = mqtt.connect(url, { username, password, connectTimeout: 8000 });

const RELAYS = [
  { cmdOn: "FAN_ON", cmdOff: "FAN_OFF", idx: 0, name: "Fan (Exhaust)" },
  { cmdOn: "AC_ON", cmdOff: "AC_OFF", idx: 1, name: "AC (Compressor)" },
  { cmdOn: "MIST_ON", cmdOff: "MIST_OFF", idx: 2, name: "Mist (Humidifier)" },
  // No MIST... UV has no dedicated command yet; test via JSON r4
];

let lastRelays = null;

function log(msg) {
  const t = new Date().toISOString().split("T")[1].split(".")[0];
  console.log(`[${t}] ${msg}`);
}

client.on("connect", () => {
  log("Connected to broker successfully.");
  client.subscribe("fridge/sensors", (err) => {
    if (err) log("ERROR subscribing fridge/sensors: " + err.message);
  });
  client.subscribe("fridge/status", (err) => {
    if (err) log("ERROR subscribing fridge/status: " + err.message);
  });
});

client.on("error", (err) => {
  log("MQTT ERROR: " + err.message);
});

client.on("message", (topic, message) => {
  const payload = message.toString();
  if (topic === "fridge/status") {
    log(`STATUS: ${payload}`);
  } else if (topic === "fridge/sensors") {
    try {
      const data = JSON.parse(payload);
      log(`SENSOR r=[${Array.isArray(data.r) ? data.r.join(",") : "?"}] payload=${payload}`);
      if (Array.isArray(data.r)) lastRelays = data.r;
    } catch (e) {
      log("Unparseable sensor payload: " + payload);
    }
  }
});

function seq(stepMs) {
  const cmds = [];
  // ON then OFF for each of the 3 named relays
  for (const r of RELAYS) {
    cmds.push({ t: `${r.name} ON`, msg: r.cmdOn });
    cmds.push({ t: `${r.name} OFF`, msg: r.cmdOff });
  }
  // UV relay (index 3) via JSON r4
  cmds.push({ t: "UV ON (r4=1)", msg: JSON.stringify({ r4: 1 }) });
  cmds.push({ t: "UV OFF (r4=0)", msg: JSON.stringify({ r4: 0 }) });

  cmds.forEach((c, i) => {
    setTimeout(() => {
      log(`>>> SEND ${c.t} -> fridge/commands = ${c.msg}`);
      client.publish("fridge/commands", c.msg);
    }, (i + 1) * stepMs);
  });

  setTimeout(() => {
    console.log("\n== SUMMARY ==");
    console.log("Last relay array seen:", lastRelays ? "[" + lastRelays.join(",") + "]" : "none");
    if (!lastRelays) {
      console.log(">>> No sensor payload received — ESP32 may be offline or not publishing.");
    } else {
      console.log(">>> Relay[0]=Fan, [1]=AC, [2]=Mist, [3]=UV");
      console.log(">>> If relay control works, each position flipped 1 then 0 across the test.");
    }
    client.end(true, {}, () => process.exit(0));
  }, (cmds.length + 2) * stepMs);
}

seq(3000);
