import { History } from "lucide-react";

export function SectionHeading({
  icon,
  title,
  description,
  right,
}: {
  icon: React.ReactNode;
  title: string;
  description?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg bg-primary/10 text-primary">
          {icon}
        </span>
        <div>
          <h2 className="text-base font-bold tracking-tight">{title}</h2>
          {description && (
            <p className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              {description}
            </p>
          )}
        </div>
      </div>
      {right && <div className="ml-auto">{right}</div>}
    </div>
  );
}