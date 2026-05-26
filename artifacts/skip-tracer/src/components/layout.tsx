import { ReactNode } from "react";
import { Link } from "wouter";
import { Radar } from "lucide-react";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen bg-background flex flex-col">
      <header className="border-b border-border/50 bg-card/50 backdrop-blur sticky top-0 z-50">
        <div className="container mx-auto px-4 h-14 flex items-center justify-between">
          <Link href="/" className="flex items-center gap-2 hover:opacity-80 transition-opacity">
            <Radar className="w-5 h-5 text-primary" />
            <span className="font-bold text-foreground tracking-tight">SKIP TRACER <span className="text-primary">PRO</span></span>
          </Link>
          
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
