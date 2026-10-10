import { useState, useEffect } from "react";
import {
  Wifi,
  User,
  Server,
  Save,
  RotateCcw,
  ChevronDown,
  Power,
  Trash2,
  Loader2,
} from "lucide-react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  getDeviceProfile,
  updateDeviceProfile,
  sendDeviceCommand,
  type DeviceProfile,
} from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const PROFILE_QUERY_KEY = ["device-profile"];

// Password fields in the form stay empty after load (the API never echoes
// secrets). An empty value means "keep the current one on the server" — the
// password is only submitted when the user types something new.
function Field({
  id,
  label,
  hint,
  type = "text",
  value,
  onChange,
  placeholder,
  className,
}: {
  id: string;
  label: string;
  hint?: string;
  type?: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label htmlFor={id} className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type={type}
        value={value}
        placeholder={placeholder}
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 sm:h-8 font-mono text-xs"
      />
      {hint && <p className="text-[10px] text-muted-foreground font-mono">{hint}</p>}
    </div>
  );
}

export function ProfileSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery<DeviceProfile>({
    queryKey: PROFILE_QUERY_KEY,
    queryFn: getDeviceProfile,
    refetchInterval: 30_000,
  });

  const [dirty, setDirty] = useState(false);
  const [advanced, setAdvanced] = useState(false);

  // Editable fields
  const [deviceName, setDeviceName] = useState("");
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");
  const [backupWifiSsid, setBackupWifiSsid] = useState("");
  const [backupWifiPassword, setBackupWifiPassword] = useState("");
  // Advanced (MQTT broker)
  const [mqttHost, setMqttHost] = useState("");
  const [mqttPort, setMqttPort] = useState("1883");
  const [mqttUsername, setMqttUsername] = useState("");
  const [mqttPassword, setMqttPassword] = useState("");

  useEffect(() => {
    if (!data) return;
    setDeviceName(data.deviceName);
    setWifiSsid(data.wifiSsid);
    setWifiPassword("");
    setBackupWifiSsid(data.backupWifiSsid);
    setBackupWifiPassword("");
    setMqttHost(data.mqttHost);
    setMqttPort(String(data.mqttPort));
    setMqttUsername(data.mqttUsername);
    setMqttPassword("");
    setDirty(false);
  }, [data]);

  function onChanged() {
    setDirty(true);
  }

  const mutation = useMutation({
    mutationFn: (input: Parameters<typeof updateDeviceProfile>[0]) =>
      updateDeviceProfile(input),
    onSuccess: () => {
      setDirty(false);
      queryClient.invalidateQueries({ queryKey: PROFILE_QUERY_KEY });
      toast({
        title: "Profile saved",
        description: "Device profile sent to ESP32 over MQTT. WiFi/MQTT changes apply on reconnect.",
      });
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "Could not save profile.";
      toast({ title: "Save failed", description: msg, variant: "destructive" });
    },
  });

  function save() {
    const port = Number(mqttPort);
    const input: Record<string, unknown> = {
      deviceName,
      wifiSsid,
      backupWifiSsid,
      mqttHost,
      mqttPort: Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined,
      mqttUsername,
    };
    // Only submit passwords that were actually typed (avoid overwriting secrets).
    if (wifiPassword.length > 0) input.wifiPassword = wifiPassword;
    if (backupWifiPassword.length > 0) input.backupWifiPassword = backupWifiPassword;
    if (mqttPassword.length > 0) input.mqttPassword = mqttPassword;

    // Strip undefined for clean JSON
    for (const k of Object.keys(input)) {
      if (input[k] === undefined) delete input[k];
    }
    mutation.mutate(input as Parameters<typeof updateDeviceProfile>[0]);
  }

  const rebootMutation = useMutation({
    mutationFn: () => sendDeviceCommand("REBOOT"),
    onSuccess: () =>
      toast({ title: "Reboot command sent", description: "ESP32 will restart in a moment." }),
    onError: (err) => {
      toast({
        title: "Failed to send reboot",
        description: err instanceof Error ? err.message : "MQTT unavailable?",
        variant: "destructive",
      });
    },
  });

  const resetWifiMutation = useMutation({
    mutationFn: () => sendDeviceCommand("WIFI_RESET"),
    onSuccess: () =>
      toast({
        title: "WiFi reset sent",
        description: "Stored credentials cleared — device will retry with firmware defaults.",
      }),
    onError: (err) => {
      toast({
        title: "Failed to send WiFi reset",
        description: err instanceof Error ? err.message : "MQTT unavailable?",
        variant: "destructive",
      });
    },
  });

  return (
    <Card className="card-lift overflow-hidden rounded-xl border-card-border bg-card/70 shadow-lg shadow-black/[0.03] backdrop-blur-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <User className="h-4 w-4 text-primary" />
          Device Profile
        </CardTitle>
        <p className="font-mono text-[11px] text-muted-foreground">
          Configure WiFi & broker remotely — no re-flash needed
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading ? (
          <p className="text-sm text-muted-foreground font-mono py-4 text-center">Loading…</p>
        ) : (
          <>
            <Field
              id="device-name"
              label="Device Name"
              value={deviceName}
              onChange={(v) => { setDeviceName(v); onChanged(); }}
              placeholder="Mushking IoT"
            />

            <Separator />

            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-primary" />
              <span className="font-mono text-xs font-semibold tracking-wide">Primary WiFi</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                id="wifi-ssid"
                label="SSID"
                value={wifiSsid}
                onChange={(v) => { setWifiSsid(v); onChanged(); }}
                placeholder="MyHomeWiFi"
              />
              <Field
                id="wifi-pass"
                label="Password"
                type="password"
                value={wifiPassword}
                onChange={(v) => { setWifiPassword(v); onChanged(); }}
                placeholder={data?.hasWifiPassword ? "•••••••• (current kept)" : "Leave blank to keep"}
              />
            </div>

            <div className="flex items-center gap-2">
              <Wifi className="h-4 w-4 text-muted-foreground" />
              <span className="font-mono text-xs font-semibold tracking-wide text-muted-foreground">
                Backup WiFi{" "}
                <span className="text-[9px] uppercase text-muted-foreground/70">(auto-failover · optional)</span>
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <Field
                id="backup-wifi-ssid"
                label="SSID"
                value={backupWifiSsid}
                onChange={(v) => { setBackupWifiSsid(v); onChanged(); }}
                placeholder="WorkWiFi"
              />
              <Field
                id="backup-wifi-pass"
                label="Password"
                type="password"
                value={backupWifiPassword}
                onChange={(v) => { setBackupWifiPassword(v); onChanged(); }}
                placeholder={data?.hasBackupWifiPassword ? "•••••••• (current kept)" : "Optional"}
              />
            </div>

            <Separator />

            <button
              type="button"
              onClick={() => setAdvanced((a) => !a)}
              className="flex w-full items-center gap-2 text-xs font-mono uppercase tracking-widest text-muted-foreground hover:text-foreground transition-colors"
            >
              <Server className="h-4 w-4 text-muted-foreground" />
              MQTT Broker
              <ChevronDown className={cn("h-4 w-4 ml-auto transition-transform", advanced && "rotate-180")} />
            </button>

            {advanced && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field
                  id="mqtt-host"
                  label="Host"
                  value={mqttHost}
                  onChange={(v) => { setMqttHost(v); onChanged(); }}
                  placeholder="broker.example.com"
                  className="sm:col-span-2"
                />
                <Field
                  id="mqtt-port"
                  label="Port"
                  type="number"
                  value={mqttPort}
                  onChange={(v) => { setMqttPort(v); onChanged(); }}
                  placeholder="1883"
                />
                <div className="space-y-1">
                  <Field
                    id="mqtt-user"
                    label="Username"
                    value={mqttUsername}
                    onChange={(v) => { setMqttUsername(v); onChanged(); }}
                    placeholder="Optional"
                  />
                </div>
                <Field
                  id="mqtt-pass"
                  label="Password"
                  type="password"
                  value={mqttPassword}
                  onChange={(v) => { setMqttPassword(v); onChanged(); }}
                  placeholder={data?.hasMqttPassword ? "•••••••• (current kept)" : "Optional"}
                  className="sm:col-span-2"
                />
                <p className="text-[10px] text-muted-foreground font-mono sm:col-span-2">
                  Empty host keeps the firmware default. Changing broker disconnects the ESP32 and
                  reconnects it to the new one.
                </p>
              </div>
            )}

            <div className="flex gap-2 pt-1">
              <Button
                className={cn("flex-1 font-mono text-xs uppercase tracking-wider h-8")}
                disabled={!dirty || mutation.isPending}
                onClick={save}
              >
                {mutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Save className="h-3.5 w-3.5 mr-1.5" />}
                {mutation.isPending ? "Saving…" : "Save Profile"}
              </Button>
              <Button
                variant="outline" size="icon" className="h-8 w-8"
                disabled={!dirty || mutation.isPending}
                onClick={() => { setDirty(false); if (data) { setDeviceName(data.deviceName); setWifiSsid(data.wifiSsid); setWifiPassword(""); setBackupWifiSsid(data.backupWifiSsid); setBackupWifiPassword(""); setMqttHost(data.mqttHost); setMqttPort(String(data.mqttPort)); setMqttUsername(data.mqttUsername); setMqttPassword(""); } }}
                title="Discard changes"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </Button>
            </div>

            <Separator />

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline" size="sm" className="h-8 font-mono text-[10px] uppercase tracking-wider"
                disabled={rebootMutation.isPending}
                onClick={() => rebootMutation.mutate()}
              >
                <Power className="h-3.5 w-3.5 mr-1.5" />
                Reboot ESP32
              </Button>
              <Button
                variant="outline" size="sm" className="h-8 font-mono text-[10px] uppercase tracking-wider text-destructive hover:text-destructive"
                disabled={resetWifiMutation.isPending}
                onClick={() => resetWifiMutation.mutate()}
              >
                {resetWifiMutation.isPending ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5 mr-1.5" />}
                Reset Stored WiFi
              </Button>
            </div>

            {data?.updatedAt && (
              <p className="text-[10px] text-muted-foreground font-mono pt-1 text-right">
                Last saved {new Date(data.updatedAt).toLocaleString()}
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}