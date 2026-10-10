import { customFetch } from "./custom-fetch";

export type VpdStatusCode =
  | "DARK_GREEN"
  | "LIGHT_GREEN"
  | "YELLOW"
  | "ORANGE"
  | "RED"
  | "NO_DATA";

export interface VpdStatus {
  co2_ppm: number | null;
  air_temp_c: number | null;
  air_rh: number | null;
  compost_temp_c: number | null;
  surface_vpd_kpa: number | null;
  target_min: number;
  target_max: number;
  status_code: VpdStatusCode;
  status_message: string;
}

export interface VpdTargets {
  vpdTargetMin: number;
  vpdTargetMax: number;
  vpdWarningMargin: number;
  updatedAt: string;
}

export interface VpdTargetsInput {
  vpdTargetMin?: number;
  vpdTargetMax?: number;
  vpdWarningMargin?: number;
}

/** Structured surface-VPD snapshot for the BP-style gauge. */
export function getVpdStatus(): Promise<VpdStatus> {
  return customFetch<VpdStatus>("/api/vpd/status");
}

export function getVpdTargets(): Promise<VpdTargets> {
  return customFetch<VpdTargets>("/api/vpd/targets");
}

export function updateVpdTargets(input: VpdTargetsInput): Promise<VpdTargets> {
  return customFetch<VpdTargets>("/api/vpd/targets", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
}
