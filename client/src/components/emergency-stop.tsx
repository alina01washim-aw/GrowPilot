import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { OctagonX, Play, AlertTriangle } from "lucide-react";
import {
  emergencyStopAll,
  resumeAutomation,
  getSystemStatus,
  describeResume,
  describeSyncReport,
  deviceLabel,
  getGetLatestReadingQueryKey,
  type ResumeResult,
} from "@/lib/api";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

const SYSTEM_STATUS_KEY = ["system", "status"] as const;

/**
 * `className` is how a caller opts into stretching (`h-full`). Do NOT bake
 * `h-full` in: when this panel is stacked with sibling cards, a percentage
 * height resolves against the stretched grid track and every sibling claims the
 * full track height, so the stack overflows and later sections paint on top of
 * it. Only pass `h-full` when the panel is the sole child of its grid cell.
 */
export function EmergencyStopPanel({ className }: { className?: string } = {}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [lastResume, setLastResume] = useState<ResumeResult | null>(null);

  const { data: status } = useQuery({
    queryKey: SYSTEM_STATUS_KEY,
    queryFn: getSystemStatus,
    refetchInterval: 5_000,
  });

  const stopMutation = useMutation({
    mutationFn: emergencyStopAll,
    onSuccess: (result) => {
      setOpen(false);
      setLastResume(null);
      queryClient.invalidateQueries({ queryKey: SYSTEM_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      toast({
        variant: "destructive",
        title: "EMERGENCY STOP",
        description: result.errors.length
          ? `Devices commanded OFF, but ${result.errors.length} state write(s) failed — check server logs.`
          : "All devices OFF. Automation paused — edge rules disabled.",
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Emergency stop failed",
        description: "Could not shut down devices. Check server connection.",
      });
    },
  });

  const resumeMutation = useMutation({
    mutationFn: resumeAutomation,
    onSuccess: (result) => {
      setLastResume(result);
      queryClient.invalidateQueries({ queryKey: SYSTEM_STATUS_KEY });
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      queryClient.invalidateQueries({ queryKey: getGetLatestReadingQueryKey() });
      toast({
        title: "Automation resumed",
        description: describeResume(result),
      });
    },
    onError: () => {
      toast({
        variant: "destructive",
        title: "Resume failed",
        description: "Could not resume automation.",
      });
    },
  });

  const paused = status?.automationPaused ?? false;
  const resumeSync = !paused ? lastResume?.sync : null;

  return (
    <Card
      className={cn(
        "card-lift flex flex-col overflow-hidden rounded-xl border-2 backdrop-blur-sm",
        paused
          ? "border-destructive/60 bg-destructive/5 shadow-lg shadow-destructive/10"
          : "border-card-border bg-card/70 shadow-lg shadow-black/[0.03]",
        className,
      )}
    >
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 font-mono text-sm uppercase tracking-widest">
          <OctagonX className="h-4 w-4 text-destructive" />
          Emergency Stop
          {paused && (
            <Badge variant="destructive" className="ml-auto rounded-md font-mono text-[10px]">
              PAUSED
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <p className="font-mono text-[11px] leading-relaxed text-muted-foreground">
          One tap turns every relay OFF and pauses all automation — including
          the rules running on the ESP itself.
        </p>

        {paused ? (
          <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
            <p className="font-mono text-[11px] text-destructive">
              Automation is stopped. Devices will not auto-start until resumed.
            </p>
          </div>
        ) : (
          <div className="flex items-start gap-2 rounded-lg border border-[hsl(var(--success)/0.3)] bg-[hsl(var(--success)/0.06)] p-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[hsl(var(--success))]" />
            <p className="font-mono text-[11px] text-[hsl(var(--success))]">
              Automation running — all relays under rule control.
            </p>
          </div>
        )}

        {resumeSync && (
          <div className="space-y-1 rounded-lg border border-border/60 bg-secondary/20 p-2">
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Last resume
            </p>
            <p className="font-mono text-[11px] leading-relaxed">
              {describeSyncReport(resumeSync)}
            </p>
            {lastResume?.stageReapplied && (
              <p className="font-mono text-[10px] text-muted-foreground">
                Crop stage re-applied: {lastResume.stageReapplied}
              </p>
            )}
            {resumeSync.rulesFired.length > 0 && (
              <p className="font-mono text-[10px] text-muted-foreground">
                Rules applied: {resumeSync.rulesFired.map((r) => r.name).join(", ")}
              </p>
            )}
            {resumeSync.skipped
              .filter((s) => s.reason === "manual-mode")
              .map((s) => (
                <p key={s.device} className="font-mono text-[10px] text-muted-foreground">
                  {deviceLabel(s.device)} left in manual — not restarted.
                </p>
              ))}
          </div>
        )}

        <div className="mt-auto space-y-2 pt-1">
          <AlertDialog open={open} onOpenChange={setOpen}>
            <AlertDialogTrigger asChild>
              <Button
                variant="destructive"
                className="h-10 w-full font-mono uppercase tracking-wider"
                disabled={stopMutation.isPending || paused}
              >
                <OctagonX className="mr-2 h-4 w-4" />
                {stopMutation.isPending ? "Stopping..." : "Emergency Stop All"}
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle className="font-mono">
                  Confirm Emergency Stop
                </AlertDialogTitle>
                <AlertDialogDescription>
                  This immediately turns OFF every device and pauses all
                  automation until you resume.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  onClick={() => stopMutation.mutate()}
                >
                  Stop All Devices
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>

          {paused && (
            <Button
              variant="outline"
              className="h-9 w-full font-mono uppercase tracking-wider"
              disabled={resumeMutation.isPending}
              onClick={() => resumeMutation.mutate()}
            >
              <Play className="mr-2 h-4 w-4" />
              {resumeMutation.isPending ? "Resuming..." : "Resume Automation"}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}