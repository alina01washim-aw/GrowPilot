import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { subDays, subHours, startOfDay } from "date-fns";
import {
  getDeviceHistory,
  getDeviceHistorySummary,
  type DeviceHistoryEvent,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart3,
  Clock,
  Power,
  PowerOff,
  Timer,
  Zap,
} from "lucide-react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";
import { SectionHeading } from "@/components/layout/section-heading";
import { deviceLabel } from "@/lib/device-registry";
import { DatePickerWithRange } from "@/components/date-range-picker";
import { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { useMemo } from "react";

interface TimePreset {
  label: string;
  hours: number;
  getRange: () => DateRange;
}

const TIME_PRESETS: TimePreset[] = [
  { label: "1h", hours: 1, getRange: () => ({ from: subHours(new Date(), 1), to: new Date() }) },
  { label: "Today", hours: 24, getRange: () => ({ from: startOfDay(new Date()), to: new Date() }) },
  { label: "24h", hours: 24, getRange: () => ({ from: subHours(new Date(), 24), to: new Date() }) },
  { label: "7d", hours: 168, getRange: () => ({ from: subDays(new Date(), 7), to: new Date() }) },
  { label: "30d", hours: 720, getRange: () => ({ from: subDays(new Date(), 30), to: new Date() }) },
];

// Fixed device order for the cards, chart series and colours. Names come from
// the device registry so a renamed device reads correctly throughout.
const DEVICE_KEYS = ["fan", "ac", "mist_maker", "uv"];

const DEVICE_COLORS: Record<string, string> = {
  fan: "#3b82f6",
  ac: "#ef4444",
  mist_maker: "#06b6d4",
  uv: "#eab308",
};

function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  return `${minutes}m`;
}

function formatRangeLabel(hours: number): string {
  if (hours <= 1) return "Last hour";
  if (hours < 48) return `Last ${Math.round(hours)}h`;
  return `Last ${Math.round(hours / 24)}d`;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** Bucket width that keeps the bar count readable across the selected span. */
function bucketSizeFor(hours: number): number {
  if (hours <= 6) return 15 * MINUTE_MS;
  if (hours <= 48) return HOUR_MS;
  return DAY_MS;
}

function formatBucketLabel(timestamp: number, bucketMs: number): string {
  const date = new Date(timestamp);
  if (bucketMs >= DAY_MS) {
    return date.toLocaleDateString([], { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

export function DeviceHistory() {
  const [dateRange, setDateRange] = useState<DateRange | undefined>(() => {
    const to = new Date();
    const from = new Date(to);
    from.setDate(to.getDate() - 30);
    return { from, to };
  });

  // `to` is undefined while the user is mid-selection in the range picker.
  const hours = useMemo(() => {
    const from = dateRange?.from;
    if (!from) return 720;
    const to = dateRange?.to ?? new Date();
    const span = Math.ceil((to.getTime() - from.getTime()) / HOUR_MS);
    return span > 0 ? span : 1;
  }, [dateRange]);

  const summaryQuery = useQuery({
    queryKey: ["device-history-summary", hours],
    queryFn: () => getDeviceHistorySummary(hours),
    refetchInterval: 30_000,
  });

  const eventsQuery = useQuery({
    queryKey: ["device-history-events", hours],
    queryFn: () => getDeviceHistory(undefined, hours),
    refetchInterval: 30_000,
  });

  const summary = summaryQuery.data?.summary ?? {};
  const events = eventsQuery.data ?? [];

  const chartData = useMemo(() => {
    const now = Date.now();
    const bucketMs = bucketSizeFor(hours);
    const buckets = new Map<number, Record<string, number>>();

    for (const ev of events) {
      if (!ev.state) continue;
      const started = new Date(ev.startedAt).getTime();
      const ended = ev.endedAt ? new Date(ev.endedAt).getTime() : now;
      const durationMs = ev.durationMs ?? ended - started;
      if (durationMs <= 0) continue;

      // Bucket by absolute timestamp — a time-of-day key would merge
      // different days into one bar on multi-day ranges.
      const bucketStart = Math.floor(started / bucketMs) * bucketMs;
      const bucket = buckets.get(bucketStart) ?? {};
      // The Y axis is labelled in minutes, so store minutes, not milliseconds.
      bucket[ev.device] = (bucket[ev.device] ?? 0) + durationMs / MINUTE_MS;
      buckets.set(bucketStart, bucket);
    }

    return [...buckets.entries()]
      .sort((a, b) => a[0] - b[0])
      .slice(-50)
      .map(([timestamp, devices]) => {
        const rounded: Record<string, number> = {};
        for (const [device, minutes] of Object.entries(devices)) {
          rounded[device] = Math.round(minutes * 10) / 10;
        }
        return { time: formatBucketLabel(timestamp, bucketMs), ...rounded };
      });
  }, [events, hours]);

  const isLoading = summaryQuery.isLoading || eventsQuery.isLoading;
  const isError = summaryQuery.isError || eventsQuery.isError;

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={<BarChart3 className="h-4 w-4" />}
        title="Device History"
        description="Runtime tracking and usage graphs for all devices"
        right={
          <div className="flex flex-wrap items-center gap-2">
            <div className="hidden flex-wrap gap-1 sm:flex">
              {TIME_PRESETS.map((preset) => (
                <Button
                  key={preset.label}
                  variant="outline"
                  size="sm"
                  className="h-8 px-2 text-[10px] font-mono font-semibold uppercase tracking-wider"
                  onClick={() => setDateRange(preset.getRange())}
                >
                  {preset.label}
                </Button>
              ))}
            </div>
            <DatePickerWithRange date={dateRange} setDate={setDateRange} className="w-full sm:w-auto" />
          </div>
        }
      />

      {isLoading ? (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-[120px] w-full" />
          ))}
        </div>
      ) : isError ? (
        <Card className="border-destructive/20 bg-destructive/5">
          <CardContent className="p-4 text-sm text-destructive">
            Failed to load device history. Check server connection.
          </CardContent>
        </Card>
      ) : (
        <>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {DEVICE_KEYS.map((key) => {
              const data = summary[key] || {
                onCount: 0,
                offCount: 0,
                totalOnMs: 0,
                lastOnAt: null,
              };
              return (
                <Card
                  key={key}
                  className="card-lift border-card-border bg-card/70 backdrop-blur-sm"
                >
                  <CardHeader className="pb-2">
                    <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
                      <Power
                        className="h-3.5 w-3.5"
                        style={{ color: DEVICE_COLORS[key] }}
                      />
                      {deviceLabel(key)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <Timer className="h-3 w-3" />
                        Total ON
                      </span>
                      <span className="font-mono text-sm font-semibold">
                        {formatDuration(data.totalOnMs)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <Zap className="h-3 w-3" />
                        Cycles
                      </span>
                      <span className="font-mono text-sm font-semibold">
                        {data.onCount}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="flex items-center gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                        <Clock className="h-3 w-3" />
                        Last ON
                      </span>
                      <span className="font-mono text-xs text-muted-foreground">
                        {data.lastOnAt
                          ? new Date(data.lastOnAt).toLocaleTimeString([], {
                              hour: "2-digit",
                              minute: "2-digit",
                            })
                          : "Never"}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
          </div>

          <Card className="card-lift border-card-border bg-card/70 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
                <BarChart3 className="h-4 w-4 text-primary" />
                Runtime Graph ({formatRangeLabel(hours)})
              </CardTitle>
              <p className="font-mono text-[11px] text-muted-foreground">
                Duration (minutes) each device was ON per time bucket
              </p>
            </CardHeader>
            <CardContent>
              {chartData.length === 0 ? (
                <p className="py-8 text-center font-mono text-xs text-muted-foreground">
                  No runtime data available yet. Devices will be tracked after
                  the first ON/OFF cycle.
                </p>
              ) : (
                <div className="h-[300px] w-full">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" className="stroke-slate-200 dark:stroke-slate-800" />
                      <XAxis
                        dataKey="time"
                        tick={{ fontSize: 10, fontFamily: "monospace" }}
                        className="text-muted-foreground"
                      />
                      <YAxis
                        tick={{ fontSize: 10, fontFamily: "monospace" }}
                        className="text-muted-foreground"
                        label={{
                          value: "Minutes ON",
                          angle: -90,
                          position: "insideLeft",
                          style: { fontSize: 10, fontFamily: "monospace" },
                        }}
                      />
                      <Tooltip
                        contentStyle={{
                          fontFamily: "monospace",
                          fontSize: 12,
                          borderRadius: 8,
                          border: "1px solid hsl(var(--border))",
                        }}
                      />
                      <Legend />
                      {DEVICE_KEYS.map((key) => (
                        <Bar
                          key={key}
                          dataKey={key}
                          name={deviceLabel(key)}
                          fill={DEVICE_COLORS[key]}
                          stackId="a"
                        />
                      ))}
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}
            </CardContent>
          </Card>

          <Card className="card-lift border-card-border bg-card/70 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
                <PowerOff className="h-4 w-4 text-primary" />
                Recent Events
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="max-h-[400px] space-y-1 overflow-y-auto">
                {events.slice(0, 50).map((ev, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between rounded-lg border border-border/50 bg-secondary/20 px-3 py-2"
                  >
                    <div className="flex items-center gap-3">
                      <span
                        className="flex h-2 w-2 rounded-full"
                        style={{
                          backgroundColor: ev.state
                            ? DEVICE_COLORS[ev.device]
                            : "#94a3b8",
                        }}
                      />
                      <span className="font-mono text-xs font-medium">
                        {deviceLabel(ev.device)}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <span
                        className={`font-mono text-[10px] uppercase tracking-wider ${
                          ev.state
                            ? "text-[hsl(var(--success))]"
                            : "text-muted-foreground"
                        }`}
                      >
                        {ev.state ? "ON" : "OFF"}
                      </span>
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {new Date(ev.startedAt).toLocaleString([], {
                          month: "short",
                          day: "numeric",
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </span>
                      {ev.durationMs != null && ev.durationMs > 0 && (
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {formatDuration(ev.durationMs)}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                {events.length === 0 && (
                  <p className="py-4 text-center font-mono text-xs text-muted-foreground">
                    No events recorded yet.
                  </p>
                )}
              </div>
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
