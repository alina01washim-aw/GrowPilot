import { useState, type FormEvent } from "react";
import { Lock, Activity, ShieldCheck } from "lucide-react";
import { ApiError, useLogin } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";
import { getStoredUsername } from "@/lib/auth-token";
import { ThemeToggle } from "@/components/theme-toggle";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";

export default function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState(() => getStoredUsername());
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const loginMutation = useLogin({
    mutation: {
      onSuccess: (data) => {
        login(data.token, username);
      },
      onError: (err) => {
        if (err instanceof ApiError && err.status === 401) {
          setError("Invalid username or password.");
        } else {
          setError("Could not reach the server. Please try again.");
        }
      },
    },
  });

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    loginMutation.mutate({ data: { username, password } });
  }

  return (
    <div className="relative flex min-h-dvh items-center justify-center bg-background p-4 font-sans text-foreground sm:p-6">
      <div className="absolute right-3 top-3 sm:right-4 sm:top-4">
        <ThemeToggle />
      </div>

      <div className="relative z-[1] w-full max-w-md animate-rise-in">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[hsl(var(--chart-1))] to-[hsl(var(--chart-6))] shadow-lg shadow-[hsl(var(--chart-1)/0.35)]">
            <Activity className="h-7 w-7 text-white" />
          </div>
          <div>
            <h1 className="font-mono text-xl font-bold tracking-tight">Mushking IoT</h1>
            <p className="mt-1 text-[11px] font-mono uppercase tracking-[0.2em] text-muted-foreground">
              Mushroom Farm · Command Center
            </p>
          </div>
        </div>

        <Card className="overflow-hidden rounded-2xl border-card-border bg-card/80 shadow-2xl shadow-black/10 backdrop-blur-md">
          <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-[hsl(var(--chart-1))] via-[hsl(var(--chart-2))] to-[hsl(var(--chart-6))]" />
          <CardHeader className="space-y-2 text-center">
            <div className="flex items-center justify-center gap-2">
              <Lock className="h-5 w-5 text-primary" />
              <CardTitle className="font-mono tracking-tight">Restricted Access</CardTitle>
            </div>
            <CardDescription className="flex items-center justify-center gap-1.5 font-mono text-[11px] uppercase tracking-wider">
              <ShieldCheck className="h-3.5 w-3.5" />
              Session stays signed in for 30 days
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="username">Username</Label>
                <Input
                  id="username"
                  autoComplete="username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
              </div>
              {error ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm font-mono text-destructive" role="alert">
                  {error}
                </p>
              ) : null}
              <Button
                type="submit"
                className="h-10 w-full font-mono uppercase tracking-wider"
                disabled={loginMutation.isPending}
              >
                {loginMutation.isPending ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>

        <p className="mt-5 text-center font-mono text-[10px] uppercase tracking-widest text-muted-foreground/70">
          ESP32 · MQTT · SHT40 / SCD40 / DS18B20
        </p>
      </div>
    </div>
  );
}