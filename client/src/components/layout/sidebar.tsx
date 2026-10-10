import { Link, useLocation } from "wouter";
import {
  LayoutDashboard,
  Cpu,
  BarChart3,
  Settings,
  Activity,
  Clock,
  Sprout,
} from "lucide-react";
import { useHealthCheck, getHealthCheckQueryKey } from "@/lib/api";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/crop-cycle", label: "Crop Cycle", icon: Sprout },
  { href: "/controllers", label: "My Controllers", icon: Cpu },
  { href: "/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/device-history", label: "Device History", icon: Clock },
] as const;

const FOOTER_ITEMS = [
  { href: "/settings", label: "Settings", icon: Settings },
] as const;

export function SidebarContent({ onNavigate }: { onNavigate?: () => void }) {
  const [location] = useLocation();
  const { data: health, isError } = useHealthCheck({
    query: {
      queryKey: getHealthCheckQueryKey(),
      refetchInterval: 10_000,
    },
  });

  const isActive = (href: string) =>
    location === href || location.startsWith(`${href}/`);

  const itemClass = (active: boolean) =>
    cn(
      "group flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition-all",
      active
        ? "bg-primary/10 text-primary"
        : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
    );

  return (
    <div className="flex h-full flex-col">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 pb-5 pt-6">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-[hsl(var(--chart-1))] to-[hsl(var(--chart-6))] shadow-md shadow-[hsl(var(--chart-1)/0.3)]">
          <Activity className="h-5 w-5 text-white" />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm font-bold tracking-tight">Mushking IoT</p>
          <p className="font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground">
            Farm OS
          </p>
        </div>
      </div>

      {/* Navigation */}
      <nav className="flex-1 space-y-0.5 px-3">
        <p className="px-3 pb-1.5 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/60">
          Overview
        </p>
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={itemClass(active)}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  active ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground",
                )}
              />
              {label}
              {active && (
                <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />
              )}
            </Link>
          );
        })}

        <p className="px-3 pb-1.5 pt-4 font-mono text-[9px] uppercase tracking-[0.2em] text-muted-foreground/60">
          Manage
        </p>
        {FOOTER_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              onClick={onNavigate}
              className={itemClass(active)}
            >
              <Icon
                className={cn(
                  "h-4 w-4 shrink-0 transition-colors",
                  active ? "text-primary" : "text-muted-foreground/70 group-hover:text-foreground",
                )}
              />
              {label}
              {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
            </Link>
          );
        })}
      </nav>

      {/* System status */}
      <div className="m-3 rounded-xl border border-slate-200 bg-card/60 p-3 dark:border-slate-800">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "h-2 w-2 rounded-full",
              isError ? "dot-error" : health?.status === "ok" ? "dot-success" : "dot-warning",
            )}
          />
          <span className="text-xs font-semibold">
            {isError ? "Backend offline" : health?.status === "ok" ? "Systems nominal" : "Connecting…"}
          </span>
        </div>
        <p className="mt-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">
          ESP32 · MQTT bridge
        </p>
      </div>
    </div>
  );
}