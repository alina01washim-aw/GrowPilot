import { Card, CardContent } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="relative flex min-h-dvh w-full items-center justify-center bg-background p-4">
      <Card className="relative z-[1] w-full max-w-md animate-rise-in overflow-hidden rounded-2xl border-destructive/20 bg-card/80 backdrop-blur-md">
        <div className="absolute inset-x-0 top-0 h-[3px] bg-gradient-to-r from-destructive/0 via-destructive to-destructive/0" />
        <CardContent className="flex flex-col items-center pt-8 text-center">
          <AlertCircle className="mb-4 h-12 w-12 text-destructive" />
          <h1 className="mb-2 font-mono text-2xl font-bold">404 · Not Found</h1>
          <p className="mb-6 text-sm text-muted-foreground">
            The requested control panel route does not exist.
          </p>
          <Link
            href="/"
            className="rounded-md border border-primary/40 bg-primary/10 px-4 py-2 font-mono text-sm text-primary transition-colors hover:bg-primary/20"
          >
            Return to Command Center
          </Link>
        </CardContent>
      </Card>
    </div>
  );
}