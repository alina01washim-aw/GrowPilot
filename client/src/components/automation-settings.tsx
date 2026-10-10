import { useState, useEffect } from "react";
import { Thermometer, Wind, Droplets, Save, RotateCcw, SlidersHorizontal } from "lucide-react";
import {
  useGetSettings,
  getGetSettingsQueryKey,
  useUpdateSettings,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

// ─── Range stepper row ──────────────────────────────────────────────────────

interface RangeRowProps {
  label: string;
  unit: string;
  icon: React.ReactNode;
  minLabel: string;
  maxLabel: string;
  minDesc: string;
  maxDesc: string;
  minValue: number;
  maxValue: number;
  step: number;
  absMin: number;
  absMax: number;
  onMinChange: (v: number) => void;
  onMaxChange: (v: number) => void;
  error?: string;
}

function Stepper({
  value, step, min, max, onChange,
}: { value: number; step: number; min: number; max: number; onChange: (v: number) => void }) {
  function clamp(n: number) { return Math.min(max, Math.max(min, +n.toFixed(2))); }
  return (
    <div className="flex items-center gap-1 w-full max-w-[9rem]">
      <Button variant="outline" size="icon" className="h-8 w-8 sm:h-7 sm:w-7 shrink-0"
        onClick={() => onChange(clamp(value - step))}>−</Button>
      <Input
        type="number" step={step} min={min} max={max}
        className="h-8 sm:h-7 flex-1 min-w-0 text-center font-mono tabular-nums text-xs px-1"
        value={value}
        onChange={(e) => { const n = parseFloat(e.target.value); if (!isNaN(n)) onChange(clamp(n)); }}
      />
      <Button variant="outline" size="icon" className="h-8 w-8 sm:h-7 sm:w-7 shrink-0"
        onClick={() => onChange(clamp(value + step))}>+</Button>
    </div>
  );
}

function RangeRow({
  label, unit, icon, minLabel, maxLabel, minDesc, maxDesc,
  minValue, maxValue, step, absMin, absMax, onMinChange, onMaxChange, error,
}: RangeRowProps) {
  return (
    <div className="py-3 border-b border-border/40 last:border-0 space-y-2">
      <div className="flex items-center gap-2">
        <span className="text-primary">{icon}</span>
        <span className="font-mono text-sm font-semibold tracking-wide">{label}</span>
        <span className="ml-auto font-mono text-xs text-muted-foreground">{unit}</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 sm:gap-3">
        {/* Min */}
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{minLabel}</p>
          <Stepper value={minValue} step={step} min={absMin} max={maxValue - step} onChange={onMinChange} />
          <p className="text-[10px] text-muted-foreground">{minDesc}</p>
        </div>
        {/* Max */}
        <div className="space-y-1">
          <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">{maxLabel}</p>
          <Stepper value={maxValue} step={step} min={minValue + step} max={absMax} onChange={onMaxChange} />
          <p className="text-[10px] text-muted-foreground">{maxDesc}</p>
        </div>
      </div>
      {error && <p className="text-[11px] text-destructive font-mono">{error}</p>}
    </div>
  );
}

// ─── Main component ─────────────────────────────────────────────────────────

type Draft = {
  tempMin: number; tempMax: number;
  co2Min: number;  co2Max: number;
  humidityMin: number; humidityMax: number;
};

const DEFAULT_DRAFT: Draft = {
  tempMin: 21, tempMax: 23,
  co2Min: 700, co2Max: 1200,
  humidityMin: 85, humidityMax: 95,
};

export function AutomationSettings() {
  const { toast } = useToast();

  const { data, isLoading } = useGetSettings({
    query: { queryKey: getGetSettingsQueryKey() },
  });

  const [draft, setDraft] = useState<Draft>(DEFAULT_DRAFT);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (data) {
      setDraft({
        tempMin: data.tempMin, tempMax: data.tempMax,
        co2Min:  data.co2Min,  co2Max:  data.co2Max,
        humidityMin: data.humidityMin, humidityMax: data.humidityMax,
      });
      setDirty(false);
    }
  }, [data]);

  function patch<K extends keyof Draft>(key: K, value: number) {
    setDraft((d) => ({ ...d, [key]: value }));
    setDirty(true);
  }

  function reset() {
    if (data) {
      setDraft({
        tempMin: data.tempMin, tempMax: data.tempMax,
        co2Min:  data.co2Min,  co2Max:  data.co2Max,
        humidityMin: data.humidityMin, humidityMax: data.humidityMax,
      });
      setDirty(false);
    }
  }

  const mutation = useUpdateSettings({
    mutation: {
      onSuccess: () => {
        setDirty(false);
        toast({ title: "Thresholds saved", description: "New ranges active immediately. ESP32 config updated via MQTT." });
      },
      onError: (err) => {
        const msg = err instanceof Error ? err.message : "Could not save thresholds.";
        toast({ title: "Save failed", description: msg, variant: "destructive" });
      },
    },
  });

  // Inline validation
  const errors = {
    temp: draft.tempMin >= draft.tempMax ? "Min must be less than Max" : undefined,
    co2:  draft.co2Min  >= draft.co2Max  ? "Min must be less than Max" : undefined,
    hum:  draft.humidityMin >= draft.humidityMax ? "Min must be less than Max" : undefined,
  };
  const hasErrors = Object.values(errors).some(Boolean);

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <SlidersHorizontal className="h-4 w-4 text-primary" />
          Ideal Ranges
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          In-band readings leave relay unchanged (hysteresis)
        </p>
      </CardHeader>
      <CardContent className="space-y-0">
        {isLoading ? (
          <p className="text-sm text-muted-foreground font-mono py-4 text-center">Loading…</p>
        ) : (
          <>
            <RangeRow
              label="Temperature" unit="°C"
              icon={<Thermometer className="h-4 w-4" />}
              minLabel="Temp Min" maxLabel="Temp Max"
              minDesc="Fridge OFF below"
              maxDesc="Fridge ON above"
              minValue={draft.tempMin} maxValue={draft.tempMax}
              step={0.5} absMin={-20} absMax={60}
              onMinChange={(v) => patch("tempMin", v)}
              onMaxChange={(v) => patch("tempMax", v)}
              error={errors.temp}
            />
            <RangeRow
              label="CO₂" unit="ppm"
              icon={<Wind className="h-4 w-4" />}
              minLabel="CO₂ Min" maxLabel="CO₂ Max"
              minDesc="Fan OFF below"
              maxDesc="Fan ON above"
              minValue={draft.co2Min} maxValue={draft.co2Max}
              step={50} absMin={0} absMax={20000}
              onMinChange={(v) => patch("co2Min", v)}
              onMaxChange={(v) => patch("co2Max", v)}
              error={errors.co2}
            />
            <RangeRow
              label="Humidity" unit="%"
              icon={<Droplets className="h-4 w-4" />}
              minLabel="Hum Min" maxLabel="Hum Max"
              minDesc="Mist maker ON below"
              maxDesc="Mist maker OFF above"
              minValue={draft.humidityMin} maxValue={draft.humidityMax}
              step={1} absMin={0} absMax={100}
              onMinChange={(v) => patch("humidityMin", v)}
              onMaxChange={(v) => patch("humidityMax", v)}
              error={errors.hum}
            />

            <div className="flex gap-2 pt-4">
              <Button
                className={cn("flex-1 font-mono text-xs uppercase tracking-wider h-8")}
                disabled={!dirty || hasErrors || mutation.isPending}
                onClick={() => mutation.mutate({ data: draft })}
              >
                <Save className="h-3.5 w-3.5 mr-1.5" />
                {mutation.isPending ? "Saving…" : "Save"}
              </Button>
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                disabled={!dirty || mutation.isPending}
                onClick={reset} title="Discard changes"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>

            {data?.updatedAt && (
              <p className="text-[10px] text-muted-foreground font-mono pt-2 text-right">
                Last saved {new Date(data.updatedAt).toLocaleString()}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
