import { useGetLatestReading, getGetLatestReadingQueryKey } from "@/lib/api";
import { getVpdStatus } from "@/lib/api/vpd";
import { VpdGauge } from "@/components/vpd-gauge";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Thermometer, Wind, Activity, Clock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useTick } from "@/hooks/use-tick";
import type { ReactNode } from "react";

interface LiveStatsProps {
  alertIds?: string[];
}

const FRESH_AGE_S = 150;

function formatAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function StatusBadge({
  hasData,
  age,
  label,
  loading,
}: {
  hasData: boolean;
  age: number | null;
  label: string;
  loading: boolean;
}) {
  if (loading) {
    return <Skeleton className="h-5 w-16" />;
  }
  if (!hasData) {
    return (
      <Badge
        variant="outline"
        className="font-mono text-[10px] rounded-sm border-destructive/40 bg-destructive/10 text-destructive"
      >
        NO DATA
      </Badge>
    );
  }
  if (age == null || age <= FRESH_AGE_S) {
    return (
      <Badge
        variant="outline"
        className="rounded-md border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] font-mono text-[10px] text-[hsl(var(--success))] gap-1.5"
      >
        <span className="dot-success h-1.5 w-1.5 rounded-full" />
        {label}
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="rounded-md border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] font-mono text-[10px] text-[hsl(var(--warning))] gap-1.5"
    >
      <span className="dot-warning h-1.5 w-1.5 rounded-full" />
      STALE {formatAge(age)}
    </Badge>
  );
}

function Metric({
  label,
  value,
  unit,
  colorClass,
  decimals = 1,
}: {
  label: string;
  value: number | null | undefined;
  unit: string;
  colorClass?: string;
  decimals?: number;
}) {
  return (
    <div className="min-w-0">
      <div className="truncate text-[10px] font-mono uppercase tracking-widest text-muted-foreground">
        {label}
      </div>
      <div
        className={cn(
          "font-mono font-bold tracking-tight text-foreground max-sm:text-xl sm:text-2xl md:text-[28px] truncate",
          colorClass,
        )}
      >
        {value != null ? (
          <>
            {value.toFixed(decimals)}
            <span className="ml-1 text-xs font-normal text-muted-foreground">
              {unit}
            </span>
          </>
        ) : (
          "--"
        )}
      </div>
    </div>
  );
}

function SensorCard({
  model,
  role,
  interfaceLabel,
  icon,
  status,
  alert,
  loading,
  children,
}: {
  model: string;
  role: string;
  interfaceLabel: string;
  icon: ReactNode;
  status: ReactNode;
  alert: boolean;
  loading: boolean;
  children: ReactNode;
}) {
  return (
    <Card
      className={cn(
        "card-lift group relative min-w-0 overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm",
        "before:pointer-events-none before:absolute before:inset-0 before:rounded-xl before:bg-gradient-to-br before:from-transparent before:via-transparent before:to-[hsl(var(--primary)/0.04)]",
        alert && "border-destructive/60 ring-1 ring-destructive/40",
      )}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[hsl(var(--chart-1))] via-[hsl(var(--chart-2))] to-[hsl(var(--chart-6))] opacity-40 group-hover:opacity-100 transition-opacity",
        )}
      />
      <CardHeader className="flex flex-row items-center justify-between gap-2 border-b border-border/40 px-4 pb-3 pt-4 sm:px-5">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="grid shrink-0 place-items-center rounded-lg border border-border/60 bg-gradient-to-br from-secondary to-secondary/40 p-2 shadow-sm">
            {icon}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="font-mono font-bold text-xs sm:text-sm tracking-tight text-foreground">
                {model}
              </span>
              <span className="rounded-md border border-border/60 bg-background/50 px-1.5 py-px text-[9px] font-mono uppercase tracking-widest text-muted-foreground">
                {interfaceLabel}
              </span>
            </div>
            <p className="mt-0.5 truncate text-[10px] text-muted-foreground font-mono uppercase tracking-wider">
              {role}
            </p>
          </div>
        </div>
        {status}
      </CardHeader>
      <CardContent className="px-4 pb-4 pt-3.5 sm:px-5">
        {loading ? (
          <div className="flex flex-col gap-2.5">
            <Skeleton className="h-8 w-28" />
            <Skeleton className="h-8 w-28" />
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-x-3 gap-y-3">
            {children}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function LiveStats({ alertIds = [] }: LiveStatsProps) {
  const tick = useTick(1000);
  const { data, isLoading, isError } = useGetLatestReading({
    query: {
      queryKey: getGetLatestReadingQueryKey(),
      refetchInterval: 5000,
    },
  });

  const reading = data?.reading;
  const age = reading
    ? Math.round((tick - new Date(reading.timestamp).getTime()) / 1000)
    : null;

  const { data: vpdStatus, isLoading: vpdLoading } = useQuery({
    queryKey: ["vpd", "status"],
    queryFn: getVpdStatus,
    refetchInterval: 5000,
  });

  const hasSht =
    reading?.temp != null && reading?.hum != null;
  const hasScd = reading?.co2 != null;
  const hasDs = reading?.compostTemp != null;
  const hasVpd = reading?.vpd != null;

  const alertTemp = alertIds.some((id) => id.startsWith("temp-"));
  const alertHum = alertIds.some((id) => id.startsWith("hum-"));
  const alertCo2 = alertIds.some((id) => id.startsWith("co2-"));

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-mono text-xs uppercase tracking-widest text-muted-foreground sm:text-sm">
          Live Sensor Readout
          <span aria-hidden className="ml-2 text-muted-foreground/40">//</span>
        </h2>
        <div className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground sm:text-xs">
          <Clock className="h-3.5 w-3.5" />
          {reading ? (
            <span>
              Last sample {formatAge(age ?? 0)} ago
              <span className={cn("ml-1.5", (age ?? 999) > FRESH_AGE_S ? "text-[hsl(var(--warning))]" : "text-[hsl(var(--success))]")}>
                · {(age ?? 999) <= FRESH_AGE_S ? "RECEIVING" : "STALE"}
              </span>
            </span>
          ) : (
            <span>Waiting for data…</span>
          )}
        </div>
      </div>

      {/* Container queries so the card count tracks the available width rather
          than the viewport — at `lg` the sidebar appears and steals 240px. */}
      <div className="@container">
        {/* Named container breakpoints only — Tailwind emits arbitrary
            `@min-[…]` variants *before* the named ones, so an arbitrary
            threshold here would lose the cascade to `@lg`. */}
        <div className="grid grid-cols-1 gap-3 @lg:grid-cols-2 @5xl:grid-cols-4 sm:gap-4">
        <SensorCard
          model="SHT40"
          role="Ambient Air"
          interfaceLabel="I²C · 0x44"
          icon={<Thermometer className="h-5 w-5 text-chart-1" />}
          status={
            <StatusBadge hasData={hasSht} age={age} label="LIVE" loading={isLoading} />
          }
          alert={alertTemp || alertHum}
          loading={isLoading}
        >
          <Metric
            label="Air Temp"
            value={reading?.temp}
            unit="°C"
            colorClass={cn(
              "text-chart-1",
              alertTemp && "text-destructive animate-pulse",
            )}
          />
          <Metric
            label="Humidity"
            value={reading?.hum}
            unit="%"
            colorClass={cn(
              "text-chart-2",
              alertHum && "text-destructive animate-pulse",
            )}
          />
        </SensorCard>

        <SensorCard
          model="SCD40"
          role="CO₂ Monitor"
          interfaceLabel="I²C · 0x62"
          icon={<Wind className="h-5 w-5 text-chart-3" />}
          status={<StatusBadge hasData={hasScd} age={age} label="CO₂ LIVE" loading={isLoading} />}
          alert={alertCo2}
          loading={isLoading}
        >
          <Metric
            label="CO₂"
            value={reading?.co2}
            unit="ppm"
            colorClass={cn(
              "text-chart-3",
              alertCo2 && "text-destructive animate-pulse",
            )}
            decimals={0}
          />
          <Metric
            label="Chip Temp"
            value={reading?.scdTemp}
            unit="°C"
            colorClass="text-chart-4"
          />
          <Metric
            label="Chip RH"
            value={reading?.scdHum}
            unit="%"
            colorClass="text-chart-5"
          />
        </SensorCard>

        <SensorCard
          model="DS18B20"
          role="Compost Probe"
          interfaceLabel="1-Wire"
          icon={<Thermometer className="h-5 w-5 text-chart-6" />}
          status={<StatusBadge hasData={hasDs} age={age} label="LIVE" loading={isLoading} />}
          alert={false}
          loading={isLoading}
        >
          <Metric
            label="Compost Temp"
            value={reading?.compostTemp}
            unit="°C"
            colorClass="text-chart-6"
          />
          <p className="col-span-2 border-t border-border/40 pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
            Substrate temperature from the probe buried in the compost
          </p>
        </SensorCard>

        <SensorCard
          model="VPD"
          role="Surface VPD"
          interfaceLabel="Derived"
          icon={<Activity className="h-5 w-5 text-primary" />}
          status={<StatusBadge hasData={hasVpd} age={age} label="LIVE" loading={isLoading} />}
          alert={false}
          loading={isLoading}
        >
          <div className="col-span-2 min-w-0">
            <VpdGauge
              vpd={vpdStatus?.surface_vpd_kpa ?? null}
              targetMin={vpdStatus?.target_min ?? 0.15}
              targetMax={vpdStatus?.target_max ?? 0.35}
              warningMargin={0.05}
              statusCode={vpdStatus?.status_code ?? null}
              statusMessage={vpdStatus?.status_message ?? null}
              loading={vpdLoading}
            />
          </div>
        </SensorCard>
        </div>
      </div>

      {isError && (
        <div className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 font-mono text-xs text-destructive">
          Failed to load live sensor data — check server connection.
        </div>
      )}
    </div>
  );
}
