import { DateRange } from "react-day-picker";
import { useListReadings, getListReadingsQueryKey } from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  LineChart,
  Area,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { Skeleton } from "@/components/ui/skeleton";
import { PeriodSummary } from "@/components/period-summary";
import { DatePickerWithRange } from "@/components/date-range-picker";
import { useIsMobile } from "@/hooks/use-mobile";

interface HistoricalGraphsProps {
  dateRange: DateRange | undefined;
  setDateRange: (range: DateRange | undefined) => void;
}

export function HistoricalGraphs({ dateRange, setDateRange }: HistoricalGraphsProps) {
  const isMobile = useIsMobile();
  const readingsParams = {
    from: dateRange?.from?.toISOString(),
    to: dateRange?.to?.toISOString(),
    limit: 5000,
  };
  const { data: readings, isLoading, isError } = useListReadings(readingsParams, {
    query: {
      queryKey: getListReadingsQueryKey(readingsParams),
      enabled: !!dateRange?.from,
    }
  });

  const formatXAxis = (tickItem: string) => {
    const date = new Date(tickItem);
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div className="rounded-lg border border-card-border bg-popover p-3 font-mono text-sm shadow-xl shadow-black/10 backdrop-blur-md">
          <p className="mb-2 text-[10px] uppercase tracking-widest text-muted-foreground">
            {new Date(label).toLocaleString()}
          </p>
          <div className="space-y-1">
            {payload.map((entry: any, index: number) => (
              <div key={index} className="flex items-center justify-between gap-4">
                <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                  <span className="h-1 w-3 rounded-full" style={{ background: entry.color }} />
                  {entry.name}
                </span>
                <span className="font-semibold" style={{ color: entry.color }}>
                  {typeof entry.value === "number" ? entry.value.toFixed(2) : "n/a"}
                </span>
              </div>
            ))}
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <Card className="card-lift col-span-1 min-w-0 overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm lg:col-span-3">
      <CardHeader className="mb-4 flex flex-col gap-3 border-b border-border/50 px-4 pb-3 pt-4 sm:mb-6 sm:flex-row sm:items-center sm:justify-between sm:px-6 sm:pt-6">
        <div className="min-w-0">
          <CardTitle className="font-mono text-base font-bold uppercase tracking-wider sm:text-lg">
            Environment History
            <span aria-hidden className="ml-2 text-muted-foreground/40">//</span>
          </CardTitle>
        </div>
        <DatePickerWithRange date={dateRange} setDate={setDateRange} className="w-full sm:w-auto" />
      </CardHeader>
      <CardContent className="px-2 pb-4 sm:px-6 sm:pb-6">
        {isLoading ? (
          <Skeleton className="w-full h-[240px] sm:h-[320px] md:h-[400px]" />
        ) : isError ? (
          <div className="h-[240px] sm:h-[320px] md:h-[400px] flex items-center justify-center rounded-lg border border-destructive/20 bg-destructive/5 text-sm text-destructive px-4 text-center">
            Failed to load historical data.
          </div>
        ) : readings && readings.length === 0 ? (
          <div className="h-[240px] sm:h-[320px] md:h-[400px] flex flex-col items-center justify-center rounded-lg border border-dashed border-border px-4 text-center text-muted-foreground">
            <p className="font-mono text-sm">NO DATA FOUND</p>
            <p className="text-xs opacity-70 mt-1">Try a different date range</p>
          </div>
        ) : (
          <div className="h-[240px] w-full min-w-0 sm:h-[320px] md:h-[400px]">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart
                data={readings}
                margin={
                  isMobile
                    ? { top: 5, right: 8, left: -10, bottom: 0 }
                    : { top: 10, right: 30, left: 20, bottom: 5 }
                }
              >
                <defs>
                  <linearGradient id="gTemp" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-1))" stopOpacity={0.28} />
                    <stop offset="100%" stopColor="hsl(var(--chart-1))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gHum" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-2))" stopOpacity={0.22} />
                    <stop offset="100%" stopColor="hsl(var(--chart-2))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="gCo2" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--chart-3))" stopOpacity={0.25} />
                    <stop offset="100%" stopColor="hsl(var(--chart-3))" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="4 6" stroke="hsl(var(--border))" vertical={false} />
                <XAxis 
                  dataKey="timestamp" 
                  tickFormatter={formatXAxis} 
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: 'hsl(var(--muted-foreground))' }}
                  tickMargin={isMobile ? 8 : 12}
                  minTickGap={isMobile ? 40 : 30}
                  axisLine={false}
                  tickLine={false}
                />
                
                {/* Left Y-Axis for Temp & Hum */}
                <YAxis 
                  yAxisId="left" 
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(val) => `${val}`}
                  width={isMobile ? 32 : 60}
                  axisLine={false}
                  tickLine={false}
                />
                
                {/* Right Y-Axis for CO2 */}
                <YAxis 
                  yAxisId="right" 
                  orientation="right" 
                  stroke="hsl(var(--muted-foreground))"
                  tick={{ fontSize: isMobile ? 10 : 12, fill: 'hsl(var(--muted-foreground))' }}
                  tickFormatter={(val) => `${val}`}
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
                  fill="url(#gTemp)"
                  connectNulls
                  isAnimationActive={false}
                />
                <Area 
                  yAxisId="left" 
                  type="monotone" 
                  dataKey="hum" 
                  stroke="transparent" 
                  fill="url(#gHum)"
                  connectNulls
                  isAnimationActive={false}
                />
                <Area 
                  yAxisId="right" 
                  type="monotone" 
                  dataKey="co2" 
                  stroke="transparent" 
                  fill="url(#gCo2)"
                  connectNulls
                  isAnimationActive={false}
                />
                
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="temp" 
                  name="Air Temp °C"
                  stroke="hsl(var(--chart-1))" 
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="hum" 
                  name="Air Hum %"
                  stroke="hsl(var(--chart-2))" 
                  strokeWidth={2}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line 
                  yAxisId="right"
                  type="monotone" 
                  dataKey="co2" 
                  name="CO2 ppm"
                  stroke="hsl(var(--chart-3))" 
                  strokeWidth={2.25}
                  strokeLinecap="round"
                  dot={false}
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="scdTemp" 
                  name="SCD40 Temp °C"
                  stroke="hsl(var(--chart-4))" 
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  connectNulls
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="scdHum" 
                  name="SCD40 Hum %"
                  stroke="hsl(var(--chart-5))" 
                  strokeWidth={1.5}
                  strokeDasharray="5 3"
                  dot={false}
                  connectNulls
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
                <Line 
                  yAxisId="left"
                  type="monotone" 
                  dataKey="compostTemp" 
                  name="Compost Temp °C"
                  stroke="hsl(var(--chart-6))" 
                  strokeWidth={2}
                  strokeLinecap="round"
                  dot={false}
                  connectNulls
                  activeDot={{ r: 4, strokeWidth: 0 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}

        <ChartLegend />

        <PeriodSummary dateRange={dateRange} />
      </CardContent>
    </Card>
  );
}

function LegendEntry({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5 font-mono text-[10px] text-muted-foreground">
      <span
        className="h-0.5 w-4 shrink-0"
        style={
          dashed
            ? {
                backgroundImage: `repeating-linear-gradient(90deg, hsl(var(--${color})) 0 4px, transparent 4px 7px)`,
              }
            : { background: `hsl(var(--${color}))`, borderRadius: "9999px" }
        }
      />
      {label}
    </span>
  );
}

function ChartLegend() {
  return (
    <div className="mt-4 grid grid-cols-1 gap-x-4 gap-y-2.5 rounded-lg border border-border/40 bg-card/40 px-4 py-3 min-[420px]:grid-cols-2 lg:grid-cols-3">
      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">
          SHT40 · Ambient Air
        </span>
        <LegendEntry color="chart-1" label="Air Temp °C" />
        <LegendEntry color="chart-2" label="Air Hum %" />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">
          SCD40 · CO₂ Monitor
        </span>
        <LegendEntry color="chart-3" label="CO₂ ppm" />
        <LegendEntry color="chart-4" label="Sensor Temp °C" dashed />
        <LegendEntry color="chart-5" label="Sensor Hum %" dashed />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-[9px] font-mono uppercase tracking-widest text-muted-foreground/70">
          DS18B20 · Compost Probe
        </span>
        <LegendEntry color="chart-6" label="Compost Temp °C" />
      </div>
    </div>
  );
}
