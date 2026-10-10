import { customFetch } from "./custom-fetch";
import type { Relay, RelayName } from "./generated/api.schemas";

export interface RelayAutomationResult {
  ok: true;
  relay: Relay;
  message?: string;
}

/**
 * Stops automation for a single relay: turns the device OFF and disables
 * automation for it. The relay stays OFF and untouched by automation until
 * `activateRelayAutomation` is called for the same relay.
 */
export function stopRelayAutomation(name: RelayName): Promise<RelayAutomationResult> {
  return customFetch<RelayAutomationResult>(`/api/relays/${name}/stop-automation`, {
    method: "POST",
  });
}

/**
 * Re-enables automation for a single relay, handing control back to the
 * threshold-based automation logic (temperature/CO2/humidity).
 */
export function activateRelayAutomation(name: RelayName): Promise<RelayAutomationResult> {
  return customFetch<RelayAutomationResult>(`/api/relays/${name}/activate-automation`, {
    method: "POST",
  });
}
