import { useLocation } from "wouter";
import { Menu, Bell, LogOut, Settings, User } from "lucide-react";
import { useHealthCheck, getHealthCheckQueryKey, useGetLatestReading } from "@/lib/api";
import { getSystemStatus, resumeAutomation, describeResume } from "@/lib/api/system";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { getStoredUsername } from "@/lib/auth-token";
import { useAuth } from "@/lib/auth-context";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useToast } from "@/hooks/use-toast";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard": "Dashboard",
  "/crop-cycle": "Crop Cycle",
  "/controllers": "My Controllers",
  "/analytics": "Analytics",
  "/device-history": "Device History",
  "/settings": "Settings",
};

function pageTitle(location: string): string {
  for (const [path, title] of Object.entries(PAGE_TITLES)) {
    if (location === path || location.startsWith(`${path}/`)) return title;
  }
  return "Mushking IoT";
}

export function Header({ onMenu }: { onMenu: () => void }) {
  const [location, navigate] = useLocation();
  const { logout } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: health, isError } = useHealthCheck({
    query: { queryKey: getHealthCheckQueryKey(), refetchInterval: 10_000 },
  });
  const { data: latest } = useGetLatestReading();
  const { data: status } = useQuery({
    queryKey: ["system", "status"],
    queryFn: getSystemStatus,
    refetchInterval: 5_000,
  });

  const resume = useMutation({
    mutationFn: resumeAutomation,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["system", "status"] });
      queryClient.invalidateQueries({ queryKey: ["device-controls"] });
      toast({
        title: "Automation resumed",
        description: describeResume(result),
      });
    },
  });

  const username = getStoredUsername() || "admin";
  const lastReadingMs = latest?.reading?.timestamp
    ? Date.now() - new Date(latest.reading.timestamp).getTime()
    : null;
  const stale = lastReadingMs !== null && lastReadingMs > 150_000;
  const hasAlerts = Boolean(status?.automationPaused) || stale;

  return (
    <header className="sticky top-0 z-30 border-b border-slate-200 bg-background/80 backdrop-blur-xl dark:border-slate-800">
      <div className="mx-auto flex h-14 max-w-7xl items-center gap-3 px-4 sm:px-6 lg:px-8">
        {/* Mobile menu */}
        <Button
          variant="ghost"
          size="icon"
          className="h-9 w-9 lg:hidden"
          onClick={onMenu}
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </Button>

        {/* Page title */}
        <div className="min-w-0">
          <h1 className="truncate text-sm font-bold tracking-tight sm:text-base">
            {pageTitle(location)}
          </h1>
          <p className="hidden font-mono text-[9px] uppercase tracking-[0.18em] text-muted-foreground sm:block">
            {isError
              ? "Backend offline"
              : health?.status === "ok"
                ? "All systems connected"
                : "Connecting to bridge…"}
          </p>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <ThemeToggle />

          {/* Notifications */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="icon" className="relative h-9 w-9" aria-label="Notifications">
                <Bell className="h-4.5 w-4.5" />
                {hasAlerts && (
                  <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-destructive" />
                )}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-72">
              <DropdownMenuLabel className="font-mono text-[10px] uppercase tracking-widest">
                Notifications
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {!hasAlerts ? (
                <div className="px-3 py-4 text-center font-mono text-[11px] text-muted-foreground">
                  All clear — no active alerts
                </div>
              ) : (
                <div className="space-y-1 p-1">
                  {status?.automationPaused && (
                    <div className="flex items-center justify-between gap-2 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2">
                      <div>
                        <p className="text-xs font-semibold text-destructive">Automation paused</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          Emergency stop is active
                        </p>
                      </div>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-[11px]"
                        disabled={resume.isPending}
                        onClick={() => resume.mutate()}
                      >
                        Resume
                      </Button>
                    </div>
                  )}
                  {stale && (
                    <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
                      <p className="text-xs font-semibold text-amber-600 dark:text-amber-400">
                        Sensor data stale
                      </p>
                      <p className="font-mono text-[10px] text-muted-foreground">
                        Last reading {Math.round((lastReadingMs ?? 0) / 60_000)}m ago
                      </p>
                    </div>
                  )}
                </div>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {/* Profile */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button className="flex items-center gap-2 rounded-full p-0.5 transition-opacity hover:opacity-80" aria-label="Profile menu">
                <Avatar className="h-8 w-8 border border-slate-200 dark:border-slate-800">
                  <AvatarFallback className="bg-gradient-to-br from-[hsl(var(--chart-1))] to-[hsl(var(--chart-6))] text-xs font-bold text-white">
                    {username.slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel>
                <p className="text-sm font-semibold">{username}</p>
                <p className="font-mono text-[10px] text-muted-foreground">Signed in</p>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => navigate("/settings")}>
                <User className="mr-2 h-4 w-4" /> Account settings
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => navigate("/settings")}>
                <Settings className="mr-2 h-4 w-4" /> Preferences
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                className="text-destructive focus:text-destructive"
                onSelect={() => logout()}
              >
                <LogOut className="mr-2 h-4 w-4" /> Sign out
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </header>
  );
}