import { useState } from "react";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Trash2, ToggleLeft, ToggleRight, Zap, Plus, Upload, CheckCircle2, XCircle, AlertTriangle, Clock } from "lucide-react";
import {
  useListProxies,
  getListProxiesQueryKey,
  useAddProxy,
  useAddProxiesBulk,
  useDeleteProxy,
  useToggleProxy,
  useTestProxy,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function Settings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading } = useListProxies();
  const proxies = data?.proxies ?? [];

  const [singleUrl, setSingleUrl] = useState("");
  const [singleLabel, setSingleLabel] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [testingIds, setTestingIds] = useState<Set<string>>(new Set());

  const invalidate = () => queryClient.invalidateQueries({ queryKey: getListProxiesQueryKey() });

  const addProxy = useAddProxy({
    mutation: {
      onSuccess: () => {
        setSingleUrl("");
        setSingleLabel("");
        invalidate();
        toast({ title: "Proxy added" });
      },
      onError: () => toast({ title: "Failed to add proxy", variant: "destructive" }),
    },
  });

  const addBulk = useAddProxiesBulk({
    mutation: {
      onSuccess: (res) => {
        setBulkText("");
        invalidate();
        toast({ title: `Added ${res.added} proxies`, description: res.skipped > 0 ? `${res.skipped} skipped (invalid)` : undefined });
      },
      onError: () => toast({ title: "Failed to add proxies", variant: "destructive" }),
    },
  });

  const deleteProxy = useDeleteProxy({
    mutation: {
      onSuccess: () => { invalidate(); toast({ title: "Proxy removed" }); },
    },
  });

  const toggleProxy = useToggleProxy({
    mutation: { onSuccess: () => invalidate() },
  });

  const testProxy = useTestProxy({
    mutation: {
      onSuccess: (res, vars) => {
        setTestingIds(prev => { const s = new Set(prev); s.delete(vars.proxyId); return s; });
        invalidate();
        if (res.ok) {
          toast({ title: "Proxy online", description: `Latency: ${res.latencyMs}ms` });
        } else {
          toast({ title: "Proxy offline", description: res.error ?? "Connection failed", variant: "destructive" });
        }
      },
      onError: (_, vars) => {
        setTestingIds(prev => { const s = new Set(prev); s.delete(vars.proxyId); return s; });
        toast({ title: "Test failed", variant: "destructive" });
      },
    },
  });

  const handleTest = (proxyId: string) => {
    setTestingIds(prev => new Set(prev).add(proxyId));
    testProxy.mutate({ proxyId });
  };

  const activeCount = proxies.filter(p => p.isActive).length;

  return (
    <Layout>
      <div className="max-w-5xl mx-auto space-y-8">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Proxy Settings</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Configure proxy servers for skip tracing. Proxies rotate automatically per job to avoid rate limiting.
          </p>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold font-mono text-primary">{proxies.length}</p>
              <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Total Proxies</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold font-mono text-emerald-500">{activeCount}</p>
              <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Active</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="pt-6">
              <p className="text-3xl font-bold font-mono text-muted-foreground">{proxies.length - activeCount}</p>
              <p className="text-xs text-muted-foreground uppercase tracking-widest mt-1">Disabled</p>
            </CardContent>
          </Card>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Plus className="w-4 h-4 text-primary" /> Add Single Proxy
              </CardTitle>
              <CardDescription className="text-xs">Format: http://user:pass@host:port or socks5://host:port</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label>Proxy URL <span className="text-destructive">*</span></Label>
                <Input
                  data-testid="input-proxy-url"
                  placeholder="http://user:pass@1.2.3.4:8080"
                  value={singleUrl}
                  onChange={e => setSingleUrl(e.target.value)}
                />
              </div>
              <div className="space-y-2">
                <Label>Label (optional)</Label>
                <Input
                  data-testid="input-proxy-label"
                  placeholder="US Residential #1"
                  value={singleLabel}
                  onChange={e => setSingleLabel(e.target.value)}
                />
              </div>
              <Button
                data-testid="button-add-proxy"
                className="w-full"
                disabled={!singleUrl || addProxy.isPending}
                onClick={() => addProxy.mutate({ data: { url: singleUrl, label: singleLabel } })}
              >
                {addProxy.isPending ? "Adding..." : "Add Proxy"}
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Upload className="w-4 h-4 text-primary" /> Bulk Import
              </CardTitle>
              <CardDescription className="text-xs">Paste one proxy URL per line</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Textarea
                data-testid="textarea-bulk-proxies"
                placeholder={"http://user:pass@1.2.3.4:8080\nhttp://user:pass@5.6.7.8:3128\nsocks5://9.10.11.12:1080"}
                rows={6}
                value={bulkText}
                onChange={e => setBulkText(e.target.value)}
                className="font-mono text-xs"
              />
              <Button
                data-testid="button-bulk-import"
                className="w-full"
                disabled={!bulkText.trim() || addBulk.isPending}
                onClick={() => addBulk.mutate({ data: { lines: bulkText } })}
              >
                {addBulk.isPending ? "Importing..." : "Import Proxies"}
              </Button>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Proxy Pool</CardTitle>
            <CardDescription className="text-xs">
              Proxies rotate round-robin across jobs. After 5 consecutive failures, a proxy is auto-disabled.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {[1, 2, 3].map(i => <div key={i} className="h-16 bg-muted animate-pulse rounded-md" />)}
              </div>
            ) : proxies.length === 0 ? (
              <div className="text-center py-12 text-muted-foreground">
                <AlertTriangle className="w-8 h-8 mx-auto mb-2 opacity-40" />
                <p className="text-sm">No proxies configured.</p>
                <p className="text-xs mt-1">Skip tracing will use your server's IP address directly.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {proxies.map(proxy => (
                  <div
                    key={proxy.id}
                    data-testid={`row-proxy-${proxy.id}`}
                    className={`flex items-center gap-3 p-3 rounded-md border transition-colors ${proxy.isActive ? "border-border bg-card/50" : "border-border/40 bg-muted/20 opacity-60"}`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="font-mono text-xs truncate">{proxy.url}</p>
                        {proxy.label && <Badge variant="outline" className="text-xs shrink-0">{proxy.label}</Badge>}
                        {!proxy.isActive && <Badge variant="outline" className="text-xs shrink-0 text-muted-foreground">DISABLED</Badge>}
                      </div>
                      <div className="flex items-center gap-4 mt-1">
                        <span className="text-xs text-emerald-500 font-mono">{proxy.successCount} OK</span>
                        <span className="text-xs text-destructive font-mono">{proxy.failCount} FAIL</span>
                        {proxy.lastError && <span className="text-xs text-muted-foreground truncate max-w-[200px]" title={proxy.lastError}>{proxy.lastError}</span>}
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`button-test-${proxy.id}`}
                        disabled={testingIds.has(proxy.id)}
                        onClick={() => handleTest(proxy.id)}
                        className="h-7 px-2 text-xs"
                      >
                        {testingIds.has(proxy.id) ? <Clock className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
                        <span className="ml-1 hidden sm:inline">{testingIds.has(proxy.id) ? "Testing..." : "Test"}</span>
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`button-toggle-${proxy.id}`}
                        onClick={() => toggleProxy.mutate({ proxyId: proxy.id })}
                        className="h-7 px-2"
                      >
                        {proxy.isActive
                          ? <ToggleRight className="w-4 h-4 text-primary" />
                          : <ToggleLeft className="w-4 h-4 text-muted-foreground" />}
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        data-testid={`button-delete-${proxy.id}`}
                        onClick={() => deleteProxy.mutate({ proxyId: proxy.id })}
                        className="h-7 px-2 text-destructive hover:text-destructive"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}
