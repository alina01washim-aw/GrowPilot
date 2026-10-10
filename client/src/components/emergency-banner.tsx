import {
  AlertTriangle,
  Bell,
  BellOff,
  Siren,
  Volume2,
  VolumeX,
  AlarmClock,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useTick } from "@/hooks/use-tick";
import type { EmergencyState } from "@/hooks/use-emergency-alert";

interface EmergencyBannerProps {
  emergency: EmergencyState;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function EmergencyBanner({ emergency }: EmergencyBannerProps) {
  const {
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
  } = emergency;

  const now = useTick(1000);

  if (!isEmergency) return null;

  const criticalCount = alerts.filter((a) => a.severity === "critical").length;
  const hasCritical = criticalCount > 0;
  const snoozed =
    snoozedUntil !== null && now < snoozedUntil;
  const snoozeLeftMs = snoozedUntil !== null ? snoozedUntil - now : 0;

  return (
    <div
      role="alert"
      className={cn(
        "relative z-[1] mb-4 overflow-hidden rounded-xl border shadow-xl backdrop-blur-sm",
        hasCritical
          ? "border-destructive/60 bg-destructive/10 shadow-destructive/10"
          : "border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.08)] shadow-[hsl(var(--warning)/0.08)]",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-[3px]",
          hasCritical
            ? "bg-gradient-to-r from-destructive/0 via-destructive to-destructive/0"
            : "bg-gradient-to-r from-[hsl(var(--warning)/0)] via-[hsl(var(--warning))] to-[hsl(var(--warning)/0)]",
        )}
      />

      <div className="flex flex-col gap-3 p-4 sm:p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2 font-mono uppercase tracking-widest">
              <Siren
                className={cn(
                  "h-4 w-4 shrink-0",
                  hasCritical
                    ? "text-destructive animate-pulse"
                    : "text-[hsl(var(--warning))]",
                )}
              />
              <span
                className={cn(
                  "text-sm font-bold sm:text-base",
                  hasCritical ? "text-destructive" : "text-[hsl(var(--warning))]",
                )}
              >
                {hasCritical ? "Emergency Alert" : "Environment Warning"}
              </span>
              <Badge
                variant={hasCritical ? "destructive" : "outline"}
                className={cn(
                  "rounded-md font-mono text-[10px]",
                  !hasCritical && "border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.1)] text-[hsl(var(--warning))]",
                )}
              >
                {alerts.length} ACTIVE
              </Badge>
              {muted && (
                <Badge
                  variant="outline"
                  className="rounded-md font-mono text-[10px] border-border/60 text-muted-foreground"
                >
                  <BellOff className="mr-1 h-3 w-3" />
                  SOUND OFF
                </Badge>
              )}
            </div>

            <div className="mt-2.5 space-y-1.5">
              {alerts.map((alert) => (
                <div
                  key={alert.id}
                  className="flex items-start gap-2 rounded-lg border border-border/40 bg-background/40 px-2.5 py-1.5"
                >
                  <span
                    className={cn(
                      "mt-[5px] h-1.5 w-1.5 shrink-0 rounded-full",
                      alert.severity === "critical"
                        ? "bg-destructive"
                        : "bg-[hsl(var(--warning))]",
                    )}
                  />
                  <p className="min-w-0 font-mono text-[11px] leading-relaxed break-words sm:text-xs">
                    <span
                      className={cn(
                        "font-bold",
                        alert.severity === "critical"
                          ? "text-destructive"
                          : "text-[hsl(var(--warning))]",
                      )}
                    >
                      {alert.title}:
                    </span>{" "}
                    <span className="text-foreground/90">{alert.message}</span>
                  </p>
                </div>
              ))}
            </div>
          </div>

          <div className="flex w-full shrink-0 flex-wrap items-center gap-2 lg:w-auto">
            {audioBlocked && (
              <Button
                size="sm"
                variant="secondary"
                className="h-8 font-mono text-[10px] sm:text-xs animate-pulse"
                onClick={() => void enableAudio()}
              >
                <Volume2 className="mr-1 h-3.5 w-3.5" />
                Enable Sound
              </Button>
            )}

            <div className="flex items-center overflow-hidden rounded-lg border border-border/60 bg-background/50">
              <button
                type="button"
                onClick={() => changeSoundMode("ambulance")}
                className={cn(
                  "flex h-8 items-center gap-1 px-2.5 font-mono text-[10px] transition-colors",
                  soundMode === "ambulance"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                title="Siren sound"
              >
                <Siren className="h-3.5 w-3.5" />
                Siren
              </button>
              <button
                type="button"
                onClick={() => changeSoundMode("beep")}
                className={cn(
                  "flex h-8 items-center gap-1 px-2.5 font-mono text-[10px] transition-colors",
                  soundMode === "beep"
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                )}
                title="Beep sound"
              >
                <VolumeX className="h-3.5 w-3.5" />
                Beep
              </button>
            </div>

            <Button
              size="sm"
              variant={muted ? "default" : "outline"}
              className="h-8 font-mono text-[10px] sm:text-xs"
              onClick={toggleMute}
              title={muted ? "Unmute alert sound" : "Mute alert sound"}
            >
              {muted ? (
                <BellOff className="mr-1 h-3.5 w-3.5" />
              ) : (
                <Bell className="mr-1 h-3.5 w-3.5" />
              )}
              {muted ? "Unmute" : "Mute"}
            </Button>

            <Button
              size="sm"
              variant="outline"
              className="h-8 font-mono text-[10px] sm:text-xs"
              onClick={snooze}
              disabled={snoozed}
              title="Stop sound for 5 minutes"
            >
              <AlarmClock className="mr-1 h-3.5 w-3.5" />
              {snoozed ? `Snoozed ${formatCountdown(snoozeLeftMs)}` : "Snooze 5m"}
            </Button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-0.5 border-t border-border/30 pt-2 font-mono text-[9px] uppercase tracking-widest text-muted-foreground/70">
          <span className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3" />
            Sound: {muted ? "Muted" : "On"}
          </span>
          <span>Mode: {soundMode === "ambulance" ? "Siren" : "Beep"}</span>
          <span>
            {criticalCount > 0
              ? `${criticalCount} Critical`
              : `${alerts.length} Warning`}
          </span>
          {snoozed && <span>· Resumes in {formatCountdown(snoozeLeftMs)}</span>}
        </div>
      </div>
    </div>
  );
}
