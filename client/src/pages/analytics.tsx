import { useState } from "react";
import { subDays } from "date-fns";
import { BarChart3 } from "lucide-react";
import { DateRange } from "react-day-picker";
import { HistoricalGraphs } from "@/components/historical-graphs";
import { LiveStats } from "@/components/live-stats";
import { PeriodSummary } from "@/components/period-summary";
import { SectionHeading } from "@/components/layout/section-heading";
import { cn } from "@/lib/utils";

const RANGES = [
  { key: "24h", label: "24H", days: 1 },
  { key: "7d", label: "7D", days: 7 },
  { key: "30d", label: "30D", days: 30 },
] as const;

type RangeKey = (typeof RANGES)[number]["key"];

export default function AnalyticsPage() {
  const [range, setRange] = useState<RangeKey>("24h");
  const days = RANGES.find((r) => r.key === range)?.days ?? 1;

  const [dateRange, setDateRange] = useState<DateRange | undefined>({
    from: subDays(new Date(), days),
    to: new Date(),
  });

  function selectRange(key: RangeKey) {
    setRange(key);
    const d = RANGES.find((r) => r.key === key)?.days ?? 1;
    setDateRange({ from: subDays(new Date(), d), to: new Date() });
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        icon={<BarChart3 className="h-4 w-4" />}
        title="Analytics"
        description="Trends and summaries for the selected window"
        right={
          <div className="flex items-center gap-1 rounded-lg border border-slate-200 bg-card/70 p-1 dark:border-slate-800">
            {RANGES.map((r) => (
              <button
                key={r.key}
                type="button"
                onClick={() => selectRange(r.key)}
                className={cn(
                  "rounded-md px-3 py-1 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors",
                  range === r.key
                    ? "bg-primary text-primary-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {r.label}
              </button>
            ))}
          </div>
        }
      />

      <LiveStats />

      <PeriodSummary dateRange={dateRange} />

      <HistoricalGraphs dateRange={dateRange} setDateRange={setDateRange} />
    </div>
  );
}