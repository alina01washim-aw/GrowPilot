import { customFetch } from "./custom-fetch";

export interface DeviceHistoryEvent {
  device: string;
  state: boolean;
  startedAt: string;
  endedAt: string | null;
  source: "manual" | "auto" | "emergency";
  durationMs: number | null;
}

export interface DeviceHistorySummary {
  hours: number;
  summary: Record<
    string,
    {
      onCount: number;
      offCount: number;
      totalOnMs: number;
      lastOnAt: string | null;
    }
  >;
}

export function getDeviceHistory(
  device?: string,
  hours?: number,
): Promise<DeviceHistoryEvent[]> {
  const params = new URLSearchParams();
  if (device) params.set("device", device);
  if (hours) params.set("hours", String(hours));
  const qs = params.toString();
  return customFetch<DeviceHistoryEvent[]>(`/api/devices/history${qs ? `?${qs}` : ""}`);
}

export function getDeviceHistorySummary(
  hours = 24,
): Promise<DeviceHistorySummary> {
  return customFetch<DeviceHistorySummary>(
    `/api/devices/history/summary?hours=${hours}`,
  );
}
