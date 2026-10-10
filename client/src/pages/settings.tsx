import { useState, useEffect } from "react";
import {
  User,
  Cpu,
  Server,
  KeyRound,
  Copy,
  LogOut,
  Power,
  Trash2,
  Loader2,
  Check,
  Bot,
  Save,
  AudioLines,
  Activity,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Settings } from "lucide-react";
import { ProfileSettings } from "@/components/profile-settings";
import { ThemeToggle } from "@/components/theme-toggle";
import { SectionHeading } from "@/components/layout/section-heading";
import { useAuth } from "@/lib/auth-context";
import { getStoredUsername, getStoredToken } from "@/lib/auth-token";
import { getSystemStatus, resumeAutomation, describeResume } from "@/lib/api/system";
import {
  getDeviceProfile,
  sendDeviceCommand,
  useHealthCheck,
  getHealthCheckQueryKey,
  getAiConfig,
  updateAiConfig,
  type AiConfig,
  type AiProviderId,
  AI_PROVIDER_OPTIONS,
  getVoiceConfig,
  updateVoiceConfig,
  type VoiceConfig,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";
import {
  getVpdTargets,
  updateVpdTargets,
  type VpdTargets,
  type VpdTargetsInput,
} from "@/lib/api/vpd";
import { VPD_ZONE_COLORS, VPD_ZONE_LABELS } from "@/components/vpd-gauge";

function tokenExpiry(token: string): string | null {
  try {
    const payload = JSON.parse(
      atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")),
    ) as { exp?: number };
    if (typeof payload.exp === "number") {
      return new Date(payload.exp * 1000).toLocaleString();
    }
  } catch {
    /* ignore */
  }
  return null;
}

function AccountTab() {
  const { logout } = useAuth();
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  const username = getStoredUsername() || "admin";
  const token = getStoredToken();

  function copyToken() {
    if (!token) return;
    navigator.clipboard
      .writeText(token)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      })
      .catch(() => toast({ title: "Copy failed", variant: "destructive" }));
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <User className="h-4 w-4 text-primary" /> Account
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Signed in as
            </p>
            <p className="mt-0.5 text-sm font-semibold">{username}</p>
            {token && tokenExpiry(token) && (
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                Session expires {tokenExpiry(token)}
              </p>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 p-3 dark:border-slate-800">
            <div>
              <p className="text-sm font-medium">Theme</p>
              <p className="font-mono text-[10px] text-muted-foreground">Light / dark mode</p>
            </div>
            <ThemeToggle />
          </div>
          <Button
            variant="outline"
            className="h-9 w-full font-mono text-[11px] uppercase tracking-wider text-destructive hover:text-destructive"
            onClick={logout}
          >
            <LogOut className="mr-2 h-3.5 w-3.5" /> Sign out
          </Button>
        </CardContent>
      </Card>

      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <KeyRound className="h-4 w-4 text-primary" /> API Token
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            Your session token authenticates every API call (Bearer header). It is stored
            locally in your browser and expires after 30 days.
          </p>
          {token ? (
            <div className="flex items-center gap-2 rounded-lg border border-slate-200 p-2 dark:border-slate-800">
              <code className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
                {token.slice(0, 18)}…{token.slice(-6)}
              </code>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={copyToken}>
                {copied ? (
                  <Check className="h-3.5 w-3.5 text-[hsl(var(--success))]" />
                ) : (
                  <Copy className="h-3.5 w-3.5" />
                )}
              </Button>
            </div>
          ) : (
            <p className="font-mono text-[11px] text-muted-foreground">No session token.</p>
          )}
          <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
            Do not share this token. Logging out revokes it.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function SystemTab() {
  const { toast } = useToast();
  const { data: status } = useQuery({
    queryKey: ["system", "status"],
    queryFn: getSystemStatus,
    refetchInterval: 5_000,
  });
  const { data: profile } = useQuery({
    queryKey: ["device-profile"],
    queryFn: getDeviceProfile,
    refetchInterval: 30_000,
  });
  const { data: health, isError } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 10_000 },
  });

  const reboot = useMutation({
    mutationFn: () => sendDeviceCommand("REBOOT"),
    onSuccess: () => toast({ title: "Reboot sent", description: "ESP32 will restart." }),
    onError: (err) =>
      toast({
        title: "Reboot failed",
        description: err instanceof Error ? err.message : "MQTT unavailable?",
        variant: "destructive",
      }),
  });
  const resetWifi = useMutation({
    mutationFn: () => sendDeviceCommand("WIFI_RESET"),
    onSuccess: () =>
      toast({ title: "WiFi reset sent", description: "Stored credentials cleared." }),
    onError: (err) =>
      toast({
        title: "Reset failed",
        description: err instanceof Error ? err.message : "MQTT unavailable?",
        variant: "destructive",
      }),
  });
  const resume = useMutation({
    mutationFn: resumeAutomation,
    onSuccess: (result) =>
      toast({
        title: "Automation resumed",
        description: describeResume(result),
      }),
    onError: (err) =>
      toast({
        title: "Resume failed",
        description: err instanceof Error ? err.message : "Could not resume.",
        variant: "destructive",
      }),
  });

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <Server className="h-4 w-4 text-primary" /> Runtime Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Backend
            </span>
            {isError ? (
              <Badge variant="destructive" className="rounded-md font-mono text-[10px]">OFFLINE</Badge>
            ) : health?.status === "ok" ? (
              <Badge variant="outline" className="gap-1.5 rounded-md border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] font-mono text-[10px] text-[hsl(var(--success))]">
                <span className="dot-success h-1.5 w-1.5 rounded-full" /> ONLINE
              </Badge>
            ) : (
              <Badge variant="secondary" className="rounded-md font-mono text-[10px]">CONNECTING…</Badge>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Automation
            </span>
            {status?.automationPaused ? (
              <div className="flex items-center gap-2">
                <Badge variant="destructive" className="rounded-md font-mono text-[10px]">PAUSED</Badge>
                <Button size="sm" variant="outline" className="h-7 text-[11px]" disabled={resume.isPending} onClick={() => resume.mutate()}>
                  Resume
                </Button>
              </div>
            ) : (
              <Badge variant="outline" className="gap-1.5 rounded-md border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] font-mono text-[10px] text-[hsl(var(--success))]">
                <span className="dot-success h-1.5 w-1.5 rounded-full" /> RUNNING
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              MQTT Broker
            </span>
            <span className="font-mono text-[11px]">
              {profile?.mqttHost || "firmware default"}
              {profile?.mqttPort ? `:${profile.mqttPort}` : ""}
            </span>
          </div>
        </CardContent>
      </Card>

      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <Cpu className="h-4 w-4 text-primary" /> Device Commands
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            variant="outline"
            className="h-9 w-full font-mono text-[11px] uppercase tracking-wider"
            disabled={reboot.isPending}
            onClick={() => reboot.mutate()}
          >
            {reboot.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Power className="mr-2 h-3.5 w-3.5" />}
            Reboot ESP32
          </Button>
          <Button
            variant="outline"
            className="h-9 w-full font-mono text-[11px] uppercase tracking-wider text-destructive hover:text-destructive"
            disabled={resetWifi.isPending}
            onClick={() => resetWifi.mutate()}
          >
            {resetWifi.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Trash2 className="mr-2 h-3.5 w-3.5" />}
            Reset Stored WiFi
          </Button>
          <p className="pt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
            Commands are delivered over MQTT. WiFi reset clears saved credentials — the
            device falls back to firmware defaults.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

const API_ENDPOINTS = [
  { method: "GET", path: "/api/readings/latest", desc: "Latest sensor reading" },
  { method: "GET", path: "/api/readings?from=&to=&limit=", desc: "Reading history" },
  { method: "GET", path: "/api/readings/summary", desc: "Aggregated stats" },
  { method: "GET", path: "/api/rules", desc: "List automation rules" },
  { method: "POST", path: "/api/rules", desc: "Create an automation rule" },
  { method: "GET", path: "/api/devices/control", desc: "Device control views" },
  { method: "GET", path: "/api/vpd/status", desc: "Surface VPD + status zone" },
  { method: "PUT", path: "/api/vpd/targets", desc: "Update VPD target band" },
  { method: "POST", path: "/api/system/emergency-stop", desc: "Emergency stop" },
  { method: "GET", path: "/api/ai/health", desc: "AI assistant status" },
];

function ApiTab() {
  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
          <KeyRound className="h-4 w-4 text-primary" /> API Reference
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {API_ENDPOINTS.map((e) => (
          <div
            key={e.path}
            className="flex items-center gap-3 rounded-lg px-2 py-1.5 transition-colors hover:bg-muted/50"
          >
            <span
              className={cn(
                "w-14 shrink-0 rounded px-1.5 py-px text-center font-mono text-[9px] font-bold",
                e.method === "GET"
                  ? "bg-[hsl(var(--info)/0.15)] text-[hsl(var(--info))]"
                  : "bg-[hsl(var(--success)/0.15)] text-[hsl(var(--success))]",
              )}
            >
              {e.method}
            </span>
            <code className="min-w-0 flex-1 truncate font-mono text-[11px]">{e.path}</code>
            <span className="hidden font-mono text-[10px] text-muted-foreground sm:block">
              {e.desc}
            </span>
          </div>
        ))}
        <p className="pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground">
          All endpoints require a <code className="text-foreground">Authorization: Bearer &lt;token&gt;</code>{" "}
          header. The AI chat also streams over WebSocket at{" "}
          <code className="text-foreground">/api/ws/ai</code>.
        </p>
      </CardContent>
    </Card>
  );
}

const VPD_ZONE_DESCRIPTIONS: { code: string; desc: string }[] = [
  { code: "DARK_GREEN", desc: "Optimal — evaporation perfectly balanced" },
  { code: "LIGHT_GREEN", desc: "Acceptable — inside band, near the edge" },
  { code: "YELLOW", desc: "Mild — slightly too humid or too dry" },
  { code: "ORANGE", desc: "Moderate — condensation or drying risk rising" },
  { code: "RED", desc: "Critical — infection or desiccation risk" },
];

function EnvironmentTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<VpdTargets>({
    queryKey: ["vpd", "targets"],
    queryFn: getVpdTargets,
    staleTime: 30_000,
  });

  const [targetMin, setTargetMin] = useState("0.15");
  const [targetMax, setTargetMax] = useState("0.35");
  const [margin, setMargin] = useState("0.05");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setTargetMin(String(data.vpdTargetMin));
    setTargetMax(String(data.vpdTargetMax));
    setMargin(String(data.vpdWarningMargin));
    setDirty(false);
  }, [data]);

  const min = parseFloat(targetMin);
  const max = parseFloat(targetMax);
  const marginVal = parseFloat(margin);

  const error =
    !Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(marginVal)
      ? "Enter valid numbers"
      : min < 0 || min >= max
        ? "Target Min must be ≥ 0 and less than Target Max"
        : max > 2
          ? "Target Max must not exceed 2 kPa"
          : marginVal <= 0 || marginVal > 0.5
            ? "Warning margin must be between 0 and 0.5 kPa"
            : undefined;

  const save = useMutation({
    mutationFn: (input: VpdTargetsInput) => updateVpdTargets(input),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: ["vpd", "targets"] });
      queryClient.invalidateQueries({ queryKey: ["vpd", "status"] });
      toast({
        title: "VPD targets saved",
        description: "The dashboard gauge picks these up immediately.",
      });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Could not save VPD targets.",
        variant: "destructive",
      });
    },
  });

  function submit() {
    save.mutate({ vpdTargetMin: min, vpdTargetMax: max, vpdWarningMargin: marginVal });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <Activity className="h-4 w-4 text-primary" /> VPD Targets (Surface)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <p className="font-mono text-[10px] leading-relaxed text-muted-foreground">
                Ideal surface VPD band for the BP-style status gauge. Calculated as{" "}
                <code className="text-foreground">SVP(compost) − AVP(air)</code> in kPa.
              </p>
              <div className="space-y-1">
                <Label htmlFor="vpd-min" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Target Min (kPa)
                </Label>
                <Input
                  id="vpd-min"
                  value={targetMin}
                  onChange={(e) => { setTargetMin(e.target.value); setDirty(true); }}
                  placeholder="0.15"
                  inputMode="decimal"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vpd-max" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Target Max (kPa)
                </Label>
                <Input
                  id="vpd-max"
                  value={targetMax}
                  onChange={(e) => { setTargetMax(e.target.value); setDirty(true); }}
                  placeholder="0.35"
                  inputMode="decimal"
                  className="h-8 font-mono text-xs"
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="vpd-margin" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Warning Margin (kPa)
                </Label>
                <Input
                  id="vpd-margin"
                  value={margin}
                  onChange={(e) => { setMargin(e.target.value); setDirty(true); }}
                  placeholder="0.05"
                  inputMode="decimal"
                  className="h-8 font-mono text-xs"
                />
                <p className="font-mono text-[10px] text-muted-foreground/70">
                  Tolerance before a deviation escalates toward orange/red.
                </p>
              </div>
              {error && <p className="font-mono text-[10px] text-destructive">{error}</p>}
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button
                  size="sm"
                  onClick={submit}
                  disabled={!dirty || !!error || save.isPending}
                  className="h-8 font-mono text-xs"
                >
                  {save.isPending ? (
                    <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Save className="mr-1.5 h-3.5 w-3.5" />
                  )}
                  Save Targets
                </Button>
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            Status Zones
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {VPD_ZONE_DESCRIPTIONS.map((z) => (
            <div key={z.code} className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 hover:bg-muted/50">
              <span
                className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/20"
                style={{ backgroundColor: VPD_ZONE_COLORS[z.code] }}
              />
              <span className="w-24 shrink-0 font-mono text-[10px] font-bold tracking-wider">
                {VPD_ZONE_LABELS[z.code]}
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">{z.desc}</span>
            </div>
          ))}
          <p className="pt-2 font-mono text-[10px] leading-relaxed text-muted-foreground/70">
            Sensor inputs: SHT40 air temp + RH, DS18B20 compost temp. SCD40 contributes CO₂ only
            (its internal temp/RH are ignored to avoid self-heating offsets).
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function AiTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<AiConfig>({
    queryKey: ["ai", "config"],
    queryFn: getAiConfig,
    staleTime: 30_000,
  });

  const [provider, setProvider] = useState<AiProviderId>("custom");
  const [model, setModel] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setProvider(data.provider);
    setModel(data.model);
    setBaseUrl(data.baseUrl);
    setApiKey("");
    setDirty(false);
  }, [data]);

  function markDirty() {
    setDirty(true);
  }

  function pickProvider(id: AiProviderId) {
    setProvider(id);
    if (id !== "custom") {
      const preset = AI_PROVIDER_OPTIONS.find((p) => p.id === id);
      if (preset) {
        setBaseUrl(preset.baseUrl);
        setModel(preset.defaultModel);
      }
    }
    markDirty();
  }

  const save = useMutation({
    mutationFn: (input: { provider?: AiProviderId; model?: string; baseUrl?: string; apiKey?: string }) =>
      updateAiConfig(input),
    onSuccess: () => {
      setDirty(false);
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: ["ai", "config"] });
      queryClient.invalidateQueries({ queryKey: ["ai", "health"] });
      toast({ title: "AI settings saved", description: "The assistant picks this up immediately." });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Could not save AI settings.",
        variant: "destructive",
      });
    },
  });

  function submit() {
    const input: { provider?: AiProviderId; model?: string; baseUrl?: string; apiKey?: string } = {
      provider,
      model,
      baseUrl,
    };
    if (apiKey.length > 0) input.apiKey = apiKey;
    save.mutate(input);
  }

  function removeKey() {
    save.mutate({ apiKey: "" });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <Bot className="h-4 w-4 text-primary" /> AI Provider
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Provider
                </Label>
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
                  {[
                    { id: "openai" as const, label: "OpenAI" },
                    { id: "gemini" as const, label: "Gemini" },
                    { id: "opencode" as const, label: "OpenCode" },
                    { id: "custom" as const, label: "Custom" },
                  ].map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => pickProvider(p.id)}
                      className={cn(
                        "rounded-md border px-2 py-1.5 font-mono text-[11px] font-semibold uppercase tracking-wider transition-colors",
                        provider === p.id
                          ? "border-primary bg-primary/10 text-primary"
                          : "border-slate-200 text-muted-foreground hover:border-primary/40 hover:text-foreground dark:border-slate-800",
                      )}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                <p className="font-mono text-[10px] text-muted-foreground">
                  Presets fill the endpoint + model for you. "Custom" keeps whatever you type.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-model" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Model
                </Label>
                <Input
                  id="ai-model"
                  value={model}
                  onChange={(e) => { setModel(e.target.value); markDirty(); }}
                  placeholder="gpt-4o-mini"
                  list="ai-model-suggestions"
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
                <datalist id="ai-model-suggestions">
                  {AI_PROVIDER_OPTIONS.flatMap((p) => p.models).map((m) => (
                    <option key={m} value={m} />
                  ))}
                </datalist>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-base-url" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Base URL
                </Label>
                <Input
                  id="ai-base-url"
                  value={baseUrl}
                  onChange={(e) => { setBaseUrl(e.target.value); markDirty(); }}
                  placeholder="https://api.openai.com/v1"
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  Any OpenAI-compatible endpoint works (OpenAI, Gemini, OpenCode, Groq, Ollama…).
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="ai-key" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  API Key
                </Label>
                <Input
                  id="ai-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); markDirty(); }}
                  placeholder={
                    data?.hasKey ? "•••••••••• (current kept — type to replace)" : "sk-…"
                  }
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  Stored on the server only — never shown back or sent to the browser.
                </p>
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  className="flex-1 font-mono text-xs uppercase tracking-wider h-8"
                  disabled={!dirty || save.isPending}
                  onClick={submit}
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  {save.isPending ? "Saving…" : "Save AI Settings"}
                </Button>
                {data?.hasKey && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 font-mono text-[10px] uppercase tracking-wider text-destructive hover:text-destructive"
                    disabled={save.isPending}
                    onClick={removeKey}
                  >
                    Remove Key
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <KeyRound className="h-4 w-4 text-primary" /> Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Assistant
            </span>
            {data?.configured ? (
              <Badge variant="outline" className="gap-1.5 rounded-md border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] font-mono text-[10px] text-[hsl(var(--success))]">
                <span className="dot-success h-1.5 w-1.5 rounded-full" /> READY
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 rounded-md border-amber-500/35 bg-amber-500/10 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                <span className="dot-warning h-1.5 w-1.5 rounded-full" /> NOT CONFIGURED
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Provider
            </span>
            <Badge variant="outline" className="rounded-md font-mono text-[10px] uppercase tracking-wider">
              {data?.provider ?? "custom"}
            </Badge>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Model
            </span>
            <span className="font-mono text-[11px]">{data?.model ?? "—"}</span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Endpoint
            </span>
            <span className="max-w-[55%] truncate font-mono text-[11px]" title={data?.baseUrl}>
              {data?.baseUrl ?? "—"}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Last updated
            </span>
            <span className="font-mono text-[11px]">
              {data?.updatedAt ? new Date(data.updatedAt).toLocaleString() : "never (env defaults)"}
            </span>
          </div>
          <p className="pt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
            The assistant can read sensors, create/edit rules, switch device modes, and trigger
            emergency stop — with your confirmation. Config changes apply instantly, no restart.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

function VoiceTab() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery<VoiceConfig>({
    queryKey: ["voice", "config"],
    queryFn: getVoiceConfig,
    staleTime: 30_000,
  });

  const [apiKey, setApiKey] = useState("");
  const [voiceId, setVoiceId] = useState("");
  const [model, setModel] = useState("");
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    if (!data) return;
    setApiKey("");
    setVoiceId(data.voiceId);
    setModel(data.model);
    setDirty(false);
  }, [data]);

  function markDirty() {
    setDirty(true);
  }

  const save = useMutation({
    mutationFn: (input: { apiKey?: string; voiceId?: string; model?: string }) =>
      updateVoiceConfig(input),
    onSuccess: () => {
      setDirty(false);
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: ["voice", "config"] });
      queryClient.invalidateQueries({ queryKey: ["voice", "health"] });
      toast({ title: "Voice settings saved", description: "The assistant picks this up immediately." });
    },
    onError: (err) => {
      toast({
        title: "Save failed",
        description: err instanceof Error ? err.message : "Could not save voice settings.",
        variant: "destructive",
      });
    },
  });

  function submit() {
    const input: { apiKey?: string; voiceId?: string; model?: string } = { voiceId, model };
    if (apiKey.length > 0) input.apiKey = apiKey;
    save.mutate(input);
  }

  function removeKey() {
    save.mutate({ apiKey: "" });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <AudioLines className="h-4 w-4 text-primary" /> Voice (Cartesia)
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {isLoading ? (
            <p className="py-4 text-center font-mono text-xs text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="space-y-1">
                <Label htmlFor="voice-key" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Cartesia API Key
                </Label>
                <Input
                  id="voice-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => { setApiKey(e.target.value); markDirty(); }}
                  placeholder={data?.hasKey ? "•••••••••• (current kept — type to replace)" : "cart_live_…"}
                  className="h-8 font-mono text-xs"
                  autoComplete="off"
                  spellCheck={false}
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  From api.cartesia.ai — powers spoken replies (TTS). Never shown back.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="voice-id" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Voice ID
                </Label>
                <Input
                  id="voice-id"
                  value={voiceId}
                  onChange={(e) => { setVoiceId(e.target.value); markDirty(); }}
                  placeholder="694f9389-aac1-45b6-b726-9d9369183238"
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
                <p className="font-mono text-[10px] text-muted-foreground">
                  Leave empty for the default Sonic voice.
                </p>
              </div>
              <div className="space-y-1">
                <Label htmlFor="voice-model" className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Model
                </Label>
                <Input
                  id="voice-model"
                  value={model}
                  onChange={(e) => { setModel(e.target.value); markDirty(); }}
                  placeholder="sonic-2025-04-16"
                  className="h-8 font-mono text-xs"
                  spellCheck={false}
                />
              </div>

              <div className="flex gap-2 pt-1">
                <Button
                  className="flex-1 font-mono text-xs uppercase tracking-wider h-8"
                  disabled={!dirty || save.isPending}
                  onClick={submit}
                >
                  {save.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                  {save.isPending ? "Saving…" : "Save Voice Settings"}
                </Button>
                {data?.hasKey && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-8 font-mono text-[10px] uppercase tracking-wider text-destructive hover:text-destructive"
                    disabled={save.isPending}
                    onClick={removeKey}
                  >
                    Remove Key
                  </Button>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 font-mono text-xs uppercase tracking-widest">
            <KeyRound className="h-4 w-4 text-primary" /> Voice Status
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              TTS
            </span>
            {data?.configured ? (
              <Badge variant="outline" className="gap-1.5 rounded-md border-[hsl(var(--success)/0.35)] bg-[hsl(var(--success)/0.1)] font-mono text-[10px] text-[hsl(var(--success))]">
                <span className="dot-success h-1.5 w-1.5 rounded-full" /> READY
              </Badge>
            ) : (
              <Badge variant="outline" className="gap-1.5 rounded-md border-amber-500/35 bg-amber-500/10 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                <span className="dot-warning h-1.5 w-1.5 rounded-full" /> NOT CONFIGURED
              </Badge>
            )}
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Voice
            </span>
            <span className="max-w-[55%] truncate font-mono text-[11px]" title={data?.voiceId ?? ""}>
              {data?.voiceId ?? "—"}
            </span>
          </div>
          <div className="flex items-center justify-between rounded-lg border border-slate-200 px-3 py-2 dark:border-slate-800">
            <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Model
            </span>
            <span className="font-mono text-[11px]">{data?.model ?? "—"}</span>
          </div>
          <p className="pt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
            Voice input (mic) works in Chrome/Edge with no setup — your browser
            transcribes speech locally and sends it to the assistant. Spoken replies
            need a Cartesia key. Voice commands follow the same safety rules as typed ones.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}

export default function SettingsPage() {
  return (
    <div className="space-y-6">
      <SectionHeading
        icon={<Settings className="h-4 w-4" />}
        title="Settings"
        description="Account, device, system and API configuration"
      />

      <Tabs defaultValue="account">
        <TabsList className="h-9 flex-wrap">
          <TabsTrigger value="account" className="text-xs">Account</TabsTrigger>
          <TabsTrigger value="device" className="text-xs">Device</TabsTrigger>
          <TabsTrigger value="environment" className="text-xs">Environment</TabsTrigger>
          <TabsTrigger value="system" className="text-xs">System</TabsTrigger>
          <TabsTrigger value="ai" className="text-xs">AI</TabsTrigger>
          <TabsTrigger value="api" className="text-xs">API</TabsTrigger>
        </TabsList>
        <TabsContent value="account" className="pt-4">
          <AccountTab />
        </TabsContent>
        <TabsContent value="device" className="pt-4">
          <ProfileSettings />
        </TabsContent>
        <TabsContent value="environment" className="pt-4">
          <EnvironmentTab />
        </TabsContent>
        <TabsContent value="system" className="pt-4">
          <SystemTab />
        </TabsContent>
        <TabsContent value="ai" className="space-y-6 pt-4">
          <AiTab />
          <VoiceTab />
        </TabsContent>
        <TabsContent value="api" className="pt-4">
          <ApiTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}