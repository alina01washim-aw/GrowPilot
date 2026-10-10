import { customFetch } from "./custom-fetch";

export interface DeviceProfile {
  deviceName: string;
  wifiSsid: string;
  hasWifiPassword: boolean;
  backupWifiSsid: string;
  hasBackupWifiPassword: boolean;
  mqttHost: string;
  mqttPort: number;
  mqttUsername: string;
  hasMqttPassword: boolean;
  updatedAt: string;
}

export interface DeviceProfileInput {
  deviceName?: string;
  wifiSsid?: string;
  wifiPassword?: string;
  backupWifiSsid?: string;
  backupWifiPassword?: string;
  mqttHost?: string;
  mqttPort?: number;
  mqttUsername?: string;
  mqttPassword?: string;
}

export function getDeviceProfile(): Promise<DeviceProfile> {
  return customFetch<DeviceProfile>("/api/profile");
}

export function updateDeviceProfile(input: DeviceProfileInput): Promise<DeviceProfile> {
  return customFetch<DeviceProfile>("/api/profile", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}

export interface DeviceCommandResult {
  ok: boolean;
  command: string;
}

export function sendDeviceCommand(command: "REBOOT" | "WIFI_RESET"): Promise<DeviceCommandResult> {
  return customFetch<DeviceCommandResult>("/api/system/device-command", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ command }),
  });
}