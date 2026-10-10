import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import {
  Sprout,
  ChevronRight,
  Wind,
  CalendarClock,
  CircleSlash,
  ArrowRight,
} from "lucide-react";
import {
  getCropCycleStatus,
  advanceCropStage,
  describeStageApplication,
  formatTargetBand,
  stageColor,
  statusTone,
  CROP_CYCLE_STATUS_KEY,
  CROP_BATCHES_KEY,
  getGetLatestReadingQueryKey,
  type TargetReadout,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
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
import { useToast } from "@/hooks/use-toast";

function ReadoutRow({ readout }: { readout: TargetReadout }) {
  const dot =
    readout.status === "ok"
      ? "dot-success"
      : readout.status === "unknown"
        ? "bg-muted-foreground/40"
        : "dot-warning";

  return (
    <div className="flex items-center justify-between gap-2 py-1">
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {readout.label}
      </span>
      <div className="flex items-center gap-2">
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatTargetBand(readout)}
        </span>
        <span className={`font-mono text-xs font-semibold ${statusTone(readout.status)}`}>
          {readout.actual == null ? "—" : readout.actual.toFixed(readout.key === "co2" ? 0 : 1)}
        </span>
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${dot}`} />
      </div>
    </div>
  );
}

/**
 * The crop cycle at a glance: which stage the batch is in, how far through it
 * is, whether the room is actually holding that stage's targets, and what
 * changes next.
 */
export function CropCycleCard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery({
    queryKey: CROP_CYCLE_STATUS_KEY,
    queryFn: getCropCycleStatus,
    refetchInterval: 30_000,
  });

  const advance = useMutation({
    mutationFn: (batchId: string) => advanceCropStage(batchId),
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: CROP_CYCLE_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
      toast({
        title: result.message,
        description: describeStageApplication(result.applied),
      });
    },
    onError: (err) =>
      toast({
        variant: "destructive",
        title: "Could not change stage",
        description: err instanceof Error ? err.message : "Unknown error",
      }),
  });

  if (isLoading) {
    return <Skeleton className="h-[320px] w-full rounded-xl" />;
  }

  const batch = data?.batch;
  const stage = data?.stage;
  const progress = data?.progress;

  // No batch running — invite the grower to plan one rather than showing an
  // empty shell.
  if (!batch || !stage) {
    return (
      <Card className="card-lift flex flex-col border-card-border bg-card/70 backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
            <Sprout className="h-4 w-4 text-primary" />
            Crop Cycle
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-1 flex-col gap-3">
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            No batch running. The room is on its static thresholds — every stage
            change has to be made by hand.
          </p>
          <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
            Start a batch and the controller re-targets itself as the crop moves
            from spawn run through to the last flush.
          </p>
          <Button asChild className="mt-auto h-9 w-full font-mono text-[11px] uppercase tracking-wider">
            <Link href="/crop-cycle">
              <Sprout className="mr-2 h-3.5 w-3.5" />
              Plan a batch
            </Link>
          </Button>
        </CardContent>
      </Card>
    );
  }

  const tone = stageColor(stage.key);
  const offTarget = (data?.readout ?? []).filter((r) => r.status === "low" || r.status === "high");

  return (
    <Card className="card-lift flex flex-col border-card-border bg-card/70 backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <Sprout className="h-4 w-4" style={{ color: tone }} />
          Crop Cycle
          <Badge
            variant="outline"
            className="ml-auto rounded-md border-transparent font-mono text-[10px]"
            style={{ backgroundColor: `${tone}1a`, color: tone }}
          >
            Stage {stage.index + 1}/{batch.stages.length}
          </Badge>
        </CardTitle>
      </CardHeader>

      <CardContent className="flex flex-1 flex-col gap-3">
        <div>
          <p className="truncate text-sm font-bold tracking-tight">{stage.label}</p>
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {batch.name}
            {progress
              ? ` · day ${progress.dayOfStage}${stage.days > 0 ? ` of ${stage.days}` : ""}`
              : ""}
          </p>
        </div>

        {/* Stage progress */}
        {progress && stage.days > 0 && (
          <div className="space-y-1">
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-secondary">
              <div
                className="h-full rounded-full transition-all"
                style={{ width: `${progress.stagePercent}%`, backgroundColor: tone }}
              />
            </div>
            <div className="flex items-center justify-between font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              <span>
                Day {progress.dayOfBatch} of {progress.totalDaysPlanned} in batch
              </span>
              <span>
                {progress.daysRemainingInStage === 0
                  ? "advancing"
                  : `${progress.daysRemainingInStage}d left`}
              </span>
            </div>
          </div>
        )}

        {/* Target vs actual */}
        <div className="rounded-lg border border-border/60 bg-secondary/20 px-3 py-1.5">
          {(data?.readout ?? []).map((readout) => (
            <ReadoutRow key={readout.key} readout={readout} />
          ))}
        </div>

        {data?.ventBeforeEntry && (
          <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] p-2">
            <Wind className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[hsl(var(--warning))]" />
            <p className="font-mono text-[10px] leading-relaxed text-[hsl(var(--warning))]">
              This stage holds CO2 up to {stage.targets.co2Max} ppm on purpose.
              Vent the room before going in.
            </p>
          </div>
        )}

        {data && data.devicesParked.length > 0 && (
          <p className="flex items-start gap-1.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
            <CircleSlash className="mt-0.5 h-3 w-3 shrink-0" />
            Off this stage: {data.devicesParked.map((d) => d.label).join(", ")}
          </p>
        )}

        {offTarget.length > 0 && (
          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            {offTarget
              .map((r) => `${r.label} ${r.status === "low" ? "below" : "above"} target`)
              .join(" · ")}
            {" — automation is correcting."}
          </p>
        )}

        {/* Next stage + advance */}
        <div className="mt-auto space-y-2 pt-1">
          {data?.nextStage ? (
            <div className="rounded-lg border border-border/60 bg-secondary/10 p-2">
              <p className="flex items-center gap-1.5 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
                <CalendarClock className="h-3 w-3" />
                Next
                {progress?.daysRemainingInStage != null && progress.daysRemainingInStage > 0
                  ? ` in ${progress.daysRemainingInStage}d`
                  : ""}
              </p>
              <p className="mt-0.5 flex items-center gap-1.5 font-mono text-[11px] font-semibold">
                {data.nextStage.label}
              </p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {data.nextStage.targets.tempMin}–{data.nextStage.targets.tempMax}°C · CO2{" "}
                {data.nextStage.targets.co2Min}–{data.nextStage.targets.co2Max} · RH{" "}
                {data.nextStage.targets.humidityMin}–{data.nextStage.targets.humidityMax}%
              </p>
            </div>
          ) : (
            <p className="font-mono text-[10px] text-muted-foreground">
              Final stage — advancing completes the batch.
            </p>
          )}

          <div className="flex gap-2">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  className="h-9 flex-1 font-mono text-[11px] uppercase tracking-wider"
                  disabled={advance.isPending}
                >
                  <ArrowRight className="mr-1.5 h-3.5 w-3.5" />
                  {advance.isPending ? "Applying…" : "Advance"}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-mono">
                    {data?.nextStage ? `Move to ${data.nextStage.label}?` : "Complete this batch?"}
                  </AlertDialogTitle>
                  <AlertDialogDescription asChild>
                    <div className="space-y-2">
                      {data?.nextStage ? (
                        <>
                          <p>
                            This re-targets the whole room straight away: new
                            temperature, CO2 and humidity bands are pushed to the
                            device, devices the stage does not use are switched
                            off, that stage's rules take over, and the relays move
                            to match.
                          </p>
                          <p className="font-mono text-xs">
                            {data.nextStage.targets.tempMin}–
                            {data.nextStage.targets.tempMax}°C · CO2{" "}
                            {data.nextStage.targets.co2Min}–
                            {data.nextStage.targets.co2Max} ppm · RH{" "}
                            {data.nextStage.targets.humidityMin}–
                            {data.nextStage.targets.humidityMax}%
                          </p>
                          {data.nextStage.notes && (
                            <p className="text-xs italic">{data.nextStage.notes}</p>
                          )}
                        </>
                      ) : (
                        <p>
                          The batch will be marked complete. The current
                          thresholds stay in force so the room is never left
                          uncontrolled.
                        </p>
                      )}
                    </div>
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => advance.mutate(batch.batchId)}>
                    {data?.nextStage ? "Advance stage" : "Complete batch"}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>

            <Button
              asChild
              variant="ghost"
              className="h-9 px-3 font-mono text-[11px] uppercase tracking-wider"
            >
              <Link href="/crop-cycle">
                Plan
                <ChevronRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {!batch.autoAdvance && (
            <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
              Auto-advance off — you drive the stages
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
