import { useGetReadingsSummary, getGetReadingsSummaryQueryKey } from "@/lib/api";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { DateRange } from "react-day-picker";

interface PeriodSummaryProps {
  dateRange: DateRange | undefined;
}

export function PeriodSummary({ dateRange }: PeriodSummaryProps) {
  const summaryParams = {
    from: dateRange?.from?.toISOString(),
    to: dateRange?.to?.toISOString(),
  };
  const { data, isLoading, isError } = useGetReadingsSummary(
    summaryParams,
    {
      query: {
        queryKey: getGetReadingsSummaryQueryKey(summaryParams),
        enabled: !!dateRange?.from,
      },
    }
  );

  if (isError) {
    return null;
  }

  return (
    <div className="grid grid-cols-1 min-[400px]:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 mt-4">
      <SummaryMetric 
        title="Avg Temp" 
        value={data?.avgTemp} 
        unit="°C" 
        min={data?.minTemp} 
        max={data?.maxTemp} 
        isLoading={isLoading} 
      />
      <SummaryMetric 
        title="Avg Hum" 
        value={data?.avgHum} 
        unit="%" 
        min={data?.minHum} 
        max={data?.maxHum} 
        isLoading={isLoading} 
      />
      <SummaryMetric 
        title="Avg CO2" 
        value={data?.avgCo2} 
        unit="ppm" 
        min={data?.minCo2} 
        max={data?.maxCo2} 
        isLoading={isLoading} 
      />
      <SummaryMetric 
        title="Avg VPD" 
        value={data?.avgVpd} 
        unit="kPa" 
        isLoading={isLoading} 
      />
    </div>
  );
}

function SummaryMetric({ 
  title, 
  value, 
  unit, 
  min, 
  max, 
  isLoading 
}: { 
  title: string; 
  value: number | null | undefined; 
  unit: string; 
  min?: number | null; 
  max?: number | null; 
  isLoading: boolean;
}) {
  return (
    <Card className="card-lift border-border/60 bg-card/50">
      <CardContent className="flex flex-col gap-1 p-4">
        <div className="font-mono text-xs uppercase text-muted-foreground">{title}</div>
        {isLoading ? (
          <Skeleton className="my-1 h-6 w-16" />
        ) : (
          <div className="font-mono text-lg font-semibold text-foreground">
            {value != null ? (
              <>
                {value.toFixed(1)} <span className="text-xs font-normal text-muted-foreground">{unit}</span>
              </>
            ) : (
              "--"
            )}
          </div>
        )}
        {(min != null || max != null) && !isLoading && (
          <div className="mt-1 flex items-center justify-between font-mono text-[10px] text-muted-foreground">
            {min != null && <span>Min: {min.toFixed(1)}</span>}
            {max != null && <span>Max: {max.toFixed(1)}</span>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
