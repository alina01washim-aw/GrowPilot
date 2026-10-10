import { useState } from "react";
import { EmergencyBanner } from "@/components/emergency-banner";
import { EmergencyProvider, useEmergency } from "@/hooks/use-emergency-alert";
import { SidebarContent } from "./sidebar";
import { Header } from "./header";
import {
  Sheet,
  SheetContent,
  SheetTitle,
  SheetDescription,
} from "@/components/ui/sheet";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <EmergencyProvider>
      <ShellInner>{children}</ShellInner>
    </EmergencyProvider>
  );
}

function ShellInner({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const emergency = useEmergency();

  return (
    <div className="min-h-dvh bg-background text-foreground">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 border-r border-slate-200 bg-card/50 dark:border-slate-800 lg:block">
        <SidebarContent />
      </aside>

      {/* Mobile drawer */}
      <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
        <SheetContent side="left" className="w-64 p-0">
          <SheetTitle className="sr-only">Navigation</SheetTitle>
          <SheetDescription className="sr-only">
            Main navigation menu
          </SheetDescription>
          <SidebarContent onNavigate={() => setMobileOpen(false)} />
        </SheetContent>
      </Sheet>

      {/* Main column */}
      <div className="flex min-h-dvh flex-col lg:pl-60">
        <Header onMenu={() => setMobileOpen(true)} />

        {/* pb-24 keeps the last card clear of the floating assistant button */}
        <main className="mx-auto w-full max-w-7xl flex-1 space-y-6 px-4 pb-24 pt-6 sm:px-6 lg:px-8">
          <EmergencyBanner emergency={emergency} />
          {children}
        </main>

        <footer className="border-t border-slate-200 px-4 py-4 dark:border-slate-800">
          <div className="mx-auto flex max-w-7xl flex-col items-center justify-between gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground sm:flex-row">
            <span>Mushking IoT · ESP32 + MQTT</span>
            <span>Environment command center</span>
          </div>
        </footer>
      </div>
    </div>
  );
}