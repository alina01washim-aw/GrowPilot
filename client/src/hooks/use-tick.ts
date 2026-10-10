import { useEffect, useState } from "react";

/** Re-renders every `intervalMs` — useful for live age counters. */
export function useTick(intervalMs = 1000): number {
  const [tick, setTick] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setTick(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return tick;
}
