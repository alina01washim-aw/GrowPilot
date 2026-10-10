import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Sprout,
  Play,
  Plus,
  Trash2,
  Pencil,
  ArrowRight,
  RefreshCw,
  Square,
  Thermometer,
  Wind,
  Droplets,
  Clock,
} from "lucide-react";
import {
  listCropBatches,
  getCropCycleStatus,
  getDefaultStagePlan,
  createCropBatch,
  updateCropBatch,
  deleteCropBatch,
  startCropBatch,
  advanceCropStage,
  abortCropBatch,
  reapplyCropStage,
  describeStageApplication,
  stageColor,
  CROP_CYCLE_STATUS_KEY,
  CROP_BATCHES_KEY,
  getGetLatestReadingQueryKey,
  type CropBatch,
  type CropStage,
} from "@/lib/api";
import { CropSchedule } from "@/components/crop-schedule";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { SectionHeading } from "@/components/layout/section-heading";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { deviceLabel } from "@/lib/device-registry";

// Keys only, in display order — names come from the device registry so a renamed
// device reads correctly in the stage plan editor.
const DEVICE_OPTION_KEYS = ["fan", "ac", "mist_maker", "uv"] as const;

type DraftStage = Omit<CropStage, "index">;

const STATUS_STYLES: Record<string, string> = {
  active: "bg-[hsl(var(--success)/0.12)] text-[hsl(var(--success))]",
  planned: "bg-primary/10 text-primary",
  completed: "bg-muted text-muted-foreground",
  aborted: "bg-destructive/10 text-destructive",
};

function numberField(value: number, onChange: (n: number) => void, step = 1) {
  return (
    <Input
      type="number"
      step={step}
      value={Number.isFinite(value) ? value : ""}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-8 font-mono text-xs"
    />
  );
}

/** Editable stage plan — the heart of the batch form. */
function StagePlanEditor({
  stages,
  onChange,
}: {
  stages: DraftStage[];
  onChange: (next: DraftStage[]) => void;
}) {
  const patch = (index: number, updates: Partial<DraftStage>) => {
    onChange(stages.map((s, i) => (i === index ? { ...s, ...updates } : s)));
  };

  const patchTargets = (index: number, updates: Partial<DraftStage["targets"]>) => {
    onChange(
      stages.map((s, i) => (i === index ? { ...s, targets: { ...s.targets, ...updates } } : s)),
    );
  };

  const totalDays = stages.reduce((sum, s) => sum + (s.days || 0), 0);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
          {stages.length} stages · {totalDays} days planned
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 font-mono text-[10px] uppercase"
          onClick={() =>
            onChange([
              ...stages,
              {
                key: "custom",
                label: `Stage ${stages.length + 1}`,
                days: 7,
                targets: {
                  tempMin: 16,
                  tempMax: 18,
                  co2Min: 600,
                  co2Max: 1000,
                  humidityMin: 85,
                  humidityMax: 90,
                },
                devicesAuto: ["fan", "ac", "mist_maker"],
                notes: "",
              },
            ])
          }
        >
          <Plus className="mr-1 h-3 w-3" />
          Add stage
        </Button>
      </div>

      <div className="space-y-3">
        {stages.map((stage, index) => (
          <div
            key={index}
            className="space-y-2 rounded-lg border border-border/60 bg-secondary/10 p-3"
            style={{ borderLeftWidth: 3, borderLeftColor: stageColor(stage.key) }}
          >
            <div className="grid gap-2 sm:grid-cols-[1fr_1fr_80px_auto]">
              <div>
                <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Label
                </Label>
                <Input
                  value={stage.label}
                  onChange={(e) => patch(index, { label: e.target.value })}
                  className="h-8 text-xs"
                />
              </div>
              <div>
                <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Stage key (rules match on this)
                </Label>
                <Input
                  value={stage.key}
                  onChange={(e) => patch(index, { key: e.target.value.trim() })}
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div>
                <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  Days
                </Label>
                {numberField(stage.days, (days) => patch(index, { days }))}
              </div>
              <div className="flex items-end">
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8 text-muted-foreground hover:text-destructive"
                  disabled={stages.length <= 1}
                  onClick={() => onChange(stages.filter((_, i) => i !== index))}
                  aria-label="Remove stage"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid gap-2 sm:grid-cols-3">
              <div>
                <Label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  <Thermometer className="h-3 w-3" /> Temp °C
                </Label>
                <div className="flex items-center gap-1">
                  {numberField(stage.targets.tempMin, (tempMin) => patchTargets(index, { tempMin }), 0.5)}
                  <span className="text-muted-foreground">–</span>
                  {numberField(stage.targets.tempMax, (tempMax) => patchTargets(index, { tempMax }), 0.5)}
                </div>
              </div>
              <div>
                <Label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  <Wind className="h-3 w-3" /> CO2 ppm
                </Label>
                <div className="flex items-center gap-1">
                  {numberField(stage.targets.co2Min, (co2Min) => patchTargets(index, { co2Min }), 50)}
                  <span className="text-muted-foreground">–</span>
                  {numberField(stage.targets.co2Max, (co2Max) => patchTargets(index, { co2Max }), 50)}
                </div>
              </div>
              <div>
                <Label className="flex items-center gap-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                  <Droplets className="h-3 w-3" /> Humidity %
                </Label>
                <div className="flex items-center gap-1">
                  {numberField(stage.targets.humidityMin, (humidityMin) => patchTargets(index, { humidityMin }))}
                  <span className="text-muted-foreground">–</span>
                  {numberField(stage.targets.humidityMax, (humidityMax) => patchTargets(index, { humidityMax }))}
                </div>
              </div>
            </div>

            <div>
              <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                Devices under automation this stage
              </Label>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {DEVICE_OPTION_KEYS.map((deviceKey) => {
                  const on = stage.devicesAuto.includes(deviceKey);
                  return (
                    <button
                      key={deviceKey}
                      type="button"
                      onClick={() =>
                        patch(index, {
                          devicesAuto: on
                            ? stage.devicesAuto.filter((d) => d !== deviceKey)
                            : [...stage.devicesAuto, deviceKey],
                        })
                      }
                      className={cn(
                        "rounded-md border px-2 py-1 font-mono text-[10px] transition-colors",
                        on
                          ? "border-primary/40 bg-primary/10 text-primary"
                          : "border-border/60 text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {on ? "● " : "○ "}
                      {deviceLabel(deviceKey)}
                    </button>
                  );
                })}
              </div>
              <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                Anything left off is parked in manual and switched off when this
                stage begins.
              </p>
            </div>

            <Textarea
              value={stage.notes}
              onChange={(e) => patch(index, { notes: e.target.value })}
              placeholder="What this stage is for…"
              className="min-h-[48px] text-xs"
            />
          </div>
        ))}
      </div>
    </div>
  );
}

function NewBatchDialog() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [species, setSpecies] = useState("Agaricus bisporus");
  const [autoAdvance, setAutoAdvance] = useState(true);
  const [stages, setStages] = useState<DraftStage[] | null>(null);

  const { data: plan } = useQuery({
    queryKey: ["crop-cycle", "default-plan"],
    queryFn: getDefaultStagePlan,
    enabled: open,
  });

  const draftStages = useMemo<DraftStage[]>(() => {
    if (stages) return stages;
    return (plan?.stages ?? []).map(({ index: _index, ...rest }) => rest);
  }, [stages, plan]);

  const create = useMutation({
    mutationFn: () =>
      createCropBatch({ name, species, autoAdvance, stages: draftStages }),
    onSuccess: (batch) => {
      queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
      setOpen(false);
      setName("");
      setStages(null);
      toast({
        title: `${batch.name} planned`,
        description: `${batch.stages.length} stages · ${batch.totalDaysPlanned} days. Start it when the room is filled.`,
      });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not create batch",
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="h-9 font-mono text-[11px] uppercase tracking-wider">
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          New batch
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">Plan a crop batch</DialogTitle>
          <DialogDescription>
            The plan below is standard practice for button mushroom. Tune it to
            your strain and room — each stage's targets become the live
            thresholds the moment that stage begins.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label className="font-mono text-[10px] uppercase tracking-wider">Batch name</Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Room 1 — July fill"
                className="h-9"
              />
            </div>
            <div>
              <Label className="font-mono text-[10px] uppercase tracking-wider">Species</Label>
              <Input
                value={species}
                onChange={(e) => setSpecies(e.target.value)}
                className="h-9"
              />
            </div>
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 bg-secondary/10 p-3">
            <div>
              <p className="text-sm font-medium">Advance stages automatically</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                Off means you advance by eye — how most growers run pinning.
              </p>
            </div>
            <Switch checked={autoAdvance} onCheckedChange={setAutoAdvance} />
          </div>

          <StagePlanEditor stages={draftStages} onChange={setStages} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button
            disabled={!name.trim() || draftStages.length === 0 || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Creating…" : "Create batch"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Edits the stage plan of a batch that already exists — including the running
 * one, where saving re-applies the current stage so a corrected target takes
 * effect immediately instead of at the next transition.
 */
function EditPlanDialog({ batch }: { batch: CropBatch }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [stages, setStages] = useState<DraftStage[] | null>(null);
  const [plannedStartAt, setPlannedStartAt] = useState<string>(
    batch.plannedStartAt ? batch.plannedStartAt.slice(0, 10) : "",
  );

  const draftStages = useMemo<DraftStage[]>(
    () => stages ?? batch.stages.map(({ index: _index, ...rest }) => rest),
    [stages, batch.stages],
  );

  const save = useMutation({
    mutationFn: () =>
      updateCropBatch(batch.batchId, {
        stages: draftStages,
        // Only a not-yet-started batch has a planned start date; the server
        // rejects it for a running batch, whose calendar is anchored on facts.
        ...(batch.status === "planned"
          ? { plannedStartAt: plannedStartAt ? new Date(plannedStartAt).toISOString() : null }
          : {}),
      }),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: CROP_CYCLE_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
      setOpen(false);
      setStages(null);
      toast({
        title: `${batch.name} plan updated`,
        description:
          describeStageApplication(result.applied) ||
          (batch.status === "active"
            ? "The running stage was re-applied."
            : `${draftStages.length} stages saved.`),
      });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not save the plan",
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        // Drop the draft on close so reopening shows what is actually stored.
        if (!next) setStages(null);
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="h-8 font-mono text-[10px] uppercase">
          <Pencil className="mr-1.5 h-3 w-3" />
          Edit plan
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] max-w-3xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">Edit {batch.name}</DialogTitle>
          <DialogDescription>
            {batch.status === "active"
              ? "This batch is running. Saving re-applies the current stage straight away — new targets are pushed to the device and the relays move to match."
              : "Change stage lengths, targets and which devices each stage automates. Nothing is applied until the batch starts."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {batch.status === "planned" && (
            <div className="max-w-xs">
              <Label className="font-mono text-[10px] uppercase tracking-wider">
                Planned start date
              </Label>
              <Input
                type="date"
                value={plannedStartAt}
                onChange={(e) => setPlannedStartAt(e.target.value)}
                className="h-9"
              />
              <p className="mt-1 font-mono text-[9px] text-muted-foreground">
                Dates the calendar the schedule shows before the batch starts.
              </p>
            </div>
          )}

          <StagePlanEditor stages={draftStages} onChange={setStages} />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button disabled={draftStages.length === 0 || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save plan"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BatchRow({ batch }: { batch: CropBatch }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: CROP_CYCLE_STATUS_KEY });
    queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
    queryClient.invalidateQueries({ queryKey: ["device-controls"] });
    queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
  };

  const onError = (err: unknown) =>
    toast({
      variant: "destructive",
      title: "Action failed",
      description: err instanceof Error ? err.message : "Unknown error",
    });

  const start = useMutation({
    mutationFn: () => startCropBatch(batch.batchId),
    onSuccess: (result) => {
      invalidate();
      toast({ title: result.message, description: describeStageApplication(result.applied) });
    },
    onError,
  });

  const stop = useMutation({
    mutationFn: () => abortCropBatch(batch.batchId, "Stopped from the crop cycle page"),
    onSuccess: (result) => {
      invalidate();
      toast({ title: result.message, description: "Devices were left exactly as they are." });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => deleteCropBatch(batch.batchId),
    onSuccess: () => {
      invalidate();
      toast({ title: "Batch deleted" });
    },
    onError,
  });

  const toggleAuto = useMutation({
    mutationFn: (autoAdvance: boolean) => updateCropBatch(batch.batchId, { autoAdvance }),
    onSuccess: () => invalidate(),
    onError,
  });

  return (
    <div className="space-y-2 rounded-lg border border-border/60 bg-secondary/10 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-md px-2 py-0.5 font-mono text-[9px] uppercase tracking-wider",
            STATUS_STYLES[batch.status] ?? "bg-muted text-muted-foreground",
          )}
        >
          {batch.status}
        </span>
        <p className="text-sm font-semibold">{batch.name}</p>
        <span className="font-mono text-[10px] text-muted-foreground">
          {batch.batchId} · {batch.species}
        </span>
        <span className="ml-auto font-mono text-[10px] text-muted-foreground">
          {batch.stages.length} stages · {batch.totalDaysPlanned}d
        </span>
      </div>

      {batch.status === "active" && (
        <div className="flex items-center justify-between rounded-md border border-border/50 px-2 py-1.5">
          <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Clock className="h-3 w-3" />
            Auto-advance
          </span>
          <Switch
            checked={batch.autoAdvance}
            disabled={toggleAuto.isPending}
            onCheckedChange={(v) => toggleAuto.mutate(v)}
          />
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {batch.status !== "completed" && batch.status !== "aborted" && (
          <EditPlanDialog batch={batch} />
        )}

        {batch.status === "planned" && (
          <>
            <Button
              size="sm"
              className="h-8 font-mono text-[10px] uppercase"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              <Play className="mr-1.5 h-3 w-3" />
              {start.isPending ? "Starting…" : "Start batch"}
            </Button>
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-8 font-mono text-[10px] uppercase text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="mr-1.5 h-3 w-3" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-mono">Delete {batch.name}?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The plan is removed permanently. This cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </>
        )}

        {batch.status === "active" && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className="h-8 font-mono text-[10px] uppercase text-destructive"
              >
                <Square className="mr-1.5 h-3 w-3" />
                Stop batch
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="font-mono">Stop {batch.name}?</AlertDialogTitle>
                <AlertDialogDescription>
                  The batch is marked as stopped and stage automation ends. The
                  relays and current thresholds are left exactly as they are —
                  this is not an emergency stop.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={() => stop.mutate()}>Stop batch</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>

      {/* Dated plan. Editable here (unlike the dashboard) — the row editor is
          where stage lengths, dates and stage jumps are driven from. */}
      {batch.status !== "completed" && batch.status !== "aborted" && (
        <CropSchedule
          schedule={batch.schedule}
          batchId={batch.batchId}
          editable
          running={batch.status === "active"}
          className="border-border/60 bg-transparent shadow-none backdrop-blur-none"
        />
      )}
    </div>
  );
}

export default function CropCyclePage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const statusQuery = useQuery({
    queryKey: CROP_CYCLE_STATUS_KEY,
    queryFn: getCropCycleStatus,
    refetchInterval: 30_000,
  });
  const batchesQuery = useQuery({
    queryKey: CROP_BATCHES_KEY,
    queryFn: listCropBatches,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: CROP_CYCLE_STATUS_KEY });
    queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
    queryClient.invalidateQueries({ queryKey: ["device-controls"] });
  };

  const advance = useMutation({
    mutationFn: (batchId: string) => advanceCropStage(batchId),
    onSuccess: (result) => {
      invalidate();
      toast({ title: result.message, description: describeStageApplication(result.applied) });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not advance",
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });

  const reapply = useMutation({
    mutationFn: reapplyCropStage,
    onSuccess: (applied) => {
      invalidate();
      toast({
        title: `${applied.stage.label} re-applied`,
        description: describeStageApplication(applied) || "Configuration pushed to the device.",
      });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not re-apply stage",
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });

  const status = statusQuery.data;
  const active = status?.batch;
  const stage = status?.stage;

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={<Sprout className="h-4 w-4" />}
        title="Crop Cycle"
        description="Growth stages drive the room — targets, devices and rules change with the crop"
        right={
          <div className="flex flex-wrap items-center gap-2">
            {active && (
              <Button
                variant="outline"
                className="h-9 font-mono text-[11px] uppercase tracking-wider"
                disabled={reapply.isPending}
                onClick={() => reapply.mutate()}
              >
                <RefreshCw className={cn("mr-1.5 h-3.5 w-3.5", reapply.isPending && "animate-spin")} />
                Re-apply stage
              </Button>
            )}
            <NewBatchDialog />
          </div>
        }
      />

      {statusQuery.isLoading ? (
        <Skeleton className="h-[200px] w-full rounded-xl" />
      ) : active && stage ? (
        <Card className="card-lift border-card-border bg-card/70 backdrop-blur-sm">
          <CardHeader className="pb-2">
            <CardTitle className="flex flex-wrap items-center gap-2 font-mono text-sm uppercase tracking-widest">
              <Sprout className="h-4 w-4" style={{ color: stageColor(stage.key) }} />
              {active.name}
              <Badge
                variant="outline"
                className="rounded-md border-transparent font-mono text-[10px]"
                style={{
                  backgroundColor: `${stageColor(stage.key)}1a`,
                  color: stageColor(stage.key),
                }}
              >
                {stage.label}
              </Badge>
              {status.progress && (
                <span className="font-mono text-[10px] normal-case tracking-normal text-muted-foreground">
                  day {status.progress.dayOfBatch} of {status.progress.totalDaysPlanned}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {stage.notes && (
              <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
                {stage.notes}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-3">
              {status.readout.map((r) => (
                <div
                  key={r.key}
                  className="rounded-lg border border-border/60 bg-secondary/20 p-3"
                >
                  <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                    {r.label}
                  </p>
                  <p className="mt-0.5 font-mono text-lg font-bold">
                    {r.actual == null ? "—" : r.actual.toFixed(r.key === "co2" ? 0 : 1)}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">{r.unit}</span>
                  </p>
                  <p className="font-mono text-[10px] text-muted-foreground">
                    target {r.min}–{r.max}
                  </p>
                  <p
                    className={cn(
                      "mt-1 font-mono text-[9px] uppercase tracking-wider",
                      r.status === "ok"
                        ? "text-[hsl(var(--success))]"
                        : r.status === "unknown"
                          ? "text-muted-foreground"
                          : "text-[hsl(var(--warning))]",
                    )}
                  >
                    {r.status === "ok"
                      ? "in band"
                      : r.status === "unknown"
                        ? "no reading"
                        : r.status === "low"
                          ? "below target"
                          : "above target"}
                  </p>
                </div>
              ))}
            </div>

            {status.ventBeforeEntry && (
              <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-3">
                <Wind className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--warning))]" />
                <p className="font-mono text-[11px] leading-relaxed text-[hsl(var(--warning))]">
                  This stage deliberately holds CO2 up to {stage.targets.co2Max} ppm —
                  the mycelium wants it, people do not. Vent the room before
                  anyone goes in.
                </p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                className="h-9 font-mono text-[11px] uppercase tracking-wider"
                disabled={advance.isPending}
                onClick={() => advance.mutate(active.batchId)}
              >
                <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                {status.nextStage ? `Advance to ${status.nextStage.label}` : "Complete batch"}
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card className="border-card-border bg-card/70 backdrop-blur-sm">
          <CardContent className="p-6 text-center">
            <Sprout className="mx-auto h-8 w-8 text-muted-foreground/40" />
            <p className="mt-2 text-sm font-semibold">No batch running</p>
            <p className="mx-auto mt-1 max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">
              The room is holding whatever static thresholds were last saved.
              Plan a batch to have the controller re-target itself through spawn
              run, pinning, and each flush on its own.
            </p>
          </CardContent>
        </Card>
      )}

      <Card className="card-lift border-card-border bg-card/70 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="font-mono text-sm uppercase tracking-widest">Batches</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {batchesQuery.isLoading ? (
            <Skeleton className="h-24 w-full" />
          ) : (batchesQuery.data ?? []).length === 0 ? (
            <p className="py-4 text-center font-mono text-xs text-muted-foreground">
              No batches yet.
            </p>
          ) : (
            (batchesQuery.data ?? []).map((batch) => (
              <BatchRow key={batch.batchId} batch={batch} />
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
