import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import type { VpdStatusCode } from "@/lib/api/vpd";

export const VPD_ZONE_COLORS: Record<string, string> = {
  RED: "#ef4444",
  ORANGE: "#f97316",
  YELLOW: "#eab308",
  LIGHT_GREEN: "#84cc16",
  DARK_GREEN: "#22c55e",
};

export const VPD_ZONE_LABELS: Record<string, string> = {
  DARK_GREEN: "OPTIMAL",
  LIGHT_GREEN: "ACCEPTABLE",
  YELLOW: "WARNING",
  ORANGE: "ALERT",
  RED: "CRITICAL",
  NO_DATA: "NO DATA",
};

interface VpdGaugeProps {
  vpd: number | null;
  targetMin: number;
  targetMax: number;
  warningMargin: number;
  statusCode?: VpdStatusCode | null;
  statusMessage?: string | null;
  loading?: boolean;
}

interface Segment {
  color: string;
  from: number;
  to: number;
}

/**
 * BP-monitor style gauge: a segmented color bar (RED → ORANGE → YELLOW →
 * LIGHT_GREEN → DARK_GREEN → … ) with an arrow pointing at the current
 * surface VPD. Segment widths are proportional to the kPa scale, which is
 * derived from the configured target band (±3× warning margin).
 */
export function VpdGauge({
  vpd,
  targetMin,
  targetMax,
  warningMargin,
  statusCode,
  statusMessage,
  loading,
}: VpdGaugeProps) {
  const width = targetMax - targetMin;
  const center = (targetMin + targetMax) / 2;
  const centerHalf = Math.max(width * 0.25, 0.02);
  const m = Math.max(warningMargin, 0.001);

  const scaleMin = Math.max(0, targetMin - 3 * m);
  const scaleMax = targetMax + 3 * m;
  const span = Math.max(scaleMax - scaleMin, 0.001);

  const boundaries = [
    scaleMin,
    targetMin - 2 * m,
    targetMin - m,
    targetMin,
    center - centerHalf,
    center + centerHalf,
    targetMax,
    targetMax + m,
    targetMax + 2 * m,
    scaleMax,
  ];
  const colors = [
    VPD_ZONE_COLORS.RED,
    VPD_ZONE_COLORS.ORANGE,
    VPD_ZONE_COLORS.YELLOW,
    VPD_ZONE_COLORS.LIGHT_GREEN,
    VPD_ZONE_COLORS.DARK_GREEN,
    VPD_ZONE_COLORS.LIGHT_GREEN,
    VPD_ZONE_COLORS.YELLOW,
    VPD_ZONE_COLORS.ORANGE,
    VPD_ZONE_COLORS.RED,
  ];

  const segments: Segment[] = [];
  for (let i = 0; i < colors.length; i++) {
    const from = Math.max(boundaries[i], scaleMin);
    const to = Math.min(boundaries[i + 1], scaleMax);
    if (to > from) segments.push({ color: colors[i], from, to });
  }

  const arrowPct =
    vpd != null
      ? Math.min(100, Math.max(0, ((vpd - scaleMin) / span) * 100))
      : null;
  const color = statusCode ? VPD_ZONE_COLORS[statusCode] ?? VPD_ZONE_COLORS.RED : VPD_ZONE_COLORS.RED;

  if (loading) {
    return (
      <div className="space-y-2.5">
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-2.5 w-full rounded-full" />
        <Skeleton className="h-3 w-44" />
      </div>
    );
  }

  return (
    <div className="min-w-0 space-y-2">
      <div className="flex items-end justify-between gap-2">
        <div className="min-w-0">
          <div className="font-mono text-[10px] uppercase tracking-widest text-muted-foreground">
            Surface VPD
          </div>
          <div className="font-mono text-xl font-bold tracking-tight sm:text-2xl">
            {vpd != null ? (
              <>
                {vpd.toFixed(3)}
                <span className="ml-1 text-xs font-normal text-muted-foreground">kPa</span>
              </>
            ) : (
              "--"
            )}
          </div>
        </div>
        <span
          className="shrink-0 rounded-md px-2 py-0.5 font-mono text-[10px] font-bold tracking-widest text-black"
          style={{ backgroundColor: color }}
        >
          {statusCode ? VPD_ZONE_LABELS[statusCode] ?? statusCode : "--"}
        </span>
      </div>

      <div className="relative pt-4">
        {arrowPct != null && (
          <div
            className="absolute top-0 z-10 -translate-x-1/2"
            style={{ left: `${arrowPct}%` }}
            title={`${vpd?.toFixed(3)} kPa`}
          >
            <div
              className="h-0 w-0 border-x-[5px] border-t-[7px] border-x-transparent"
              style={{ borderTopColor: color }}
            />
          </div>
        )}
        <div className="flex h-2.5 w-full overflow-hidden rounded-full ring-1 ring-border/70">
          {segments.map((seg, i) => (
            <div
              key={i}
              className="h-full flex-none"
              style={{
                width: `${((seg.to - seg.from) / span) * 100}%`,
                backgroundColor: seg.color,
              }}
            />
          ))}
        </div>
        <div className="mt-1 flex justify-between font-mono text-[9px] text-muted-foreground/70">
          <span>{scaleMin.toFixed(2)}</span>
          <span className="text-muted-foreground">{targetMin.toFixed(2)}</span>
          <span className="text-muted-foreground">{targetMax.toFixed(2)}</span>
          <span>{scaleMax.toFixed(2)}</span>
        </div>
      </div>

      {statusMessage && (
        <p className="text-[10px] font-mono leading-relaxed text-muted-foreground">
          {statusMessage}
        </p>
      )}
      <p className={cn("text-[9px] font-mono uppercase tracking-widest text-muted-foreground/50")}>
        SVP(compost) − AVP(air) · target {targetMin.toFixed(2)}–{targetMax.toFixed(2)} kPa
      </p>
    </div>
  );
}
