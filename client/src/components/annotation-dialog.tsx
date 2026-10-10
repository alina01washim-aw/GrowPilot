import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2, ImagePlus, X, Loader2 } from "lucide-react";
import {
  createAnnotation,
  updateAnnotation,
  deleteAnnotation,
  uploadAnnotationImage,
  annotationImageUrl,
  annotationsKey,
  KNOWLEDGE_BASE_KEY,
  ANNOTATION_CATEGORIES,
  ANNOTATION_SEVERITIES,
  CATEGORY_LABELS,
  SEVERITY_LABELS,
  type BatchAnnotation,
  type AnnotationCategory,
  type AnnotationSeverity,
} from "@/lib/api";
import { downscaleImage } from "@/lib/image-downscale";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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

/**
 * Create / edit / delete one chart annotation.
 *
 * Severity is the field that matters most and is easiest to get wrong, so it is a
 * three-way segmented control rather than a dropdown: the risk engine only learns
 * from `warning` and `critical`, and an `info` note is invisible to it. The
 * helper text under the control says so, because a grower logging a real problem
 * as "info" would silently get no future warnings from it.
 */

const SEVERITY_STYLES: Record<AnnotationSeverity, string> = {
  info: "border-[hsl(var(--info)/0.5)] bg-[hsl(var(--info)/0.12)] text-[hsl(var(--info))]",
  warning:
    "border-[hsl(var(--warning)/0.5)] bg-[hsl(var(--warning)/0.12)] text-[hsl(var(--warning))]",
  critical: "border-destructive/50 bg-destructive/12 text-destructive",
};

const SEVERITY_HINT: Record<AnnotationSeverity, string> = {
  info: "Recorded for reference only — the risk engine will not learn from this.",
  warning: "The engine will warn you if a future batch drifts this way.",
  critical: "Strongest signal — future batches matching this get a prominent warning.",
};

export interface AnnotationDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  batchId: string;
  /** The moment being pinned. Ignored when editing — position is immutable. */
  at: Date | null;
  /** Existing note to edit, or null to create. */
  existing?: BatchAnnotation | null;
  /** Manual conditions, for a batch with no telemetry. */
  allowManualSnapshot?: boolean;
}

export function AnnotationDialog({
  open,
  onOpenChange,
  batchId,
  at,
  existing = null,
  allowManualSnapshot = false,
}: AnnotationDialogProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const [title, setTitle] = useState("");
  const [note, setNote] = useState("");
  const [category, setCategory] = useState<AnnotationCategory>("issue");
  const [severity, setSeverity] = useState<AnnotationSeverity>("info");
  const [imageIds, setImageIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [manual, setManual] = useState({ temp: "", hum: "", co2: "" });

  // Reset on every open so a previous edit never leaks into a new note.
  useEffect(() => {
    if (!open) return;
    setTitle(existing?.title ?? "");
    setNote(existing?.note ?? "");
    setCategory(existing?.category ?? "issue");
    setSeverity(existing?.severity ?? "info");
    setImageIds(existing?.imageIds ?? []);
    setManual({
      temp: existing?.snapshot?.temp != null ? String(existing.snapshot.temp) : "",
      hum: existing?.snapshot?.hum != null ? String(existing.snapshot.hum) : "",
      co2: existing?.snapshot?.co2 != null ? String(existing.snapshot.co2) : "",
    });
  }, [open, existing]);

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: annotationsKey(batchId) });
    queryClient.invalidateQueries({ queryKey: KNOWLEDGE_BASE_KEY });
  };

  const onError = (err: unknown) =>
    toast({
      variant: "destructive",
      title: "Could not save the note",
      description: err instanceof Error ? err.message : "Unknown error",
    });

  function manualSnapshot() {
    if (!allowManualSnapshot) return undefined;
    const num = (v: string) => {
      const parsed = Number(v);
      return v.trim() === "" || !Number.isFinite(parsed) ? null : parsed;
    };
    const snapshot = { temp: num(manual.temp), hum: num(manual.hum), co2: num(manual.co2) };
    // All blank means "no data" — send nothing rather than three explicit nulls,
    // so the server can fall back to reading telemetry.
    return snapshot.temp == null && snapshot.hum == null && snapshot.co2 == null
      ? undefined
      : snapshot;
  }

  const save = useMutation({
    mutationFn: async () => {
      if (existing) {
        return updateAnnotation(existing.id, {
          title,
          note,
          category,
          severity,
          imageIds,
          snapshot: manualSnapshot(),
        });
      }
      if (!at) throw new Error("No moment selected");
      return createAnnotation({
        batchId,
        at: at.toISOString(),
        title,
        note,
        category,
        severity,
        imageIds,
        snapshot: manualSnapshot(),
      });
    },
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast({ title: existing ? "Note updated" : "Note added" });
    },
    onError,
  });

  const remove = useMutation({
    mutationFn: () => deleteAnnotation(existing!.id),
    onSuccess: () => {
      invalidate();
      onOpenChange(false);
      toast({ title: "Note deleted" });
    },
    onError,
  });

  async function attach(file: File) {
    setUploading(true);
    try {
      const dataUrl = await downscaleImage(file);
      const { id } = await uploadAnnotationImage(batchId, dataUrl);
      setImageIds((prev) => [...prev, id]);
    } catch (err) {
      toast({
        variant: "destructive",
        title: "Could not attach the photo",
        description: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setUploading(false);
    }
  }

  const when = existing ? new Date(existing.at) : at;
  const busy = save.isPending || remove.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="font-mono">
            {existing ? "Edit note" : "Add note"}
          </DialogTitle>
          <DialogDescription>
            {when ? when.toLocaleString() : "No time selected"}
            {existing && existing.stageLabel
              ? ` · ${existing.stageLabel}, day ${existing.dayOfStage}`
              : ""}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">
              What happened
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Pins aborting on the north bed"
              className="h-9"
              maxLength={160}
            />
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Severity</Label>
            <div className="mt-1 flex gap-1.5">
              {ANNOTATION_SEVERITIES.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => setSeverity(s)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 font-mono text-[11px] uppercase tracking-wider transition-colors",
                    severity === s
                      ? SEVERITY_STYLES[s]
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {SEVERITY_LABELS[s]}
                </button>
              ))}
            </div>
            <p className="mt-1 font-mono text-[10px] leading-relaxed text-muted-foreground">
              {SEVERITY_HINT[severity]}
            </p>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Tag</Label>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {ANNOTATION_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    "rounded-md border px-2 py-1 font-mono text-[10px] transition-colors",
                    category === c
                      ? "border-primary/50 bg-primary/12 text-primary"
                      : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {CATEGORY_LABELS[c]}
                </button>
              ))}
            </div>
          </div>

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Details</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="What you saw, what you did about it…"
              className="min-h-[80px] text-xs"
              maxLength={4000}
            />
          </div>

          {allowManualSnapshot && (
            <div className="rounded-lg border border-border/60 bg-secondary/10 p-3">
              <Label className="font-mono text-[10px] uppercase tracking-wider">
                Conditions at the time
              </Label>
              <p className="mb-2 mt-0.5 font-mono text-[10px] leading-relaxed text-muted-foreground">
                This batch has no stored sensor data, so enter roughly what the room
                was doing. The engine needs these numbers to recognise the pattern
                again.
              </p>
              <div className="grid grid-cols-3 gap-2">
                {(
                  [
                    ["temp", "Temp °C"],
                    ["hum", "Humidity %"],
                    ["co2", "CO₂ ppm"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <Label className="font-mono text-[9px] uppercase text-muted-foreground">
                      {label}
                    </Label>
                    <Input
                      type="number"
                      value={manual[key]}
                      onChange={(e) => setManual((p) => ({ ...p, [key]: e.target.value }))}
                      className="h-8 font-mono text-xs"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          <div>
            <Label className="font-mono text-[10px] uppercase tracking-wider">Photos</Label>
            <div className="mt-1 flex flex-wrap items-center gap-2">
              {imageIds.map((id) => (
                <div key={id} className="relative">
                  <img
                    src={annotationImageUrl(id)}
                    alt="Attached"
                    className="h-16 w-16 rounded-md border border-border/60 object-cover"
                  />
                  <button
                    type="button"
                    onClick={() => setImageIds((prev) => prev.filter((x) => x !== id))}
                    className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-border bg-card text-muted-foreground hover:text-destructive"
                    aria-label="Remove photo"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {imageIds.length < 6 && (
                <label
                  className={cn(
                    "grid h-16 w-16 cursor-pointer place-items-center rounded-md border border-dashed border-border/70 text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground",
                    uploading && "pointer-events-none opacity-60",
                  )}
                >
                  {uploading ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <ImagePlus className="h-4 w-4" />
                  )}
                  <input
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file) void attach(file);
                      e.target.value = "";
                    }}
                  />
                </label>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="gap-2 sm:justify-between">
          {existing ? (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  className="text-muted-foreground hover:text-destructive"
                  disabled={busy}
                >
                  <Trash2 className="mr-1.5 h-3.5 w-3.5" />
                  Delete
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle className="font-mono">Delete this note?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Attached photos go with it. Any past warning that was raised from
                    this note keeps its own copy of the reasoning, so the alert history
                    stays intact.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => remove.mutate()}>Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          ) : (
            <span />
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              onClick={() => save.mutate()}
              disabled={busy || !title.trim() || (!existing && !at)}
            >
              {save.isPending ? "Saving…" : existing ? "Save changes" : "Add note"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
