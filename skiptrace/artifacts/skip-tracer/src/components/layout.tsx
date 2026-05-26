import { ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { Radar, Settings, LayoutDashboard } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  const [location] = useLocation();

  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <Radar className="w-5 h-5 text-primary" />
            <span className="font-bold text-foreground tracking-tight">SKIP TRACER <span className="text-primary">PRO</span></span>
          </Link>

          <nav className="flex items-center gap-1">
            <Link
              href="/"
              data-testid="link-dashboard"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors ${location === "/" ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
            >
              <LayoutDashboard className="w-3.5 h-3.5" />
              DASHBOARD
            </Link>
            <Link
              href="/settings"
              data-testid="link-settings"
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded text-xs font-mono transition-colors ${location === "/settings" ? "text-primary bg-primary/10" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"}`}
            >
              <Settings className="w-3.5 h-3.5" />
              PROXIES
            </Link>
          </nav>

          <div className="flex items-center gap-4 text-xs font-mono text-muted-foreground">
            <span>SYSTEM: <span className="text-primary">ONLINE</span></span>
          </div>
        </div>
      </header>

      <main className="flex-1 container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
