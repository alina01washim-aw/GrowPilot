import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import {
  useGetLatestReading,
  useHealthCheck,
  useListRelays,
  getGetLatestReadingQueryKey,
  getHealthCheckQueryKey,
  getListRelaysQueryKey,
} from "@/lib/api";
import { getEmergencyThresholds } from "@/lib/api/system";
import { EmergencySound, type AlertSoundMode } from "@/lib/emergency-sound";
import { useToast } from "@/hooks/use-toast";

export type EmergencySeverity = "critical" | "warning";

export interface EmergencyAlert {
  id: string;
  severity: EmergencySeverity;
  title: string;
  message: string;
}

const STALE_READING_MS = 60_000;
const SNOOZE_MS = 5 * 60_000;

function checkThresholdBreaches(
  reading: { temp: number | null; hum: number | null; co2: number | null },
  settings: {
    tempMin: number;
    tempMax: number;
    humidityMin: number;
    humidityMax: number;
    co2Min: number;
    co2Max: number;
  },
): EmergencyAlert[] {
  const alerts: EmergencyAlert[] = [];
  const { temp, hum, co2 } = reading;

  if (temp != null && temp > settings.tempMax) {
    alerts.push({
      id: "temp-high",
      severity: "critical",
      title: "Temperature High",
      message: `${temp.toFixed(1)}°C exceeds max ${settings.tempMax}°C`,
    });
  } else if (temp != null && temp < settings.tempMin) {
    alerts.push({
      id: "temp-low",
      severity: "warning",
      title: "Temperature Low",
      message: `${temp.toFixed(1)}°C below min ${settings.tempMin}°C`,
    });
  }

  if (hum != null && hum > settings.humidityMax) {
    alerts.push({
      id: "hum-high",
      severity: "warning",
      title: "Humidity High",
      message: `${hum.toFixed(1)}% exceeds max ${settings.humidityMax}%`,
    });
  } else if (hum != null && hum < settings.humidityMin) {
    alerts.push({
      id: "hum-low",
      severity: "critical",
      title: "Humidity Low",
      message: `${hum.toFixed(1)}% below min ${settings.humidityMin}%`,
    });
  }

  if (co2 != null && co2 > settings.co2Max) {
    alerts.push({
      id: "co2-high",
      severity: "critical",
      title: "CO₂ High",
      message: `${Math.round(co2)} ppm exceeds max ${settings.co2Max} ppm`,
    });
  } else if (co2 != null && co2 < settings.co2Min) {
    alerts.push({
      id: "co2-low",
      severity: "warning",
      title: "CO₂ Low",
      message: `${Math.round(co2)} ppm below min ${settings.co2Min} ppm`,
    });
  }

  return alerts;
}

export function useEmergencyAlert() {
  const { toast } = useToast();
  const soundRef = useRef(new EmergencySound());
  const prevAlertKeyRef = useRef("");
  const snoozeUntilRef = useRef(0);

  const [muted, setMuted] = useState(
    () => sessionStorage.getItem("emergency-muted") === "true",
  );
  const [soundMode, setSoundMode] = useState<AlertSoundMode>(
    () =>
      (sessionStorage.getItem("emergency-sound-mode") as AlertSoundMode) ??
      "ambulance",
  );
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [snoozedUntil, setSnoozedUntil] = useState<number | null>(null);

  const { data: health, isError: healthError } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 10_000 },
  });

  const { data: latestData } = useGetLatestReading({
    query: { queryKey: getGetLatestReadingQueryKey(), refetchInterval: 5_000 },
  });

  const { data: emergencyThresholds } = useQuery({
    queryKey: ["emergency-thresholds"],
    queryFn: () => getEmergencyThresholds(),
    refetchInterval: 5_000,
  });

  useListRelays({
    query: { queryKey: getListRelaysQueryKey(), refetchInterval: 5_000 },
  });

  const alerts = useMemo(() => {
    const result: EmergencyAlert[] = [];

    if (healthError || health?.status !== "ok") {
      result.push({
        id: "system-offline",
        severity: "critical",
        title: "System Offline",
        message: "Server connection lost — check network and backend",
      });
      return result;
    }

    const reading = latestData?.reading;
    if (!reading) {
      result.push({
        id: "no-reading",
        severity: "critical",
        title: "No Sensor Data",
        message: "ESP32 sensor has not reported any readings yet",
      });
      return result;
    }

    const age = Date.now() - new Date(reading.timestamp).getTime();
    if (age > STALE_READING_MS) {
      result.push({
        id: "sensor-stale",
        severity: "critical",
        title: "Sensor Offline",
        message: `Last reading ${Math.round(age / 1000)}s ago — ESP32 may be disconnected`,
      });
    }

    if (emergencyThresholds) {
      result.push(...checkThresholdBreaches(reading, emergencyThresholds));
    }

    return result;
  }, [health, healthError, latestData, emergencyThresholds]);

  const isEmergency = alerts.length > 0;
  const isSnoozed = snoozedUntil !== null && Date.now() < snoozedUntil;
  const shouldPlaySound = isEmergency && !muted && !isSnoozed;

  const enableAudio = useCallback(async () => {
    const ok = await soundRef.current.start();
    if (ok) {
      soundRef.current.stop();
      setAudioBlocked(false);
    }
    return ok;
  }, []);

  const toggleMute = useCallback(() => {
    setMuted((prev) => {
      const next = !prev;
      sessionStorage.setItem("emergency-muted", String(next));
      return next;
    });
  }, []);

  const snooze = useCallback(() => {
    const until = Date.now() + SNOOZE_MS;
    snoozeUntilRef.current = until;
    setSnoozedUntil(until);
    soundRef.current.stop();
  }, []);

  const changeSoundMode = useCallback((mode: AlertSoundMode) => {
    setSoundMode(mode);
    sessionStorage.setItem("emergency-sound-mode", mode);
    soundRef.current.setMode(mode);
  }, []);

  useEffect(() => {
    soundRef.current.setMode(soundMode);
  }, [soundMode]);

  useEffect(() => {
    if (!shouldPlaySound) {
      soundRef.current.stop();
      return;
    }

    void soundRef.current.start().then((ok) => {
      if (!ok) setAudioBlocked(true);
    });

    return () => soundRef.current.stop();
  }, [shouldPlaySound, soundMode]);

  useEffect(() => {
    if (!isEmergency) {
      prevAlertKeyRef.current = "";
      return;
    }

    const alertKey = alerts.map((a) => a.id).join(",");
    if (alertKey !== prevAlertKeyRef.current) {
      prevAlertKeyRef.current = alertKey;
      const primary =
        alerts.find((a) => a.severity === "critical") ?? alerts[0];
      toast({
        variant: "destructive",
        title: `EMERGENCY: ${primary.title}`,
        description: primary.message,
      });
    }
  }, [alerts, isEmergency, toast]);

  useEffect(() => {
    if (!snoozedUntil) return;
    const remaining = snoozedUntil - Date.now();
    if (remaining <= 0) {
      setSnoozedUntil(null);
      return;
    }
    const timer = setTimeout(() => setSnoozedUntil(null), remaining);
    return () => clearTimeout(timer);
  }, [snoozedUntil]);

  useEffect(() => () => soundRef.current.stop(), []);

  return {
    alerts,
    isEmergency,
    muted,
    soundMode,
    audioBlocked,
    snoozedUntil,
    toggleMute,
    snooze,
    changeSoundMode,
    enableAudio,
  };
}

export type EmergencyState = ReturnType<typeof useEmergencyAlert>;

/**
 * The alert hook must live in exactly ONE mounted instance — a second
 * instance would create a second siren loop with its own mute state, so
 * muting one banner would never stop the other. Consumers below the
 * provider share the singleton state instead of re-running the hook.
 */
const EmergencyContext = createContext<EmergencyState | null>(null);

export function EmergencyProvider({ children }: { children: ReactNode }) {
  const state = useEmergencyAlert();
  return (
    <EmergencyContext.Provider value={state}>
      {children}
    </EmergencyContext.Provider>
  );
}

export function useEmergency(): EmergencyState {
  const ctx = useContext(EmergencyContext);
  if (!ctx) {
    throw new Error("useEmergency must be used inside <EmergencyProvider>");
  }
  return ctx;
}
