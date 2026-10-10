import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { Activity, ArrowRight, Power, ShieldAlert, Sparkles } from "lucide-react";
import { LiveStats } from "@/components/live-stats";
import { DeviceStatusList } from "@/components/device-status-list";
import { EmergencyStopPanel } from "@/components/emergency-stop";
import { CropCycleCard } from "@/components/crop-cycle-card";
import { CropSchedule } from "@/components/crop-schedule";
import { useEmergency } from "@/hooks/use-emergency-alert";
import {
  useListReadings,
  getRuleList,
  sendDeviceCommand,
  getCropCycleStatus,
  CROP_CYCLE_STATUS_KEY,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function RecentReadings() {
  const { data, isLoading } = useListReadings(
    { limit: 6 },
    { query: { queryKey: ["recent-readings"], refetchInterval: 15_000 } },
  );

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <Activity className="h-4 w-4 text-primary" />
          Recent Readings
        </CardTitle>
        <Link href="/analytics" className="ml-auto">
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary">
            Trends <ArrowRight className="h-3 w-3" />
          </span>
        </Link>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
        ) : (
          (data ?? []).map((r) => (
            <div
              key={r.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
            >
              <span className="w-14 shrink-0 font-mono text-[10px] text-muted-foreground">
                {formatTime(r.timestamp)}
              </span>
              <span className="w-20 shrink-0 truncate font-mono text-[10px] text-muted-foreground/70">
                {r.sensorId === 0 ? "main" : `s${r.sensorId}`}
              </span>
              <span className="ml-auto flex items-center gap-3 font-mono text-[11px] tabular-nums">
                <span title="Temperature">{r.temp != null ? `${r.temp.toFixed(1)}°C` : "—"}</span>
                <span className="text-muted-foreground" title="Humidity">
                  {r.hum != null ? `${r.hum.toFixed(0)}%` : "—"}
                </span>
                <span className="text-muted-foreground" title="CO₂">
                  {r.co2 != null ? `${Math.round(r.co2)}ppm` : "—"}
                </span>
              </span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function RecentRules() {
  const { data, isLoading } = useQuery({
    queryKey: ["rules"],
    queryFn: getRuleList,
    refetchInterval: 30_000,
  });
  const rules = (data ?? []).slice(0, 4);

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="flex flex-row items-center pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <Sparkles className="h-4 w-4 text-primary" />
          Automation Rules
        </CardTitle>
        <Link href="/controllers" className="ml-auto">
          <span className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-muted-foreground transition-colors hover:text-primary">
            Manage <ArrowRight className="h-3 w-3" />
          </span>
        </Link>
      </CardHeader>
      <CardContent className="space-y-1">
        {isLoading ? (
          <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
        ) : rules.length === 0 ? (
          <p className="py-4 text-center font-mono text-[11px] text-muted-foreground">
            No rules yet — create one in My Controllers
          </p>
        ) : (
          rules.map((rule) => (
            <div
              key={rule.id}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 transition-colors hover:bg-muted/50"
            >
              <span className="min-w-0 flex-1 truncate text-xs font-medium">{rule.name}</span>
              <span
                className={cn(
                  "h-1.5 w-1.5 shrink-0 rounded-full",
                  rule.enabled ? "dot-success" : "bg-muted-foreground/50",
                )}
              />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}

function QuickActions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const reboot = useMutation({
    mutationFn: () => sendDeviceCommand("REBOOT"),
    onSuccess: () =>
      toast({ title: "Reboot sent", description: "ESP32 will restart in a moment." }),
    onError: (err) =>
      toast({
        title: "Reboot failed",
        description: err instanceof Error ? err.message : "MQTT unavailable?",
        variant: "destructive",
      }),
  });

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <ShieldAlert className="h-4 w-4 text-primary" />
          Global Actions
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <Button
          variant="outline"
          className="h-9 w-full font-mono text-[11px] uppercase tracking-wider"
          disabled={reboot.isPending}
          onClick={() => reboot.mutate()}
        >
          <Power className="mr-2 h-3.5 w-3.5" />
          {reboot.isPending ? "Sending…" : "Reboot ESP32"}
        </Button>
        <Button asChild variant="outline" className="h-9 w-full font-mono text-[11px] uppercase tracking-wider">
          <Link href="/controllers">
            <Sparkles className="mr-2 h-3.5 w-3.5" />
            Manage automation
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export default function OverviewPage() {
  const emergency = useEmergency();

  // The schedule rides along on the status call the crop cycle card already
  // makes, so showing it costs no extra request.
  const { data: cropStatus } = useQuery({
    queryKey: CROP_CYCLE_STATUS_KEY,
    queryFn: getCropCycleStatus,
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-6">
      {/* KPI cards */}
      <LiveStats alertIds={emergency.alerts.map((a) => a.id)} />

      {/* Status + recent activity on the left, action rail on the right.
          `lg:items-start` keeps each column at its natural height. Without it
          the rail is stretched to the row height, and any `h-full` card inside
          it would claim that whole height — so the stack overflows and the next
          section paints on top of the emergency stop button. */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="min-w-0 space-y-6 lg:col-span-2">
          {/* Read-only here — editing lives on the crop cycle page, where there
              is room for it. */}
          <CropSchedule
            schedule={cropStatus?.schedule ?? []}
            batchName={cropStatus?.batch?.name}
          />
          <DeviceStatusList />
          <div className="@container">
            <div className="grid grid-cols-1 gap-6 @2xl:grid-cols-2">
              <RecentReadings />
              <RecentRules />
            </div>
          </div>
        </div>

        <div className="min-w-0 space-y-6">
          <CropCycleCard />
          <EmergencyStopPanel />
          <QuickActions />
        </div>
      </div>
    </div>
  );
}