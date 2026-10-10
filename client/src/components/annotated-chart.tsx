import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ResponsiveContainer,
} from "recharts";
import { StickyNote, Plus, Info, TriangleAlert, OctagonAlert } from "lucide-react";
import {
  useListReadings,
  getListReadingsQueryKey,
  listBatchAnnotations,
  annotationsKey,
  CATEGORY_LABELS,
  type BatchAnnotation,
  type AnnotationSeverity,
  type CropBatch,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { AnnotationDialog } from "@/components/annotation-dialog";
import { useIsMobile } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

/**
 * The environment chart with the batch's notes pinned onto it.
 *
 * Deliberately built on the same Recharts vocabulary as `historical-graphs.tsx`
 * (identical gradients, dual axes and tooltip shape) so the two read as one
 * system rather than two charts that happen to share a page. The additions are
 * stage bands behind the curves, severity-coloured pins, and click-to-annotate.
 *
 * `ComposedChart` rather than `LineChart` because `ReferenceArea` needs to sit
 * underneath the series while `ReferenceLine` sits on top, and mixing areas and
 * lines in one cartesian space is what Composed is for.
 */

const SEVERITY_COLOR: Record<AnnotationSeverity, string> = {
  info: "hsl(var(--info))",
  warning: "hsl(var(--warning))",
  critical: "hsl(var(--destructive))",
};

const SEVERITY_ICON: Record<AnnotationSeverity, typeof Info> = {
  info: Info,
  warning: TriangleAlert,
  critical: OctagonAlert,
};

/** Alternating tints so consecutive stages are distinguishable without a legend. */
const STAGE_TINTS = [
  "hsl(var(--chart-1) / 0.05)",
  "hsl(var(--chart-3) / 0.05)",
  "hsl(var(--chart-6) / 0.05)",
  "hsl(var(--chart-2) / 0.05)",
];

interface Reading {
  timestamp: string;
  temp: number | null;
  hum: number | null;
  co2: number | null;
  compostTemp: number | null;
}

export function AnnotatedChart({ batch }: { batch: CropBatch }) {
  const isMobile = useIsMobile();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [pinAt, setPinAt] = useState<Date | null>(null);
  const [editing, setEditing] = useState<BatchAnnotation | null>(null);

  // The batch's own window, so the chart always frames the crop rather than an
  // arbitrary date range the grower has to line up by hand.
  const from = batch.startedAt ?? batch.plannedStartAt ?? null;
  const to = batch.completedAt ?? new Date().toISOString();

  const readingsParams = {
    from: from ?? undefined,
    to,
    limit: 5000,
  };
  const { data: readings, isLoading } = useListReadings(readingsParams, {
    query: { queryKey: getListReadingsQueryKey(readingsParams), enabled: !!from },
  });

  const { data: annotations } = useQuery({
    queryKey: annotationsKey(batch.batchId),
    queryFn: () => listBatchAnnotations(batch.batchId),
  });

  /**
   * Stage bands from the recorded history — what actually ran, not the plan. A
   * manual jump or an early advance makes the planned durations wrong, and a band
   * drawn from the plan would sit in the wrong place on the axis.
   */
  const stageBands = useMemo(() => {
    const history = batch.stageHistory ?? [];
    return history
      .map((entry, i) => {
        const stage = batch.stages[entry.index];
        if (!stage) return null;
        return {
          x1: entry.enteredAt,
          x2: entry.leftAt ?? to,
          label: stage.label,
          fill: STAGE_TINTS[i % STAGE_TINTS.length]!,
        };
      })
      .filter((b): b is NonNullable<typeof b> => b !== null);
  }, [batch.stageHistory, batch.stages, to]);

  /**
   * Snaps a clicked point to the nearest stored reading.
   *
   * Recharts reports the category value under the cursor, which for a sparse
   * series is already a real timestamp — but a click between points can land on
   * an interpolated position. Pinning to an actual sample keeps the note aligned
   * with data that exists, which is also what the server's snapshot lookup wants.
   */
  function handleChartClick(state: { activeLabel?: string | number } | null) {
    const label = state?.activeLabel;
    if (label === undefined) return;
    const clicked = new Date(label);
    if (Number.isNaN(clicked.getTime())) return;
    setEditing(null);
    setPinAt(clicked);
    setDialogOpen(true);
  }

  const CustomTooltip = ({
    active,
    payload,
    label,
  }: {
    active?: boolean;
    payload?: Array<{ name?: string; value?: unknown; color?: string }>;
    label?: string | number;
  }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="rounded-lg border border-card-border bg-popover p-3 font-mono text-sm shadow-xl shadow-black/10 backdrop-blur-md">
        <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
          {label ? new Date(label).toLocaleString() : ""}
        </p>
        <div className="space-y-1">
          {payload.map((entry, i) => (
            <div key={i} className="flex items-center justify-between gap-4">
              <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <span className="h-1 w-3 rounded-full" style={{ background: entry.color }} />
                {entry.name}
              </span>
              <span className="font-semibold" style={{ color: entry.color }}>
                {typeof entry.value === "number" ? entry.value.toFixed(1) : "n/a"}
              </span>
            </div>
          ))}
        </div>
        <p className="mt-2 border-t border-border/40 pt-1.5 text-[10px] text-muted-foreground/70">
          Click to add a note here
        </p>
      </div>
    );
  };

  if (!from) {
    return (
      <Card className="border-card-border bg-card/70 backdrop-blur-sm">
        <CardContent className="p-6 text-center">
          <StickyNote className="mx-auto h-8 w-8 text-muted-foreground/40" />
          <p className="mt-2 text-sm font-semibold">Nothing to chart yet</p>
          <p className="mx-auto mt-1 max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground">
            Start this batch, or set a planned start date, and its environment
            history will appear here ready to annotate.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="card-lift min-w-0 overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="flex flex-col gap-2 border-b border-border/50 px-4 pb-3 pt-4 sm:flex-row sm:items-center sm:justify-between sm:px-6">
        <div className="min-w-0">
          <CardTitle className="font-mono text-sm uppercase tracking-widest">
            Batch Timeline
            <span aria-hidden className="ml-2 text-muted-foreground/40">//</span>
          </CardTitle>
          <p className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
            {annotations?.length ?? 0} notes · click the chart to add one
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          className="h-8 shrink-0 font-mono text-[10px] uppercase tracking-wider"
          onClick={() => {
            setEditing(null);
            setPinAt(new Date());
            setDialogOpen(true);
          }}
        >
          <Plus className="mr-1.5 h-3 w-3" />
          Note now
        </Button>
      </CardHeader>

      <CardContent className="px-2 pb-4 sm:px-6 sm:pb-6">
        {isLoading ? (
          <Skeleton className="h-[280px] w-full sm:h-[360px]" />
        ) : !readings || readings.length === 0 ? (
          <div className="flex h-[280px] flex-col items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-muted-foreground sm:h-[360px]">
            <p className="font-mono text-sm">NO SENSOR DATA IN THIS WINDOW</p>
            <p className="mt-1 text-xs opacity-70">
              Notes can still be added with the button above
            </p>
          </div>
        ) : (
          <div className="h-[280px] w-full min-w-0 sm:h-[360px]">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={readings as Reading[]}
                onClick={handleChartClick}
                margin={
                  isMobile
                    ? { top: 16, right: 8, left: -10, bottom: 0 }
                    : { top: 20, right: 30, left: 20, bottom: 5 }
                }
                style={{ cursor: "crosshair" }}
              >
                <defs>
                  <linearGradient id="aTemp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="aHum" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                  </linearGradient>
                </defs>

                {/* Stage bands first, so they paint behind the series. */}
                {stageBands.map((band, i) => (
                  <ReferenceArea
                    key={`stage-${i}`}
                    x1={band.x1}
                    x2={band.x2}
                    yAxisId="left"
                    fill={band.fill}
                    stroke="none"
                    label={{
                      value: band.label,
                      position: "insideTopLeft",
                      fontSize: 9,
                      fill: "hsl(var(--muted-foreground))",
                    }}
                  />
                ))}

                <CartesianGrid strokeDasharray="4 6" stroke="hsl(var(--border))" vertical={false} />
                <XAxis
                  dataKey="timestamp"
                  tickFormatter={(v: string) =>
                    new Date(v).toLocaleDateString([], { month: "short", day: "numeric" })
                  }
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: "hsl(var(--muted-foreground))" }}
                  tickMargin={isMobile ? 8 : 12}
                  minTickGap={isMobile ? 40 : 30}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="left"
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: "hsl(var(--muted-foreground))" }}
                  width={isMobile ? 32 : 60}
                  axisLine={false}
                  tickLine={false}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: "hsl(var(--muted-foreground))" }}
                  width={isMobile ? 32 : 60}
                  axisLine={false}
                  tickLine={false}
                />

                <Tooltip content={<CustomTooltip />} wrapperStyle={{ outline: "none" }} />

                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="temp"
                  stroke="transparent"
                  fill="url(#aTemp)"
                  connectNulls
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="left"
                  type="monotone"
                  dataKey="hum"
                  stroke="transparent"
                  fill="url(#aHum)"
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="temp"
                  name="Air Temp °C"
                  stroke="hsl(var(--chart-1))"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="hum"
                  name="Humidity %"
                  stroke="hsl(var(--chart-2))"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="co2"
                  name="CO₂ ppm"
                  stroke="hsl(var(--chart-3))"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="compostTemp"
                  name="Compost °C"
                  stroke="hsl(var(--chart-6))"
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  connectNulls
                  isAnimationActive={false}
                />

                {/* Pins on top of everything. */}
                {(annotations ?? []).map((a) => (
                  <ReferenceLine
                    key={a.id}
                    x={a.at}
                    yAxisId="left"
                    stroke={SEVERITY_COLOR[a.severity]}
                    strokeWidth={a.severity === "info" ? 1 : 1.5}
                    strokeDasharray={a.severity === "info" ? "3 3" : undefined}
                    label={{
                      value: "●",
                      position: "top",
                      fontSize: 11,
                      fill: SEVERITY_COLOR[a.severity],
                    }}
                  />
                ))}
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        )}

        <AnnotationList
          annotations={annotations ?? []}
          onSelect={(a) => {
            setEditing(a);
            setPinAt(null);
            setDialogOpen(true);
          }}
        />
      </CardContent>

      <AnnotationDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        batchId={batch.batchId}
        at={pinAt}
        existing={editing}
        allowManualSnapshot={batch.imported ?? false}
      />
    </Card>
  );
}

/**
 * The notes as a list under the chart.
 *
 * A vertical line on a 60-day axis is a few pixels wide, which is not a usable
 * click target — especially on a phone. The list is the real way to reach a note;
 * the pins show *where* problems clustered.
 */
function AnnotationList({
  annotations,
  onSelect,
}: {
  annotations: BatchAnnotation[];
  onSelect: (a: BatchAnnotation) => void;
}) {
  if (annotations.length === 0) {
    return (
      <p className="mt-4 rounded-lg border border-dashed border-border/60 px-4 py-3 text-center font-mono text-[11px] text-muted-foreground">
        No notes yet. Click anywhere on the chart to log what happened.
      </p>
    );
  }

  return (
    <div className="mt-4 space-y-1.5">
      {annotations.map((a) => {
        const Icon = SEVERITY_ICON[a.severity];
        return (
          <button
            key={a.id}
            type="button"
            onClick={() => onSelect(a)}
            className="flex w-full items-start gap-2.5 rounded-lg border border-border/50 bg-secondary/10 px-3 py-2 text-left transition-colors hover:border-primary/40"
          >
            <Icon
              className="mt-0.5 h-3.5 w-3.5 shrink-0"
              style={{ color: SEVERITY_COLOR[a.severity] }}
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold">{a.title}</p>
              <p className="font-mono text-[10px] text-muted-foreground">
                {new Date(a.at).toLocaleDateString([], { month: "short", day: "numeric" })}
                {a.stageLabel ? ` · ${a.stageLabel}, day ${a.dayOfStage}` : ""}
              </p>
            </div>
            <Badge
              variant="outline"
              className="shrink-0 rounded-md border-border/60 font-mono text-[9px] uppercase"
            >
              {CATEGORY_LABELS[a.category]}
            </Badge>
          </button>
        );
      })}
    </div>
  );
}
