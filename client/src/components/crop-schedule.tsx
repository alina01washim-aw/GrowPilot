import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CalendarDays, Check, Pencil, Sprout } from "lucide-react";
import {
  patchCropStage,
  setCropStage,
  describeStageChanges,
  formatScheduleDate,
  daysFromEndDate,
  deviceLabelFor,
  stageColor,
  describeStageApplication,
  CROP_CYCLE_STATUS_KEY,
  CROP_BATCHES_KEY,
  getGetLatestReadingQueryKey,
  type ScheduledStage,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useToast } from "@/hooks/use-toast";
import { useTick } from "@/hooks/use-tick";
import { cn } from "@/lib/utils";

/**
 * The crop calendar: which stage runs on which dates, and — the point of it —
 * what physically changes on the day each stage begins.
 *
 * Dates come from the server already resolved (`ScheduledStage.startsAt`), which
 * keeps one rule about where a date comes from: recorded history for stages that
 * have run, projection from `days` for the rest. `actual` says which.
 *
 * Editing writes back a stage's `days`, never a date. Moving an end date is the
 * same edit expressed differently, so the calendar and the auto-advance
 * scheduler can never drift apart.
 */

/** ISO date (yyyy-mm-dd) in local time, for <input type="date">. */
function toDateInputValue(iso: string): string {
  const d = new Date(iso);
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${d.getFullYear()}-${month}-${day}`;
}

function StageEditor({
  stage,
  previous,
  batchId,
  canJump,
  onDone,
}: {
  stage: ScheduledStage;
  previous: ScheduledStage | null;
  batchId: string;
  canJump: boolean;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [days, setDays] = useState(stage.days);
  const [confirmJump, setConfirmJump] = useState(false);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: CROP_CYCLE_STATUS_KEY });
    queryClient.invalidateQueries({ queryKey: CROP_BATCHES_KEY });
    queryClient.invalidateQueries({ queryKey: ["device-controls"] });
    queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
  };

  const onError = (err: unknown) =>
    toast({
      variant: "destructive",
      title: "Could not change the plan",
      description: err instanceof Error ? err.message : "Unknown error",
    });

  const save = useMutation({
    mutationFn: () => patchCropStage(batchId, stage.index, { days }),
    onSuccess: (result) => {
      invalidate();
      onDone();
      toast({
        title: `${stage.label} is now ${days === 0 ? "open-ended" : `${days} days`}`,
        description:
          describeStageApplication(result.applied) ||
          "Later stages moved to match.",
      });
    },
    onError,
  });

  // Shifting this stage's start means changing how long the *previous* stage
  // runs — the start date is not stored, it is where the previous stage ends.
  const shift = useMutation({
    mutationFn: (delta: number) =>
      patchCropStage(batchId, previous!.index, {
        days: Math.max(0, previous!.days + delta),
      }),
    onSuccess: (result) => {
      invalidate();
      onDone();
      toast({
        title: `${stage.label} moved`,
        description:
          describeStageApplication(result.applied) ||
          `${previous!.label} is now ${result.batch.stages[previous!.index]?.days ?? "?"} days.`,
      });
    },
    onError,
  });

  // Jumping re-targets the whole room immediately, so it is confirmed in place
  // rather than firing on the first click.
  const jump = useMutation({
    mutationFn: () => setCropStage(batchId, stage.index),
    onSuccess: (result) => {
      invalidate();
      onDone();
      toast({
        title: result.message,
        description: describeStageApplication(result.applied),
      });
    },
    onError,
  });

  const pending = save.isPending || shift.isPending || jump.isPending;
  const projectedEnd = new Date(
    new Date(stage.startsAt).getTime() + days * 86_400_000,
  );

  return (
    <div className="w-72 space-y-3">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
          {stage.label}
        </p>
        <p className="font-mono text-[10px] text-muted-foreground">
          starts {formatScheduleDate(stage.startsAt)}
        </p>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Length (days)
          </Label>
          <Input
            type="number"
            min={0}
            value={days}
            onChange={(e) => setDays(Math.max(0, Number(e.target.value) || 0))}
            className="h-8 font-mono text-xs"
          />
        </div>
        <div>
          <Label className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Ends on
          </Label>
          <Input
            type="date"
            value={toDateInputValue(projectedEnd.toISOString())}
            onChange={(e) => {
              if (!e.target.value) return;
              setDays(daysFromEndDate(stage.startsAt, new Date(e.target.value)));
            }}
            className="h-8 font-mono text-xs"
          />
        </div>
      </div>

      <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
        {days === 0
          ? "Open-ended — only a manual advance ends this stage."
          : "Every later stage shifts to match."}
      </p>

      <Button
        size="sm"
        className="h-8 w-full font-mono text-[10px] uppercase tracking-wider"
        disabled={pending || days === stage.days}
        onClick={() => save.mutate()}
      >
        <Check className="mr-1.5 h-3 w-3" />
        {save.isPending ? "Saving…" : "Save length"}
      </Button>

      {previous && (
        <div className="space-y-1.5 border-t border-border/60 pt-2.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Move this start date
          </p>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 font-mono text-[10px]"
              disabled={pending || previous.days <= 0}
              onClick={() => shift.mutate(-1)}
            >
              −1 day
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="h-7 flex-1 font-mono text-[10px]"
              disabled={pending}
              onClick={() => shift.mutate(1)}
            >
              +1 day
            </Button>
          </div>
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
            Adjusts {previous.label}, which is what this date follows.
          </p>
        </div>
      )}

      {canJump && (
        <div className="space-y-1.5 border-t border-border/60 pt-2.5">
          <p className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
            Run this stage now
          </p>
          <Button
            variant={confirmJump ? "destructive" : "outline"}
            size="sm"
            className="h-7 w-full font-mono text-[10px] uppercase tracking-wider"
            disabled={pending}
            onClick={() => (confirmJump ? jump.mutate() : setConfirmJump(true))}
          >
            {jump.isPending
              ? "Applying…"
              : confirmJump
                ? "Confirm — re-target the room"
                : "Jump to this stage"}
          </Button>
          <p className="font-mono text-[9px] leading-relaxed text-muted-foreground">
            {confirmJump
              ? `Targets go to ${stage.targets.tempMin}–${stage.targets.tempMax}°C, CO2 ${stage.targets.co2Min}–${stage.targets.co2Max}, RH ${stage.targets.humidityMin}–${stage.targets.humidityMax}% and the relays move at once.`
              : stage.state === "done"
                ? "Re-runs a stage this batch has already passed."
                : "Skips the stages in between, leaving them unrun."}
          </p>
        </div>
      )}
    </div>
  );
}

function ScheduleRow({
  stage,
  previous,
  batchId,
  editable,
  running,
  isLast,
}: {
  stage: ScheduledStage;
  previous: ScheduledStage | null;
  batchId?: string;
  editable: boolean;
  running: boolean;
  isLast: boolean;
}) {
  const [open, setOpen] = useState(false);
  const tone = stageColor(stage.key);
  const summary = describeStageChanges(stage.changes);
  const done = stage.state === "done";
  const current = stage.state === "current";

  return (
    <div className="flex gap-3">
      {/* Rail: a dot per stage, joined into a continuous timeline. */}
      <div className="flex w-4 shrink-0 flex-col items-center pt-2.5">
        <span
          className={cn("h-2.5 w-2.5 shrink-0 rounded-full ring-2 ring-background")}
          style={{
            backgroundColor: done || current ? tone : "hsl(var(--border))",
            boxShadow: current ? `0 0 0 4px ${tone}33` : undefined,
          }}
        />
        {!isLast && (
          <span
            aria-hidden
            className="mt-1 w-px flex-1"
            style={{
              background: done
                ? tone
                : "linear-gradient(hsl(var(--border)), hsl(var(--border)))",
              opacity: done ? 0.5 : 1,
            }}
          />
        )}
      </div>

      <div
        className={cn(
          "min-w-0 flex-1 rounded-lg border px-3 py-2 transition-colors",
          current
            ? "border-primary/40 bg-primary/5"
            : done
              ? "border-border/40 bg-secondary/5"
              : "border-border/50 bg-secondary/10",
          isLast ? "mb-0" : "mb-2",
        )}
      >
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <span
            className="font-mono text-[11px] font-semibold tabular-nums"
            style={{ color: done || current ? tone : undefined }}
          >
            {formatScheduleDate(stage.startsAt)}
            {stage.endsAt && (
              <>
                <span className="mx-1 text-muted-foreground/60">→</span>
                {formatScheduleDate(stage.endsAt)}
              </>
            )}
          </span>

          <span className="font-mono text-[10px] text-muted-foreground">
            {stage.days > 0 ? `${stage.days}d` : "open-ended"}
          </span>

          <span className={cn("min-w-0 truncate text-xs font-semibold", done && "text-muted-foreground")}>
            {stage.label}
          </span>

          {current && (
            <Badge className="rounded-md bg-primary/15 font-mono text-[9px] text-primary hover:bg-primary/15">
              NOW
            </Badge>
          )}
          {!stage.actual && !current && stage.state !== "upcoming" && (
            <span
              className="font-mono text-[9px] uppercase tracking-wider text-muted-foreground/70"
              title="No recorded entry for this stage — the date is worked back from the plan"
            >
              projected
            </span>
          )}

          {editable && batchId && (
            <Popover open={open} onOpenChange={setOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="ml-auto h-6 w-6 shrink-0 text-muted-foreground hover:text-foreground"
                  aria-label={`Edit ${stage.label} dates`}
                >
                  <Pencil className="h-3 w-3" />
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-auto p-3">
                <StageEditor
                  stage={stage}
                  previous={previous}
                  batchId={batchId}
                  canJump={running && !current}
                  onDone={() => setOpen(false)}
                />
              </PopoverContent>
            </Popover>
          )}
        </div>

        {summary && (
          <p className="mt-1 font-mono text-[10px] leading-relaxed text-foreground/80">
            {summary}
          </p>
        )}

        <p className="mt-0.5 font-mono text-[9px] leading-relaxed text-muted-foreground">
          <span className="text-muted-foreground/70">auto:</span>{" "}
          {stage.devicesAuto.length > 0
            ? stage.devicesAuto.map(deviceLabelFor).join(", ")
            : "nothing"}
          {stage.devicesParked.length > 0 && (
            <>
              {" · "}
              <span className="text-muted-foreground/70">off:</span>{" "}
              {stage.devicesParked.map(deviceLabelFor).join(", ")}
            </>
          )}
        </p>
      </div>
    </div>
  );
}

export function CropSchedule({
  schedule,
  batchId,
  batchName,
  editable = false,
  running = false,
  className,
}: {
  schedule: ScheduledStage[];
  batchId?: string;
  batchName?: string;
  editable?: boolean;
  /** Active batch — enables jumping to a stage from the row editor. */
  running?: boolean;
  className?: string;
}) {
  // Re-render on the minute so the NOW marker and the day counts stay honest
  // without the caller having to think about it.
  useTick(60_000);

  if (schedule.length === 0) return null;

  const first = schedule[0]!;
  const last = schedule[schedule.length - 1]!;
  const totalDays = schedule.reduce((sum, s) => sum + s.days, 0);

  return (
    <Card
      className={cn(
        "card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm",
        className,
      )}
    >
      <CardHeader className="flex flex-row flex-wrap items-center gap-2 pb-3">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <CalendarDays className="h-4 w-4 text-primary" />
          Crop Schedule
        </CardTitle>
        <span className="font-mono text-[10px] text-muted-foreground">
          {formatScheduleDate(first.startsAt)}
          {last.endsAt && ` → ${formatScheduleDate(last.endsAt)}`}
          {totalDays > 0 && ` · ${totalDays}d planned`}
        </span>
        {batchName && (
          <span className="ml-auto flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            <Sprout className="h-3 w-3" />
            {batchName}
          </span>
        )}
      </CardHeader>
      <CardContent className="pb-4">
        {schedule.map((stage, i) => (
          <ScheduleRow
            key={stage.index}
            stage={stage}
            previous={i > 0 ? schedule[i - 1]! : null}
            batchId={batchId}
            editable={editable}
            running={running}
            isLast={i === schedule.length - 1}
          />
        ))}
      </CardContent>
    </Card>
  );
}
