import {
  useListRelays,
  useGetLatestReading,
  useHealthCheck,
  getListRelaysQueryKey,
  getGetLatestReadingQueryKey,
  getHealthCheckQueryKey,
  getSystemStatus,
  type Relay,
} from "@/lib/api";
import { useQuery } from "@tanstack/react-query";
import { useTick } from "@/hooks/use-tick";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Cpu, Lock, Radio, OctagonX } from "lucide-react";
import { cn } from "@/lib/utils";
import { getRelayIcon, getRelayLabel } from "@/lib/relay-utils";
import { useCountdown } from "@/hooks/use-countdown";

function formatCountdown(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function DeviceRow({
  icon,
  label,
  status,
  statusVariant,
  detail,
  subdetail,
}: {
  icon: React.ReactNode;
  label: string;
  status: string;
  statusVariant: "on" | "off" | "warn" | "error";
  detail?: string;
  subdetail?: string;
}) {
  const badgeClass = {
    on: "text-[hsl(var(--success))] border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)]",
    off: "text-muted-foreground border-border bg-secondary/30",
    warn: "text-[hsl(var(--warning))] border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)]",
    error: "text-destructive border-destructive/40 bg-destructive/10",
  }[statusVariant];

  return (
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 rounded-lg border border-border/60 bg-card/40 p-3 transition-colors hover:border-card-border hover:bg-card/70">
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <div className="grid shrink-0 place-items-center rounded-lg border border-border/50 bg-secondary/50 p-1.5 sm:p-2">
          {icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{label}</p>
          {detail && (
            <p className="mt-0.5 truncate text-[10px] uppercase tracking-widest text-muted-foreground">
              {detail}
            </p>
          )}
          {subdetail && (
            <p className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
              {subdetail}
            </p>
          )}
        </div>
      </div>
      <Badge variant="outline" className={cn("shrink-0 rounded-md font-mono text-[10px]", badgeClass)}>
        {status}
      </Badge>
    </div>
  );
}

function RelayStatusRow({ relay }: { relay: Relay }) {
  const timeLeft = useCountdown(relay.guardedUntil);
  const isGuarded = timeLeft > 0;

  return (
    <DeviceRow
      icon={getRelayIcon(relay.name, relay.state)}
      label={getRelayLabel(relay.name)}
      status={relay.state ? "ON" : "OFF"}
      statusVariant={relay.state ? "on" : "off"}
      detail={relay.source === "auto" ? "Auto" : "Manual"}
      subdetail={
        isGuarded ? `Locked ${formatCountdown(timeLeft)}` : undefined
      }
    />
  );
}

export function DeviceStatusList() {
  const now = useTick(1000);

  const { data: relays, isLoading: relaysLoading, isError: relaysError } =
    useListRelays({
      query: { queryKey: getListRelaysQueryKey(), refetchInterval: 5_000 },
    });

  const { data: latest } = useGetLatestReading({
    query: { queryKey: getGetLatestReadingQueryKey(), refetchInterval: 5_000 },
  });

  const { data: health, isError: healthError } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 10_000 },
  });

  const { data: systemStatus } = useQuery({
    queryKey: ["system", "status"],
    queryFn: getSystemStatus,
    refetchInterval: 5_000,
  });

  const reading = latest?.reading;
  const readingAge = reading
    ? Math.round((now - new Date(reading.timestamp).getTime()) / 1000)
    : null;

  const sensorOnline = reading !== null && reading !== undefined && (readingAge ?? 999) < 150;
  const serverOnline = !healthError && health?.status === "ok";

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <Cpu className="h-4 w-4 text-primary" />
          Device Status
          <div
            className={cn(
              "ml-auto h-2 w-2 rounded-full",
              serverOnline && sensorOnline
                ? "dot-success"
                : "dot-error",
            )}
          />
        </CardTitle>
      </CardHeader>
      <CardContent className="@container px-3 pb-4 sm:px-6">
        {/* Container query, not a viewport one: this card lives in the
            two-thirds column, so at the `lg` breakpoint the sidebar appears and
            the card gets *narrower* even though the viewport grew. Going two-up
            only once the card itself is wide enough keeps labels from clipping. */}
        <div className="grid grid-cols-1 gap-2 @2xl:grid-cols-2">
        <DeviceRow
          icon={<Radio className="h-5 w-5 text-primary" />}
          label="Backend Server"
          status={serverOnline ? "ONLINE" : "OFFLINE"}
          statusVariant={serverOnline ? "on" : "error"}
          detail="API bridge"
        />

        <DeviceRow
          icon={<OctagonX className="h-5 w-5 text-destructive" />}
          label="Automation"
          status={systemStatus?.automationPaused ? "STOPPED" : "ACTIVE"}
          statusVariant={systemStatus?.automationPaused ? "error" : "on"}
          detail={systemStatus?.automationPaused ? "E-stop active" : "Auto control"}
        />

        <DeviceRow
          icon={<Cpu className="h-5 w-5 text-chart-3" />}
          label="ESP32 Sensor"
          status={sensorOnline ? "ONLINE" : reading ? "STALE" : "OFFLINE"}
          statusVariant={sensorOnline ? "on" : reading ? "warn" : "error"}
          detail="MQTT · sensors"
          subdetail={
            reading
              ? `${readingAge}s ago · ${
                  reading.temp != null ? `${reading.temp.toFixed(1)}°C` : "n/a"
                }`
              : "No data received"
          }
        />

        {relaysLoading ? (
          <>
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
            <Skeleton className="h-14 w-full" />
          </>
        ) : relaysError ? (
          <div className="col-span-full rounded-lg border border-destructive/20 bg-destructive/5 p-3 font-mono text-xs text-destructive">
            Failed to load relay devices
          </div>
        ) : (
          relays?.map((relay) => (
            <RelayStatusRow key={relay.name} relay={relay} />
          ))
        )}

        {relays?.some((r) => r.guardedUntil && new Date(r.guardedUntil) > new Date()) && (
          <p className="col-span-full flex items-center gap-1 pt-1 font-mono text-[10px] text-muted-foreground">
            <Lock className="h-3 w-3 shrink-0" />
            Compressor safety lock active — cannot turn ON until timer expires
          </p>
        )}
        </div>
      </CardContent>
    </Card>
  );
}
