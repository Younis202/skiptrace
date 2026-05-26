import { useState, useRef } from "react";
import { useLocation } from "wouter";
import { Layout } from "@/components/layout";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Upload, Play, FileText, AlertCircle, Clock, CheckCircle2, XCircle } from "lucide-react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { parseCSVPreview } from "@/lib/csv";
import { useQueryClient } from "@tanstack/react-query";

type ColumnMapping = {
  firstNameCol: string;
  lastNameCol: string;
  addressCol: string;
  cityCol: string;
  stateCol: string;
};

export default function Dashboard() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  
  const { data: jobsData, isLoading: jobsLoading } = useListJobs();
  const jobs = jobsData?.jobs || [];
  
  const [file, setFile] = useState<File | null>(null);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [csvPreview, setCsvPreview] = useState<string[][]>([]);
  const [mapping, setMapping] = useState<ColumnMapping>({
    firstNameCol: "",
    lastNameCol: "",
    addressCol: "",
    cityCol: "",
    stateCol: "",
  });
  
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (!selectedFile) return;
    
    setFile(selectedFile);
    
    const reader = new FileReader();
    reader.onload = (event) => {
      const text = event.target?.result as string;
      if (text) {
        const parsed = parseCSVPreview(text, 5);
        if (parsed.length > 0) {
          setCsvHeaders(parsed[0]);
          setCsvPreview(parsed.slice(1));
          
          // Auto-guess columns
          const headers = parsed[0].map(h => h.toLowerCase());
          setMapping({
            firstNameCol: parsed[0][headers.findIndex(h => h.includes('first'))] || "",
            lastNameCol: parsed[0][headers.findIndex(h => h.includes('last'))] || "",
            addressCol: parsed[0][headers.findIndex(h => h.includes('address') || h.includes('street'))] || "",
            cityCol: parsed[0][headers.findIndex(h => h.includes('city'))] || "",
            stateCol: parsed[0][headers.findIndex(h => h.includes('state'))] || "",
          });
        }
      }
    };
    reader.readAsText(selectedFile);
  };

  const handleStartJob = async () => {
    if (!file) return;
    
    if (!mapping.firstNameCol || !mapping.lastNameCol || !mapping.addressCol) {
      toast({
        title: "Missing mapping",
        description: "First Name, Last Name, and Address are required fields.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    
    try {
      const formData = new FormData();
      formData.append("file", file);
      
      const params = new URLSearchParams();
      if (mapping.firstNameCol) params.append("firstNameCol", mapping.firstNameCol);
      if (mapping.lastNameCol) params.append("lastNameCol", mapping.lastNameCol);
      if (mapping.addressCol) params.append("addressCol", mapping.addressCol);
      if (mapping.cityCol) params.append("cityCol", mapping.cityCol);
      if (mapping.stateCol) params.append("stateCol", mapping.stateCol);
      
      const response = await fetch(`/api/skip-trace/upload?${params.toString()}`, {
        method: "POST",
        body: formData,
      });
      
      if (!response.ok) {
        throw new Error("Failed to upload file");
      }
      
      const result = await response.json();
      
      toast({
        title: "Job started",
        description: "Skip trace job has been queued successfully.",
      });
      
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setLocation(`/jobs/${result.jobId}`);
      
    } catch (error) {
      toast({
        title: "Upload failed",
        description: "There was an error starting the job.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <Layout>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Upload className="w-5 h-5 text-primary" />
                New Skip Trace Job
              </CardTitle>
              <CardDescription>Upload a CSV to find homeowner contact info.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {!file ? (
                <div 
                  className="border-2 border-dashed border-border rounded-lg p-12 text-center hover:border-primary/50 transition-colors cursor-pointer"
                  onClick={() => fileInputRef.current?.click()}
                  data-testid="upload-area"
                >
                  <FileText className="w-12 h-12 text-muted-foreground mx-auto mb-4" />
                  <h3 className="text-lg font-medium">Drop CSV file here</h3>
                  <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
                  <Input 
                    type="file" 
                    accept=".csv" 
                    className="hidden" 
                    ref={fileInputRef}
                    onChange={handleFileChange}
                    data-testid="input-file"
                  />
                </div>
              ) : (
                <div className="space-y-6">
                  <div className="flex items-center justify-between p-4 bg-muted rounded-md border border-border">
                    <div className="flex items-center gap-3">
                      <FileText className="w-8 h-8 text-primary" />
                      <div>
                        <p className="font-medium">{file.name}</p>
                        <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(1)} KB • {csvPreview.length + 1} rows detected</p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setFile(null)}>Change File</Button>
                  </div>
                  
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label>First Name Column <span className="text-destructive">*</span></Label>
                      <Select value={mapping.firstNameCol} onValueChange={v => setMapping({...mapping, firstNameCol: v})}>
                        <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                        <SelectContent>
                          {csvHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Last Name Column <span className="text-destructive">*</span></Label>
                      <Select value={mapping.lastNameCol} onValueChange={v => setMapping({...mapping, lastNameCol: v})}>
                        <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                        <SelectContent>
                          {csvHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>Address Column <span className="text-destructive">*</span></Label>
                      <Select value={mapping.addressCol} onValueChange={v => setMapping({...mapping, addressCol: v})}>
                        <SelectTrigger><SelectValue placeholder="Select column" /></SelectTrigger>
                        <SelectContent>
                          {csvHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>City Column</Label>
                      <Select value={mapping.cityCol || "none"} onValueChange={v => setMapping({...mapping, cityCol: v === "none" ? "" : v})}>
                        <SelectTrigger><SelectValue placeholder="Select column (optional)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">-- None --</SelectItem>
                          {csvHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                    <div className="space-y-2">
                      <Label>State Column</Label>
                      <Select value={mapping.stateCol || "none"} onValueChange={v => setMapping({...mapping, stateCol: v === "none" ? "" : v})}>
                        <SelectTrigger><SelectValue placeholder="Select column (optional)" /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">-- None --</SelectItem>
                          {csvHeaders.map(h => <SelectItem key={h} value={h}>{h}</SelectItem>)}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="rounded-md border border-border overflow-hidden">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          {csvHeaders.slice(0, 5).map(h => (
                            <TableHead key={h} className="font-mono text-xs truncate max-w-[150px]">{h}</TableHead>
                          ))}
                          {csvHeaders.length > 5 && <TableHead className="w-[50px]">...</TableHead>}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {csvPreview.map((row, i) => (
                          <TableRow key={i}>
                            {row.slice(0, 5).map((cell, j) => (
                              <TableCell key={j} className="text-xs truncate max-w-[150px]">{cell}</TableCell>
                            ))}
                            {row.length > 5 && <TableCell className="text-xs text-muted-foreground">...</TableCell>}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                  
                  <Button 
                    className="w-full font-bold" 
                    size="lg" 
                    onClick={handleStartJob}
                    disabled={isUploading || !mapping.firstNameCol || !mapping.lastNameCol || !mapping.addressCol}
                    data-testid="button-start-job"
                  >
                    {isUploading ? "Starting..." : "START SKIP TRACE"}
                    {!isUploading && <Play className="w-4 h-4 ml-2" />}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <div className="space-y-8">
          <Card className="h-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Clock className="w-5 h-5 text-primary" />
                Recent Jobs
              </CardTitle>
            </CardHeader>
            <CardContent>
              {jobsLoading ? (
                <div className="space-y-4">
                  {[1, 2, 3].map(i => (
                    <div key={i} className="h-20 bg-muted animate-pulse rounded-md" />
                  ))}
                </div>
              ) : jobs.length === 0 ? (
                <div className="text-center text-muted-foreground py-8">
                  <AlertCircle className="w-8 h-8 mx-auto mb-2 opacity-50" />
                  <p>No recent jobs found.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {jobs.slice(0, 10).map(job => (
                    <div 
                      key={job.jobId} 
                      className="border border-border rounded-md p-4 hover:border-primary/50 transition-colors cursor-pointer bg-card/50 flex flex-col gap-3"
                      onClick={() => setLocation(`/jobs/${job.jobId}`)}
                      data-testid={`card-job-${job.jobId}`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="truncate pr-4">
                          <p className="font-medium text-sm truncate" title={job.fileName}>{job.fileName}</p>
                          <p className="text-xs text-muted-foreground font-mono mt-1">
                            {new Date(job.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <JobBadge status={job.status} />
                      </div>
                      
                      <div className="space-y-1">
                        <div className="flex justify-between text-xs font-mono">
                          <span>{job.processedRows} / {job.totalRows} PROCESSED</span>
                          <span className="text-primary">{job.foundCount} FOUND</span>
                        </div>
                        <Progress value={job.totalRows > 0 ? (job.processedRows / job.totalRows) * 100 : 0} className="h-1.5" />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </Layout>
  );
}

function JobBadge({ status }: { status: string }) {
  switch (status) {
    case 'completed': return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20"><CheckCircle2 className="w-3 h-3 mr-1"/> DONE</Badge>;
    case 'failed': return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20"><XCircle className="w-3 h-3 mr-1"/> FAILED</Badge>;
    case 'running': return <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse"><Play className="w-3 h-3 mr-1"/> RUNNING</Badge>;
    case 'pending': return <Badge variant="outline" className="text-muted-foreground"><Clock className="w-3 h-3 mr-1"/> PENDING</Badge>;
    case 'cancelled': return <Badge variant="outline" className="text-muted-foreground"><XCircle className="w-3 h-3 mr-1"/> CANCELLED</Badge>;
    default: return <Badge variant="outline">{status}</Badge>;
  }
}
