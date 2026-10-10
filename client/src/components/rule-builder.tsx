import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Plus,
  Trash2,
  Save,
  GitBranch,
  Target,
  Zap,
  ChevronDown,
  Thermometer,
  Droplets,
  Wind,
  Fan,
  Snowflake,
  Lightbulb,
  ArrowRight,
  Clock,
  Hourglass,
  Timer,
  HelpCircle,
  Sparkles,
  BookOpen,
  Pencil,
  Power,
  X,
  FlaskConical,
} from "lucide-react";
import {
  getRuleList,
  createRule,
  updateRule,
  deleteRule,
  emptyRuleDraft,
  RULE_SENSORS,
  RULE_OPERATORS,
  RULE_RELAY_KEYS,
  RULE_STAGES,
  type RuleDraft,
  type RuleCondition,
  type RuleInput,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import { DeviceIcon, deviceIconId, deviceLabel } from "@/lib/device-registry";

// ─── Icons & labels ─────────────────────────────────────────────────────────

function sensorIcon(key: string) {
  if (key === "humidity" || key === "scd_hum") return Droplets;
  if (key === "co2") return Wind;
  return Thermometer;
}

function sensorLabel(key: string): string {
  return RULE_SENSORS.find((s) => s.key === key)?.label ?? key;
}

function sensorUnit(key: string): string {
  return RULE_SENSORS.find((s) => s.key === key)?.unit ?? "";
}

function relayLabel(key: string): string {
  return deviceLabel(key);
}

// Zone tones: IF = amber (warning), THEN = green (success), STOP = blue (info)
type Tone = "warning" | "success" | "info";

const TONE_TEXT: Record<Tone, string> = {
  warning: "text-[hsl(var(--warning))]",
  success: "text-[hsl(var(--success))]",
  info: "text-[hsl(var(--info))]",
};

const TONE_CHIP: Record<Tone, string> = {
  warning:
    "border-[hsl(var(--warning)/0.35)] bg-[hsl(var(--warning)/0.08)] text-[hsl(var(--warning))]",
  success:
    "border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.08)] text-[hsl(var(--success))]",
  info: "border-[hsl(var(--info)/0.35)] bg-[hsl(var(--info)/0.08)] text-[hsl(var(--info))]",
};

const TONE_BORDER_L: Record<Tone, string> = {
  warning: "border-l-[hsl(var(--warning)/0.6)]",
  success: "border-l-[hsl(var(--success)/0.6)]",
  info: "border-l-[hsl(var(--info)/0.6)]",
};

const GRADIENTS = [
  "from-amber-500 to-orange-600",
  "from-emerald-500 to-teal-600",
  "from-sky-500 to-blue-600",
  "from-violet-500 to-purple-600",
];

// Ready-made rules that teach the system by example (mirror the old ranges).
const EXAMPLE_RULES: RuleInput[] = [
  {
    name: "Cooling + Mist (heat burst)",
    enabled: true,
    priority: 10,
    profileIds: [],
    stageKeys: [],
    triggerMode: "all",
    triggers: [
      { sensor: "air_temp", operator: "<", value: 30 },
      { sensor: "humidity", operator: "<", value: 80 },
    ],
    actions: { turnOn: ["ac", "mist_maker"], turnOff: [] },
    cutoffMode: "any",
    cutoffs: [{ sensor: "air_temp", operator: ">=", value: 25 }],
    offActions: { turnOff: ["ac", "mist_maker"] },
    minOnMs: 60_000,
    minOffMs: 0,
    cooldownMs: 10_000,
  },
  {
    name: "Humidity target (misting)",
    enabled: true,
    priority: 20,
    profileIds: [],
    stageKeys: [],
    triggerMode: "all",
    triggers: [{ sensor: "humidity", operator: "<", value: 85 }],
    actions: { turnOn: ["mist_maker"], turnOff: [] },
    cutoffMode: "any",
    cutoffs: [{ sensor: "humidity", operator: ">=", value: 95 }],
    offActions: { turnOff: ["mist_maker"] },
    minOnMs: 30_000,
    minOffMs: 0,
    cooldownMs: 10_000,
  },
  {
    name: "CO₂ exhaust fan",
    enabled: true,
    priority: 30,
    profileIds: [],
    stageKeys: [],
    triggerMode: "all",
    triggers: [{ sensor: "co2", operator: ">", value: 1200 }],
    actions: { turnOn: ["fan"], turnOff: [] },
    cutoffMode: "any",
    cutoffs: [{ sensor: "co2", operator: "<", value: 900 }],
    offActions: { turnOff: ["fan"] },
    minOnMs: 30_000,
    minOffMs: 0,
    cooldownMs: 10_000,
  },
];

// ─── Read-only visual chips ─────────────────────────────────────────────────

function ConditionChip({ cond, tone }: { cond: RuleCondition; tone: Tone }) {
  const Icon = sensorIcon(cond.sensor);
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium",
        TONE_CHIP[tone],
      )}
    >
      <Icon className="h-3 w-3" />
      {sensorLabel(cond.sensor)} {cond.operator} {cond.value}
      {sensorUnit(cond.sensor) && ` ${sensorUnit(cond.sensor)}`}
    </span>
  );
}

function DeviceChip({ key: relayKey, tone }: { key: string; tone: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] font-medium",
        TONE_CHIP[tone],
      )}
    >
      <DeviceIcon icon={deviceIconId(relayKey)} className="h-3 w-3" />
      {relayLabel(relayKey)}
    </span>
  );
}

function JoinChip({ mode, tone }: { mode: "all" | "any"; tone: Tone }) {
  return (
    <span
      className={cn(
        "rounded px-1 font-mono text-[9px] font-bold uppercase tracking-wider",
        TONE_TEXT[tone],
      )}
    >
      {mode}
    </span>
  );
}

// ─── Editor building blocks ─────────────────────────────────────────────────

function Zone({
  tone,
  icon,
  title,
  subtitle,
  right,
  children,
}: {
  tone: Tone;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "space-y-2 rounded-lg border border-l-2 border-card-border/60 bg-card/40 p-2.5",
        TONE_BORDER_L[tone],
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={cn(
            "grid h-5 w-5 place-items-center rounded",
            TONE_CHIP[tone],
          )}
        >
          {icon}
        </span>
        <span className="text-[11px] font-semibold uppercase tracking-widest">
          {title}
        </span>
        {subtitle && (
          <span className="font-mono text-[10px] text-muted-foreground/80">
            {subtitle}
          </span>
        )}
        {right && <span className="ml-auto">{right}</span>}
      </div>
      {children}
    </div>
  );
}

function ModeSelect({
  value,
  onChange,
}: {
  value: "all" | "any";
  onChange: (m: "all" | "any") => void;
}) {
  return (
    <Select value={value} onValueChange={(m) => onChange(m as "all" | "any")}>
      <SelectTrigger className="h-6 w-[4.2rem] text-[11px]">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value="all">ALL</SelectItem>
        <SelectItem value="any">ANY</SelectItem>
      </SelectContent>
    </Select>
  );
}

function ConditionRow({
  cond,
  onChange,
  onRemove,
  removable,
}: {
  cond: RuleCondition;
  onChange: (c: RuleCondition) => void;
  onRemove: () => void;
  removable: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        value={cond.sensor}
        onValueChange={(sensor) => onChange({ ...cond, sensor })}
      >
        <SelectTrigger className="h-7 w-[10.5rem] text-xs">
          <SelectValue placeholder="Sensor" />
        </SelectTrigger>
        <SelectContent>
          {RULE_SENSORS.map((s) => (
            <SelectItem key={s.key} value={s.key}>
              {s.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={cond.operator}
        onValueChange={(operator) => onChange({ ...cond, operator })}
      >
        <SelectTrigger className="h-7 w-14 font-mono text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {RULE_OPERATORS.map((op) => (
            <SelectItem key={op} value={op} className="font-mono">
              {op}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Input
        type="number"
        step="any"
        className="h-7 w-20 font-mono text-xs"
        value={cond.value}
        onChange={(e) => {
          const n = parseFloat(e.target.value);
          if (!isNaN(n)) onChange({ ...cond, value: n });
        }}
      />
      <span className="w-7 font-mono text-[10px] text-muted-foreground">
        {sensorUnit(cond.sensor)}
      </span>
      <Button
        variant="ghost"
        size="icon"
        className="h-7 w-7 text-muted-foreground hover:text-destructive disabled:opacity-30"
        onClick={onRemove}
        disabled={!removable}
        title={
          removable ? "Remove condition" : "At least one condition is required"
        }
      >
        <X className="h-3.5 w-3.5" />
      </Button>
    </div>
  );
}

function DevicePicker({
  selected,
  onToggle,
}: {
  selected: string[];
  onToggle: (key: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {RULE_RELAY_KEYS.map((key) => {
        const active = selected.includes(key);
        return (
          <button
            key={key}
            type="button"
            onClick={() => onToggle(key)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium transition-colors",
              active
                ? "border-primary/50 bg-primary/12 text-primary shadow-sm"
                : "border-card-border bg-card/40 text-muted-foreground hover:border-primary/40 hover:text-foreground",
            )}
          >
            <DeviceIcon icon={deviceIconId(key)} className="h-3.5 w-3.5" />
            {deviceLabel(key)}
            {active && (
              <span className="grid h-3.5 w-3.5 place-items-center rounded-full bg-primary text-primary-foreground">
                <svg
                  viewBox="0 0 8 8"
                  className="h-2 w-2 fill-none stroke-current stroke-[1.5]"
                >
                  <path
                    d="M1.5 4.2 3.2 5.9 6.5 2.4"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

function TimerField({
  icon,
  label,
  valueMs,
  onChange,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  valueMs: number;
  onChange: (ms: number) => void;
  hint: string;
}) {
  return (
    <label className="flex items-center gap-1.5" title={hint}>
      <span className="text-muted-foreground">{icon}</span>
      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
      <Input
        type="number"
        min={0}
        className="h-7 w-16 font-mono text-xs"
        value={Math.round(valueMs / 1000)}
        onChange={(e) => {
          const s = parseInt(e.target.value, 10);
          if (!isNaN(s)) onChange(Math.max(0, s) * 1000);
        }}
      />
      <span className="font-mono text-[10px] text-muted-foreground">s</span>
    </label>
  );
}

// ─── Rule card (visual preview + expandable editor) ─────────────────────────

function RuleCard({
  initial,
  isNew,
  saving,
  onSave,
  onDelete,
  index,
}: {
  initial: RuleDraft;
  isNew: boolean;
  saving: boolean;
  onSave: (draft: RuleDraft, id?: string) => void;
  onDelete?: (id: string) => void;
  index: number;
}) {
  const [draft, setDraft] = useState<RuleDraft>(initial);
  const [dirty, setDirty] = useState(false);
  const [expanded, setExpanded] = useState(isNew);

  useEffect(() => {
    setDraft(initial);
    setDirty(false);
  }, [initial]);

  const set = (d: Partial<RuleDraft>) => {
    setDraft((prev) => ({ ...prev, ...d }));
    setDirty(true);
  };

  const gradient = GRADIENTS[index % GRADIENTS.length];
  const hasActions =
    draft.actions.turnOn.length > 0 || draft.actions.turnOff.length > 0;

  return (
    <div
      className={cn(
        "overflow-hidden rounded-xl border bg-card/60 shadow-sm transition-colors",
        expanded
          ? "border-primary/30"
          : "border-card-border hover:border-primary/30",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 p-3">
        <span
          className={cn(
            "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-gradient-to-br text-white shadow-md",
            gradient,
          )}
        >
          <GitBranch className="h-4.5 w-4.5" />
        </span>

        <div className="min-w-0">
          <p className="truncate text-sm font-semibold leading-tight">
            {draft.name || (
              <span className="italic text-muted-foreground">
                Untitled rule
              </span>
            )}
          </p>
          <div className="mt-0.5 flex items-center gap-1.5">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full border px-1.5 py-px font-mono text-[9px] font-semibold uppercase tracking-wider",
                draft.enabled
                  ? "border-[hsl(var(--success)/0.4)] bg-[hsl(var(--success)/0.1)] text-[hsl(var(--success))]"
                  : "border-card-border bg-muted text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  draft.enabled
                    ? "bg-[hsl(var(--success))]"
                    : "bg-muted-foreground/60",
                )}
              />
              {draft.enabled ? "On" : "Off"}
            </span>
            <span className="rounded-full border border-card-border bg-card/40 px-1.5 py-px font-mono text-[9px] text-muted-foreground">
              P{draft.priority}
            </span>
            {dirty && (
              <span className="font-mono text-[9px] font-semibold uppercase text-[hsl(var(--warning))]">
                unsaved
              </span>
            )}
          </div>
        </div>

        <div className="ml-auto flex items-center gap-1">
          {!isNew && onDelete && draft.id && (
            <Button
              variant="ghost"
              size="icon"
              className="h-8 w-8 text-muted-foreground hover:text-destructive"
              title="Delete rule"
              onClick={() => onDelete(draft.id!)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            className="h-8 gap-1 text-xs"
            onClick={() => setExpanded((v) => !v)}
          >
            {expanded ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <Pencil className="h-3.5 w-3.5" />
            )}
            {expanded ? "Close" : "Edit"}
          </Button>
        </div>
      </div>

      {/* Visual flow preview */}
      {!expanded && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-card-border/60 px-3 py-2.5">
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--warning))]">
            if
          </span>
          {draft.triggers.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <JoinChip mode={draft.triggerMode} tone="warning" />}
              <ConditionChip cond={c} tone="warning" />
            </span>
          ))}
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--success))]">
            then
          </span>
          {hasActions ? (
            <>
              {draft.actions.turnOn.map((k) => (
                <DeviceChip key={k} tone="success" />
              ))}
              {draft.actions.turnOff.map((k) => (
                <DeviceChip key={k} tone="success" />
              ))}{" "}
            </>
          ) : (
            <span className="font-mono text-[10px] italic text-muted-foreground/70">
              …
            </span>
          )}
          <ArrowRight className="h-3.5 w-3.5 text-muted-foreground/60" />
          <span className="font-mono text-[9px] font-bold uppercase tracking-wider text-[hsl(var(--info))]">
            stop
          </span>
          {draft.cutoffs.map((c, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <JoinChip mode={draft.cutoffMode} tone="info" />}
              <ConditionChip cond={c} tone="info" />
            </span>
          ))}
          <span className="text-muted-foreground/60">·</span>
          {draft.offActions.turnOff.map((k) => (
            <DeviceChip key={k} tone="info" />
          ))}
        </div>
      )}

      {/* Editor */}
      {expanded && (
        <div className="space-y-2.5 border-t border-card-border/60 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="h-8 w-48 font-mono text-xs"
              placeholder="Rule name (e.g. Cooling + Mist)"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
            />
            <label
              className="flex items-center gap-1.5"
              title="Smaller number = higher priority when rules conflict"
            >
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                priority
              </span>
              <Input
                type="number"
                min={0}
                max={1000}
                className="h-7 w-16 font-mono text-xs"
                value={draft.priority}
                onChange={(e) => {
                  const n = parseInt(e.target.value, 10);
                  if (!isNaN(n)) set({ priority: n });
                }}
              />
            </label>
            <label className="flex items-center gap-1.5">
              <Switch
                checked={draft.enabled}
                onCheckedChange={(v) => set({ enabled: v })}
              />
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Enabled
              </span>
            </label>
          </div>

          {/* Crop-stage scope: an unscoped rule always applies; a scoped rule
              is only pushed to the device while one of its stages is running. */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span
              className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
              title="Leave all off for a rule that applies in every stage"
            >
              stages
            </span>
            <button
              type="button"
              onClick={() => set({ stageKeys: [] })}
              className={cn(
                "rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                (draft.stageKeys ?? []).length === 0
                  ? "border-primary/40 bg-primary/10 text-primary"
                  : "border-card-border text-muted-foreground hover:text-foreground",
              )}
            >
              Always
            </button>
            {RULE_STAGES.map((stage) => {
              const on = (draft.stageKeys ?? []).includes(stage.key);
              return (
                <button
                  key={stage.key}
                  type="button"
                  onClick={() =>
                    set({
                      stageKeys: on
                        ? (draft.stageKeys ?? []).filter((k) => k !== stage.key)
                        : [...(draft.stageKeys ?? []), stage.key],
                    })
                  }
                  className={cn(
                    "rounded-md border px-1.5 py-0.5 font-mono text-[10px] transition-colors",
                    on
                      ? "border-primary/40 bg-primary/10 text-primary"
                      : "border-card-border text-muted-foreground hover:text-foreground",
                  )}
                >
                  {stage.label}
                </button>
              );
            })}
          </div>

          <Zone
            tone="warning"
            icon={<Zap className="h-3 w-3" />}
            title="When"
            subtitle="all conditions must match"
            right={
              <ModeSelect
                value={draft.triggerMode}
                onChange={(m) => set({ triggerMode: m })}
              />
            }
          >
            {draft.triggers.map((cond, i) => (
              <ConditionRow
                key={i}
                cond={cond}
                onChange={(c) =>
                  set({
                    triggers: draft.triggers.map((x, j) => (j === i ? c : x)),
                  })
                }
                onRemove={() =>
                  set({ triggers: draft.triggers.filter((_, j) => j !== i) })
                }
                removable={draft.triggers.length > 1}
              />
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={() =>
                set({
                  triggers: [
                    ...draft.triggers,
                    { sensor: "air_temp", operator: "<", value: 0 },
                  ],
                })
              }
            >
              <Plus className="h-3 w-3" /> Add condition
            </Button>
          </Zone>

          <Zone tone="success" icon={<Power className="h-3 w-3" />} title="Do">
            <div className="space-y-1.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  turn on
                </span>
                <DevicePicker
                  selected={draft.actions.turnOn}
                  onToggle={(key) =>
                    set({
                      actions: {
                        ...draft.actions,
                        turnOn: draft.actions.turnOn.includes(key)
                          ? draft.actions.turnOn.filter((k) => k !== key)
                          : [...draft.actions.turnOn, key],
                      },
                    })
                  }
                />
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  turn off
                </span>
                <DevicePicker
                  selected={draft.actions.turnOff}
                  onToggle={(key) =>
                    set({
                      actions: {
                        ...draft.actions,
                        turnOff: draft.actions.turnOff.includes(key)
                          ? draft.actions.turnOff.filter((k) => k !== key)
                          : [...draft.actions.turnOff, key],
                      },
                    })
                  }
                />
              </div>
            </div>
          </Zone>

          <Zone
            tone="info"
            icon={<Target className="h-3 w-3" />}
            title="Stop when"
            subtitle="target reached → release"
            right={
              <ModeSelect
                value={draft.cutoffMode}
                onChange={(m) => set({ cutoffMode: m })}
              />
            }
          >
            {draft.cutoffs.map((cond, i) => (
              <ConditionRow
                key={i}
                cond={cond}
                onChange={(c) =>
                  set({
                    cutoffs: draft.cutoffs.map((x, j) => (j === i ? c : x)),
                  })
                }
                onRemove={() =>
                  set({ cutoffs: draft.cutoffs.filter((_, j) => j !== i) })
                }
                removable={draft.cutoffs.length > 1}
              />
            ))}
            <Button
              variant="outline"
              size="sm"
              className="h-7 gap-1 text-[11px]"
              onClick={() =>
                set({
                  cutoffs: [
                    ...draft.cutoffs,
                    { sensor: "air_temp", operator: ">=", value: 0 },
                  ],
                })
              }
            >
              <Plus className="h-3 w-3" /> Add condition
            </Button>
            <div className="flex flex-wrap items-center gap-1.5 pt-1">
              <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                release
              </span>
              <DevicePicker
                selected={draft.offActions.turnOff}
                onToggle={(key) =>
                  set({
                    offActions: {
                      turnOff: draft.offActions.turnOff.includes(key)
                        ? draft.offActions.turnOff.filter((k) => k !== key)
                        : [...draft.offActions.turnOff, key],
                    },
                  })
                }
              />
            </div>
          </Zone>

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-card-border/60 bg-card/40 px-2.5 py-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              timers
            </span>
            <TimerField
              icon={<Clock className="h-3.5 w-3.5" />}
              label="min on"
              valueMs={draft.minOnMs}
              onChange={(ms) => set({ minOnMs: ms })}
              hint="Minimum seconds the group stays ON before it may switch OFF"
            />
            <TimerField
              icon={<Hourglass className="h-3.5 w-3.5" />}
              label="min off"
              valueMs={draft.minOffMs}
              onChange={(ms) => set({ minOffMs: ms })}
              hint="Minimum seconds the group stays OFF before it may switch ON"
            />
            <TimerField
              icon={<Timer className="h-3.5 w-3.5" />}
              label="cooldown"
              valueMs={draft.cooldownMs}
              onChange={(ms) => set({ cooldownMs: ms })}
              hint="Wait between rule checks to avoid rapid switching"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-0.5">
            {!isNew && (
              <Button
                variant="ghost"
                size="sm"
                className="h-8 text-xs"
                onClick={() => setExpanded(false)}
              >
                Cancel
              </Button>
            )}
            <Button
              size="sm"
              className="h-8 gap-1 text-xs"
              disabled={saving || !dirty || draft.name.trim().length === 0}
              onClick={() => onSave(draft, isNew ? undefined : draft.id)}
            >
              <Save className="h-3.5 w-3.5" />{" "}
              {isNew ? "Create rule" : "Save changes"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── How-it-works help ──────────────────────────────────────────────────────

const HELP_STEPS = [
  {
    title: "IF — when to act",
    body: "Pick a sensor (Temp, Humidity, CO₂…), an operator and a value. ALL = every condition must be true, ANY = at least one.",
  },
  {
    title: "THEN — what to do",
    body: "When IF is true, the selected devices turn ON (or OFF) together — gang control. One tap adds multiple devices.",
  },
  {
    title: "STOP — target reached",
    body: "When a STOP condition is true (e.g. Temp ≥ 25°C), the Release devices switch OFF. The rule stays off until IF is true again.",
  },
  {
    title: "Hysteresis (anti-flicker)",
    body: "IF and STOP use different thresholds (e.g. ON below 30, OFF at 25). The gap between them is the deadband — the device never chatters around one value.",
  },
  {
    title: "Timers",
    body: "min ON / min OFF force a minimum hold time in each state. Cooldown pauses re-checks after a switch. All in seconds.",
  },
  {
    title: "Where it runs",
    body: "Rules are pushed to the ESP32 over MQTT and stored in its flash. The ESP evaluates them every 5 s — even when WiFi is down.",
  },
];

function HowItWorks() {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger asChild>
        <Button variant="outline" size="sm" className="h-7 gap-1 text-[11px]">
          <HelpCircle className="h-3.5 w-3.5" />
          {open ? "Hide help" : "How it works"}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent className="mt-3 space-y-2 rounded-lg border border-card-border bg-card/40 p-3">
        {HELP_STEPS.map((s, i) => (
          <div key={s.title} className="flex gap-2.5">
            <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-primary/15 font-mono text-[10px] font-bold text-primary">
              {i + 1}
            </span>
            <p className="text-[12px] leading-relaxed text-muted-foreground">
              <span className="font-semibold text-foreground">{s.title}.</span>{" "}
              {s.body}
            </p>
          </div>
        ))}
      </CollapsibleContent>
    </Collapsible>
  );
}

// ─── Main panel ──────────────────────────────────────────────────────────────

export function RuleBuilder() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [newDrafts, setNewDrafts] = useState<RuleDraft[]>([]);

  const {
    data: rules,
    isLoading,
    refetch,
  } = useQuery({
    queryKey: ["rules"],
    queryFn: getRuleList,
    refetchInterval: 30_000,
  });

  const create = useMutation({
    mutationFn: (input: RuleDraft) => {
      const { id: _id, ...rest } = input;
      return createRule(rest);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["emergency-thresholds"] });
      toast({
        title: "Rule created",
        description: "Published to ESP32 via MQTT (retained).",
      });
    },
    onError: (err) => {
      toast({
        title: "Create failed",
        description: err instanceof Error ? err.message : "Invalid rule.",
        variant: "destructive",
      });
    },
  });
  const update = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: Partial<RuleDraft> }) => {
      const { id: _id, ...rest } = patch;
      return updateRule(id, rest);
    },
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["emergency-thresholds"] });
      toast({
        title: "Rule saved",
        description: "Stored and re-published to the device.",
      });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Invalid rule.",
        variant: "destructive",
      });
    },
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteRule(id),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["emergency-thresholds"] });
      toast({ title: "Rule deleted" });
    },
    onError: (err) => {
      toast({
        title: "Delete failed",
        description: err instanceof Error ? err.message : "Could not delete.",
        variant: "destructive",
      });
    },
  });

  // One-click starter rules (skips the blank-card confusion).
  const loadExamples = useMutation({
    mutationFn: () => Promise.all(EXAMPLE_RULES.map((r) => createRule(r))),
    onSuccess: () => {
      refetch();
      queryClient.invalidateQueries({ queryKey: ["emergency-thresholds"] });
      toast({
        title: "Example rules loaded",
        description: "3 starter rules created — edit them to match your setup.",
      });
    },
    onError: (err) => {
      toast({
        variant: "destructive",
        title: "Examples failed",
        description:
          err instanceof Error ? err.message : "Could not create examples.",
      });
    },
  });

  function handleSave(draft: RuleDraft, id?: string) {
    if (id) {
      update.mutate({ id, patch: draft });
    } else {
      create.mutate(draft);
      setNewDrafts((prev) => prev.filter((d) => d !== draft));
    }
  }

  function addNewRule() {
    setNewDrafts((prev) => [...prev, emptyRuleDraft()]);
  }

  const isSaving =
    create.isPending || update.isPending || loadExamples.isPending;

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <FlaskConical className="h-4 w-4 text-primary" />
          Automation Rules
          <span className="ml-auto flex items-center gap-2">
            <HowItWorks />
          </span>
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          IF / THEN / STOP logic, executed on the ESP itself — works even
          without internet
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {isLoading ? (
          <p className="py-4 text-center font-mono text-sm text-muted-foreground">
            Loading rules…
          </p>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-mono text-[11px] uppercase tracking-widest text-muted-foreground">
                {rules?.length ?? 0} rule{(rules?.length ?? 0) === 1 ? "" : "s"}{" "}
                active
              </span>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 gap-1 text-[11px]"
                  disabled={loadExamples.isPending || (rules?.length ?? 0) > 0}
                  onClick={() => loadExamples.mutate()}
                  title="Adds 3 ready-made starter rules"
                >
                  <Sparkles className="h-3.5 w-3.5" />
                  {loadExamples.isPending ? "Loading…" : "Load examples"}
                </Button>
                <Button
                  size="sm"
                  className="h-7 gap-1 text-[11px]"
                  onClick={addNewRule}
                >
                  <Plus className="h-3.5 w-3.5" /> New rule
                </Button>
              </div>
            </div>

            {(rules ?? []).map((rule, i) => (
              <RuleCard
                key={rule.id}
                initial={rule}
                isNew={false}
                saving={isSaving}
                onSave={handleSave}
                onDelete={(id) => remove.mutate(id)}
                index={i}
              />
            ))}

            {newDrafts.map((draft, i) => (
              <RuleCard
                key={`new-${i}`}
                initial={draft}
                isNew
                saving={isSaving}
                onSave={handleSave}
                index={i}
              />
            ))}

            {newDrafts.length === 0 && (rules?.length ?? 0) === 0 && (
              <div className="rounded-lg border border-dashed border-card-border p-6 text-center">
                <BookOpen className="mx-auto h-6 w-6 text-muted-foreground" />
                <p className="mt-2 font-mono text-sm text-muted-foreground">
                  No automation rules yet.
                </p>
                <p className="mx-auto mt-1 max-w-md font-mono text-[11px] leading-relaxed text-muted-foreground/70">
                  Press <span className="text-primary">Load examples</span> to
                  get 3 working rules (cooling, misting, CO₂ fan) and edit them
                  — or press New rule to build your own IF / THEN / STOP logic
                  from scratch.
                </p>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
