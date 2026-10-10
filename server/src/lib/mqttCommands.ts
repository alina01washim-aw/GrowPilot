import type { RelayName } from "../models/relay";
import { getMqttClient } from "./mqttClientRef";

const COMMAND_TOPIC = "fridge/commands";

const COMMAND_MAP: Record<RelayName, { on: string; off: string }> = {
  fan: { on: "FAN_ON", off: "FAN_OFF" },
  fridge: { on: "AC_ON", off: "AC_OFF" },
  humidifier: { on: "MIST_ON", off: "MIST_OFF" },
};

/** Publishes an on/off command to the ESP32 via MQTT. */
export function publishRelayCommand(name: RelayName, on: boolean): void {
  const client = getMqttClient();
  if (!client) return;
  client.publish(COMMAND_TOPIC, on ? COMMAND_MAP[name].on : COMMAND_MAP[name].off);
}

/** Publishes a raw string command to the ESP32 via MQTT (e.g. REBOOT, WIFI_RESET). */
export function publishDeviceCommand(command: string): void {
  const client = getMqttClient();
  if (!client) return;
  client.publish(COMMAND_TOPIC, command);
}

/**
 * Publishes an on/off command for a relay channel by its hardware index
 * (0-based) — wire format {"r1":1} … {"r4":0}. Used for devices that have no
 * legacy Relay document (e.g. UV-C), and is understood by the ESP32's JSON
 * command handler regardless of the device registry.
 */
export function publishRelayIndexCommand(index: number, on: boolean): void {
  const client = getMqttClient();
  if (!client) return;
  const key = `r${index + 1}`;
  client.publish(COMMAND_TOPIC, JSON.stringify({ [key]: on ? 1 : 0 }));
}
