import { cn } from "@/lib/utils";
import { DeviceIcon, deviceIconId, deviceLabel } from "@/lib/device-registry";
import type { RelayName } from "@/lib/api";

/**
 * The legacy `Relay` collection names its three documents fan/fridge/humidifier,
 * while rules, crop stages and the device registry use the logical keys
 * fan/ac/mist_maker. Anything showing a legacy relay has to cross that boundary
 * to pick up the grower's chosen name.
 */
const KEY_BY_RELAY_NAME: Record<string, string> = {
  fan: "fan",
  fridge: "ac",
  humidifier: "mist_maker",
};

export function relayDeviceKey(name: RelayName | string): string {
  return KEY_BY_RELAY_NAME[name] ?? name;
}

export function getRelayLabel(name: RelayName | string): string {
  return deviceLabel(relayDeviceKey(name));
}

export function getRelayIcon(name: RelayName | string, state: boolean) {
  const key = relayDeviceKey(name);
  const spinning = deviceIconId(key) === "fan" && state;
  return (
    <DeviceIcon
      icon={deviceIconId(key)}
      className={cn(
        state ? "text-[hsl(var(--success))]" : "text-muted-foreground",
        spinning && "animate-spin [animation-duration:3s]",
      )}
    />
  );
}
