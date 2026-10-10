import {
  Fan,
  Snowflake,
  Flame,
  Droplets,
  Lightbulb,
  Waves,
  Cpu,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { DeviceIconId } from "@/lib/api/device-control";

/**
 * The one place device names and icons are resolved.
 *
 * Labels used to be duplicated across seven modules, each with its own hardcoded
 * copy — and `device-controls.tsx` preferred its copy over the server's, so a
 * renamed device kept showing the built-in name everywhere. Now the server owns
 * both, and everything reads through here.
 *
 * This is a plain module rather than a hook because several consumers are pure
 * functions that compose toast text (`describeStageApplication`,
 * `describeResume`) and cannot call hooks. `getDeviceControls()` refreshes the
 * registry on every fetch, which is the single choke point for device metadata.
 * Seeded with the shipped defaults so labels are still sensible before the first
 * response lands.
 */

interface DeviceMeta {
  label: string;
  icon: DeviceIconId;
}

const SEED: Record<string, DeviceMeta> = {
  fan: { label: "Exhaust Fan", icon: "fan" },
  ac: { label: "AC Compressor", icon: "cooling" },
  mist_maker: { label: "Mist Maker", icon: "mist" },
  uv: { label: "UV-C Light", icon: "light" },
};

const registry = new Map<string, DeviceMeta>(Object.entries(SEED));

/** Called by `getDeviceControls()` after every successful fetch. */
export function syncDeviceRegistry(
  devices: Array<{ key: string; label: string; icon: string }>,
): void {
  for (const d of devices) {
    registry.set(d.key, { label: d.label, icon: d.icon as DeviceIconId });
  }
}

/** Display name for a device key. Falls back to the key so nothing renders blank. */
export function deviceLabel(key: string): string {
  return registry.get(key)?.label ?? key;
}

/** Joins device keys into a readable list using their current names. */
export function deviceLabels(keys: string[]): string {
  return keys.map(deviceLabel).join(", ");
}

export function deviceIconId(key: string): DeviceIconId {
  return registry.get(key)?.icon ?? "device";
}

/** Every device the registry knows about, for pickers and checklists. */
export function knownDevices(): Array<{ key: string; label: string }> {
  return [...registry.entries()].map(([key, meta]) => ({ key, label: meta.label }));
}

const ICON_COMPONENTS = {
  fan: Fan,
  cooling: Snowflake,
  heat: Flame,
  mist: Droplets,
  light: Lightbulb,
  pump: Waves,
  device: Cpu,
} as const satisfies Record<DeviceIconId, unknown>;

export const ICON_CHOICES: Array<{ id: DeviceIconId; label: string }> = [
  { id: "fan", label: "Fan" },
  { id: "cooling", label: "Cooling" },
  { id: "heat", label: "Heating" },
  { id: "mist", label: "Mist / water" },
  { id: "light", label: "Light / UV" },
  { id: "pump", label: "Pump" },
  { id: "device", label: "Generic" },
];

/** Renders a device's icon by id, so a renamed device can change its symbol. */
export function DeviceIcon({
  icon,
  className,
}: {
  icon: DeviceIconId | string;
  className?: string;
}) {
  const Component = ICON_COMPONENTS[icon as DeviceIconId] ?? Cpu;
  return <Component className={cn("h-5 w-5", className)} />;
}

/** Convenience for callers that only have a key. */
export function DeviceIconForKey({
  deviceKey,
  className,
}: {
  deviceKey: string;
  className?: string;
}) {
  return <DeviceIcon icon={deviceIconId(deviceKey)} className={className} />;
}
