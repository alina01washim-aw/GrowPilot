import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Zap, Hand, Lock, Cpu, Loader2, Pencil } from "lucide-react";
import {
  getDeviceControls,
  setDeviceMode,
  setDeviceState,
  renameDevice,
  ApiError,
  type DeviceControlView,
  type DeviceMode,
  type DeviceIconId,
} from "@/lib/api";
import { DeviceIcon, ICON_CHOICES } from "@/lib/device-registry";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { useCountdown } from "@/hooks/use-countdown";
import { cn } from "@/lib/utils";

function formatCountdown(seconds: number) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof ApiError &&
    err.data &&
    typeof err.data === "object" &&
    "error" in err.data
    ? String((err.data as { error: string }).error)
    : fallback;
}

/**
 * Renames a device and picks its icon.
 *
 * Only presentation changes here. The device `key` stays fixed, because every
 * automation rule, crop stage plan and runtime history record points at it —
 * renaming must never unwire an existing rule.
 */
function RenameDeviceDialog({ device }: { device: DeviceControlView }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [label, setLabel] = useState(device.label);
  const [icon, setIcon] = useState<DeviceIconId>(device.icon as DeviceIconId);

  // Reset to the server's values each time it opens, so a cancelled edit or a
  // rename made elsewhere does not leave stale text in the field.
  const onOpenChange = (next: boolean) => {
    if (next) {
      setLabel(device.label);
      setIcon(device.icon as DeviceIconId);
    }
    setOpen(next);
  };

  const save = useMutation({
    mutationFn: () => renameDevice(device.key, { label, icon }),
    onSuccess: (updated) => {
      // Every surface that names a device reads the registry, which
      // getDeviceControls refreshes — so refetch broadly rather than patching.
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      queryClient.invalidateQueries({ queryKey: ["crop-cycle", "status"] });
      queryClient.invalidateQueries({ queryKey: ["device-history"] });
      queryClient.invalidateQueries({ queryKey: ["rules"] });
      setOpen(false);
      toast({ title: `Renamed to ${updated.label}` });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not rename",
        description: errorText(err, "The name could not be saved."),
      }),
  });

  const trimmed = label.trim();
  const unchanged = trimmed === device.label && icon === device.icon;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 shrink-0 text-muted-foreground hover:text-foreground"
          aria-label={`Rename ${device.label}`}
        >
          <Pencil className="h-3.5 w-3.5" />
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="font-mono">Rename device</DialogTitle>
          <DialogDescription>
            Call this channel whatever it actually is. Existing rules, crop
            stages and runtime history keep working — only the display name and
            icon change.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Name</Label>
            <Input
              value={label}
              maxLength={40}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="Compost Maker"
              className="h-9"
              onKeyDown={(e) => {
                if (e.key === "Enter" && trimmed && !unchanged) save.mutate();
              }}
            />
            <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              Channel {device.index} · internal id {device.key}
            </p>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Icon</Label>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {ICON_CHOICES.map((choice) => (
                <button
                  key={choice.id}
                  type="button"
                  onClick={() => setIcon(choice.id)}
                  title={choice.label}
                  aria-label={choice.label}
                  aria-pressed={icon === choice.id}
                  className={cn(
                    "grid h-9 w-9 place-items-center rounded-lg border transition-colors",
                    icon === choice.id
                      ? "border-primary/50 bg-primary/10 text-primary"
                      : "border-border/60 text-muted-foreground hover:border-primary/40 hover:text-foreground",
                  )}
                >
                  <DeviceIcon icon={choice.id} className="h-4 w-4" />
                </button>
              ))}
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={!trimmed || unchanged || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeviceControlRow({ device }: { device: DeviceControlView }) {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const isAuto = device.mode === "auto";
  const timeLeft = useCountdown(device.guardedUntil);
  const isGuarded = timeLeft > 0;

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["device-controls"] });
  };

  const modeMutation = useMutation({
    mutationFn: (mode: DeviceMode) => setDeviceMode(device.key, mode),
    onSuccess: invalidate,
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Mode switch failed",
        description: errorText(err, "Could not change control mode."),
      });
    },
  });

  const stateMutation = useMutation({
    mutationFn: (on: boolean) => setDeviceState(device.key, on),
    onSuccess: invalidate,
    onError: (err: unknown) => {
      toast({
        variant: "destructive",
        title: "Control error",
        description: errorText(err, "Could not switch device."),
      });
    },
  });

  const busy = modeMutation.isPending || stateMutation.isPending;

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card/50 p-3 transition-colors hover:border-card-border sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <div className="grid shrink-0 place-items-center rounded-lg border border-border/50 bg-secondary/50 p-2">
          <DeviceIcon
            icon={device.icon}
            className={
              device.state ? "text-[hsl(var(--success))]" : "text-muted-foreground"
            }
          />
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <p className="truncate text-sm font-semibold">{device.label}</p>
            <RenameDeviceDialog device={device} />
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge
              variant="outline"
              className={cn(
                "rounded-md font-mono text-[9px]",
                device.state
                  ? "border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]"
                  : "text-muted-foreground",
              )}
            >
              {device.state ? "ON" : "OFF"}
            </Badge>
            <Badge
              variant="outline"
              className={cn(
                "rounded-md font-mono text-[9px] gap-1",
                isAuto
                  ? "border-[hsl(var(--info)/0.4)] bg-[hsl(var(--info)/0.08)] text-[hsl(var(--info))]"
                  : "border-[hsl(var(--warning)/0.4)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]",
              )}
            >
              {isAuto ? (
                <>
                  <Zap className="h-2.5 w-2.5" /> AUTO
                </>
              ) : (
                <>
                  <Hand className="h-2.5 w-2.5" /> MANUAL
                </>
              )}
            </Badge>
            {isGuarded && (
              <Badge
                variant="outline"
                className="gap-1 rounded-md border-destructive/50 bg-destructive/10 font-mono text-[9px] text-destructive"
              >
                <Lock className="h-2.5 w-2.5" /> {formatCountdown(timeLeft)}
              </Badge>
            )}
          </div>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 sm:justify-end">
        {/* On/off — only usable in manual mode */}
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "font-mono text-[10px] uppercase tracking-wider",
              !isAuto && !isGuarded ? "text-foreground" : "text-muted-foreground",
            )}
          >
            On
          </span>
          <Switch
            checked={device.state}
            onCheckedChange={(v) => stateMutation.mutate(v)}
            disabled={isAuto || isGuarded || busy}
            className="data-[state=checked]:bg-[hsl(var(--success))]"
          />
        </div>

        {/* Manual / Auto segmented control */}
        <div className="flex items-center gap-1 rounded-lg border border-border/70 bg-card/60 p-0.5">
          <button
            type="button"
            disabled={busy}
            onClick={() => modeMutation.mutate("manual")}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              !isAuto
                ? "bg-[hsl(var(--warning)/0.15)] font-semibold text-[hsl(var(--warning))]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Manual
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => modeMutation.mutate("auto")}
            className={cn(
              "rounded-md px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider transition-colors",
              isAuto
                ? "bg-[hsl(var(--info)/0.15)] font-semibold text-[hsl(var(--info))]"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            Auto
          </button>
        </div>

        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>
    </div>
  );
}

export function DeviceControls() {
  const { data: devices, isLoading, isError } = useQuery({
    queryKey: ["device-controls"],
    queryFn: getDeviceControls,
    refetchInterval: 5_000,
  });

  return (
    <Card className="card-lift flex h-full flex-col overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <Cpu className="h-4 w-4 text-primary" />
          Relay Controls
          <span className="ml-auto font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {devices?.length ?? 0} devices
          </span>
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          Auto = rules control it · Manual = you control it, rules skip it
        </p>
      </CardHeader>
      <CardContent className="flex-1">
        {isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-[64px] w-full" />
            <Skeleton className="h-[64px] w-full" />
            <Skeleton className="h-[64px] w-full" />
            <Skeleton className="h-[64px] w-full" />
          </div>
        ) : isError ? (
          <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-4 text-sm text-destructive">
            Failed to load devices. Check server connection.
          </div>
        ) : (
          <div className="space-y-2">
            {devices?.map((device) => (
              <DeviceControlRow key={device.key} device={device} />
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}