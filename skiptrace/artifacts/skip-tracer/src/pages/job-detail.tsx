import { useState } from "react";
import { useRoute, Link } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft, Download, XCircle, CheckCircle2, Phone, AlertTriangle, Clock, RefreshCw, X } from "lucide-react";
import { useGetJob, getGetJobQueryKey, useCancelJob } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useToast } from "@/hooks/use-toast";

export default function JobDetail() {
  const [, params] = useRoute("/jobs/:jobId");
  const jobId = params?.jobId || "";
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: job, isLoading } = useGetJob(jobId, {
    query: {
      enabled: !!jobId,
      queryKey: getGetJobQueryKey(jobId),
      refetchInterval: (query) => {
        const d = query.state.data;
        if (!d || d.status === 'completed' || d.status === 'failed' || d.status === 'cancelled') {
          return false;
        }
        return 2000;
      }
    }
  });

  const cancelJob = useCancelJob();
  const [isDownloading, setIsDownloading] = useState(false);

  const handleCancel = () => {
    cancelJob.mutate({ jobId }, {
      onSuccess: () => {
        toast({ title: "Job Cancelled" });
        queryClient.invalidateQueries({ queryKey: getGetJobQueryKey(jobId) });
      },
      onError: () => {
        toast({ title: "Failed to cancel job", variant: "destructive" });
      }
    });
  };

  const handleDownload = async () => {
    setIsDownloading(true);
    try {
      const response = await fetch(`/api/skip-trace/jobs/${jobId}/results`);
      if (!response.ok) throw new Error("Failed to fetch results");
      
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `skip-trace-${jobId}.csv`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      toast({ title: "Download failed", variant: "destructive" });
    } finally {
      setIsDownloading(false);
    }
  };

  if (isLoading && !job) {
    return (
      <Layout>
        <div className="flex items-center justify-center h-64">
          <RefreshCw className="w-8 h-8 animate-spin text-primary" />
        </div>
      </Layout>
    );
  }

  if (!job) {
    return (
      <Layout>
        <div className="text-center py-12">
          <AlertTriangle className="w-12 h-12 mx-auto text-destructive mb-4" />
          <h2 className="text-xl font-bold">Job Not Found</h2>
          <Button asChild variant="outline" className="mt-4">
            <Link href="/">Back to Dashboard</Link>
          </Button>
        </div>
      </Layout>
    );
  }

  const isRunning = job.status === 'running' || job.status === 'pending';
  const progress = job.totalRows > 0 ? (job.processedRows / job.totalRows) * 100 : 0;
  const hitRate = job.processedRows > 0 ? ((job.foundCount / job.processedRows) * 100).toFixed(1) : "0.0";

  return (
    <Layout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button asChild variant="ghost" size="icon" className="h-8 w-8">
              <Link href="/"><ArrowLeft className="w-4 h-4" /></Link>
            </Button>
            <div>
              <h1 className="text-2xl font-bold font-mono uppercase tracking-tight">{job.fileName}</h1>
              <p className="text-sm text-muted-foreground font-mono">JOB ID: {job.jobId}</p>
            </div>
          </div>
          
          <div className="flex items-center gap-3">
            {isRunning && (
              <Button variant="destructive" size="sm" onClick={handleCancel} disabled={cancelJob.isPending}>
                <X className="w-4 h-4 mr-2" /> CANCEL RUN
              </Button>
            )}
            {!isRunning && job.status !== 'failed' && (
              <Button size="sm" onClick={handleDownload} disabled={isDownloading} className="font-bold">
                <Download className="w-4 h-4 mr-2" /> {isDownloading ? "DOWNLOADING..." : "EXPORT CSV"}
              </Button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground font-mono mb-1">STATUS</div>
              <div className="text-2xl font-bold uppercase flex items-center gap-2">
                <StatusIcon status={job.status} />
                <span className={
                  job.status === 'completed' ? 'text-emerald-500' :
                  job.status === 'failed' ? 'text-destructive' :
                  job.status === 'running' ? 'text-primary animate-pulse' : ''
                }>{job.status}</span>
              </div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground font-mono mb-1">PROCESSED</div>
              <div className="text-2xl font-bold font-mono">{job.processedRows} <span className="text-sm text-muted-foreground">/ {job.totalRows}</span></div>
            </CardContent>
          </Card>
          <Card className="bg-card/50 border-primary/20">
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground font-mono mb-1 text-primary">PHONES FOUND</div>
              <div className="text-2xl font-bold font-mono text-primary">{job.foundCount}</div>
            </CardContent>
          </Card>
          <Card className="bg-card/50">
            <CardContent className="pt-6">
              <div className="text-sm text-muted-foreground font-mono mb-1">HIT RATE</div>
              <div className="text-2xl font-bold font-mono">{hitRate}%</div>
            </CardContent>
          </Card>
        </div>

        {isRunning && (
          <Card className="border-primary/50">
            <CardContent className="py-6">
              <div className="flex justify-between text-sm font-mono mb-2">
                <span>PROCESSING...</span>
                <span className="text-primary">{Math.round(progress)}%</span>
              </div>
              <Progress value={progress} className="h-2" />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>Result Feed</CardTitle>
            <CardDescription>Live incoming data from skip trace engine.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="rounded-md border border-border">
              <Table>
                <TableHeader className="bg-muted/50">
                  <TableRow>
                    <TableHead className="w-[50px]">#</TableHead>
                    <TableHead>NAME</TableHead>
                    <TableHead>ADDRESS</TableHead>
                    <TableHead>PHONES</TableHead>
                    <TableHead className="text-right">STATUS</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {job.results?.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center py-8 text-muted-foreground font-mono">
                        AWAITING DATA...
                      </TableCell>
                    </TableRow>
                  ) : (
                    job.results?.map((res, i) => (
                      <TableRow key={i} className="font-mono text-sm">
                        <TableCell className="text-muted-foreground">{res.rowIndex + 1}</TableCell>
                        <TableCell className="font-medium">{res.firstName} {res.lastName}</TableCell>
                        <TableCell className="truncate max-w-[200px]">{res.address}{res.city ? `, ${res.city}` : ''}{res.state ? ` ${res.state}` : ''}</TableCell>
                        <TableCell>
                          {res.phones?.length > 0 ? (
                            <div className="flex flex-col gap-1">
                              {res.phones.map((p, j) => (
                                <span key={j} className="flex items-center gap-1 text-emerald-500">
                                  <Phone className="w-3 h-3" /> {p}
                                </span>
                              ))}
                            </div>
                          ) : (
                            <span className="text-muted-foreground">-</span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">
                          <ResultBadge status={res.status} error={res.error} />
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>
    </Layout>
  );
}

function StatusIcon({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <CheckCircle2 className="w-6 h-6 text-emerald-500"/>;
    case 'failed': return <XCircle className="w-6 h-6 text-destructive"/>;
    case 'running': return <RefreshCw className="w-6 h-6 text-primary animate-spin"/>;
    case 'pending': return <Clock className="w-6 h-6 text-muted-foreground"/>;
    case 'cancelled': return <XCircle className="w-6 h-6 text-muted-foreground"/>;
    default: return <Clock className="w-6 h-6"/>;
  }
}

function ResultBadge({ status, error }: { status: string, error?: string }) {
  switch (status) {
    case 'found': return <Badge className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20 hover:bg-emerald-500/20">FOUND</Badge>;
    case 'not_found': return <Badge variant="outline" className="text-muted-foreground border-border">NOT FOUND</Badge>;
    case 'error': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20" title={error}>ERROR</Badge>;
    case 'processing': return <Badge variant="outline" className="text-primary border-primary/20 animate-pulse">PROCESSING</Badge>;
    case 'pending': return <Badge variant="outline" className="text-muted-foreground border-border">PENDING</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
}
