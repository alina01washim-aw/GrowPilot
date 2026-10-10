/**
 * Tiny module that holds the live MqttClient reference so both mqttClient.ts
 * and settingsControl.ts can import it without creating a circular dependency.
 */
import type { MqttClient } from "mqtt";

let _client: MqttClient | null = null;

export function setMqttClient(c: MqttClient | null): void {
  _client = c;
}

export function getMqttClient(): MqttClient | null {
  return _client;
}
