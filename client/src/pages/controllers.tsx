import { Cpu } from "lucide-react";
import { DeviceControls } from "@/components/device-controls";
import { EmergencyStopPanel } from "@/components/emergency-stop";
import { RuleBuilder } from "@/components/rule-builder";
import { SectionHeading } from "@/components/layout/section-heading";

export default function ControllersPage() {
  return (
    <div className="space-y-6">
      <SectionHeading
        icon={<Cpu className="h-4 w-4" />}
        title="My Controllers"
        description="Manage devices, AUTO/MANUAL mode, and the rules that drive them"
      />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-5">
        <div className="lg:col-span-3">
          <DeviceControls />
        </div>
        <div className="lg:col-span-2">
          <EmergencyStopPanel className="h-full" />
        </div>
      </div>

      <div className="pt-2">
        <RuleBuilder />
      </div>
    </div>
  );
}