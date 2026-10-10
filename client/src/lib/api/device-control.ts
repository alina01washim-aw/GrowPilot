import { customFetch } from "./custom-fetch";
import { syncDeviceRegistry } from "@/lib/device-registry";

export type DeviceMode = "auto" | "manual";

export const DEVICE_ICON_IDS = [
  "fan",
  "cooling",
  "heat",
  "mist",
  "light",
  "pump",
  "device",
] as const;
export type DeviceIconId = (typeof DEVICE_ICON_IDS)[number];

export interface DeviceControlView {
  key: string;
  label: string;
  icon: string;
  index: number;
  mode: DeviceMode;
  state: boolean;
  guardedUntil: string | null;
}

/**
 * Lists every controllable device with its AUTO/MANUAL mode and state.
 *
 * Also refreshes the device registry: this is the only endpoint that carries
 * device names and icons, so it is the natural place to keep the app-wide
 * lookup current. See `lib/device-registry.tsx`.
 */
export async function getDeviceControls(): Promise<DeviceControlView[]> {
  const devices = await customFetch<DeviceControlView[]>("/api/devices/control");
  syncDeviceRegistry(devices);
  return devices;
}

/**
 * Renames a device and/or changes its icon.
 *
 * Only the display name changes — the device `key` is immutable, because every
 * automation rule, crop stage plan and runtime history record references it.
 */
export function renameDevice(
  key: string,
  patch: { label?: string; icon?: DeviceIconId },
): Promise<DeviceControlView> {
  return customFetch<DeviceControlView>(`/api/devices/${key}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
}

/** Switches a device between AUTO (rules) and MANUAL (user) mode. */
export function setDeviceMode(
  key: string,
  mode: DeviceMode,
): Promise<DeviceControlView> {
  return customFetch<DeviceControlView>(`/api/devices/${key}/mode`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ mode }),
  });
}

/** Manual on/off command for a device in MANUAL mode. */
export function setDeviceState(key: string, on: boolean): Promise<DeviceControlView> {
  return customFetch<DeviceControlView>(`/api/devices/${key}/state`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on }),
  });
}