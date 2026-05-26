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
import { Upload, Play, FileText, AlertCircle, Clock, CheckCircle2, XCircle, Users, SplitSquareHorizontal } from "lucide-react";
import { useListJobs, getListJobsQueryKey } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { parseCSVPreview } from "@/lib/csv";
import { useQueryClient } from "@tanstack/react-query";

type NameMode = "separate" | "fullname";

type ColumnMapping = {
  nameMode: NameMode;
  ownerNameCol: string;
  firstNameCol: string;
  lastNameCol: string;
  addressCol: string;
  cityCol: string;
  stateCol: string;
  defaultState: string;
  startRow: string;
  endRow: string;
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
    nameMode: "separate",
    ownerNameCol: "",
    firstNameCol: "",
    lastNameCol: "",
    addressCol: "",
    cityCol: "",
    stateCol: "",
    defaultState: "",
    startRow: "1",
    endRow: "",
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
      if (!text) return;

      const parsed = parseCSVPreview(text, 5);
      if (parsed.length === 0) return;

      const headers = parsed[0];
      const headersLower = headers.map((h) => h.toLowerCase());
      setCsvHeaders(headers);
      setCsvPreview(parsed.slice(1));

      // Detect column layout
      const hasFirstCol = headersLower.some((h) => h.includes("first"));
      const hasOwnerCol = headersLower.some((h) => h.includes("owner") || (h.includes("name") && !h.includes("first") && !h.includes("last")));
      const hasStateCol = headersLower.some((h) => h.includes("state"));

      const findCol = (matches: string[]) => {
        const idx = headersLower.findIndex((h) => matches.some((m) => h.includes(m)));
        return idx >= 0 ? headers[idx] : "";
      };

      const nameMode: NameMode = (!hasFirstCol && hasOwnerCol) ? "fullname" : "separate";
      const ownerNameCol = findCol(["owner", "name"]);
      const addressCol = findCol(["addr", "street", "address"]);
      const cityCol = findCol(["city"]);
      const stateCol = findCol(["state"]);

      setMapping({
        nameMode,
        ownerNameCol: nameMode === "fullname" ? ownerNameCol : "",
        firstNameCol: nameMode === "separate" ? findCol(["first"]) : "",
        lastNameCol: nameMode === "separate" ? findCol(["last"]) : "",
        addressCol,
        cityCol,
        stateCol,
        defaultState: !hasStateCol ? "TX" : "",
        startRow: "1",
        endRow: "",
      });
    };
    reader.readAsText(selectedFile);
  };

  const isValid = () => {
    if (!mapping.addressCol) return false;
    if (mapping.nameMode === "fullname" && !mapping.ownerNameCol) return false;
    if (mapping.nameMode === "separate" && !mapping.firstNameCol) return false;
    return true;
  };

  const handleStartJob = async () => {
    if (!file || !isValid()) return;

    setIsUploading(true);
    try {
      const formData = new FormData();
      formData.append("file", file);

      const params = new URLSearchParams();
      params.append("addressCol", mapping.addressCol);
      if (mapping.cityCol) params.append("cityCol", mapping.cityCol);
      if (mapping.stateCol) params.append("stateCol", mapping.stateCol);
      if (mapping.defaultState) params.append("defaultState", mapping.defaultState);

      if (mapping.nameMode === "fullname") {
        params.append("ownerNameCol", mapping.ownerNameCol);
      } else {
        if (mapping.firstNameCol) params.append("firstNameCol", mapping.firstNameCol);
        if (mapping.lastNameCol) params.append("lastNameCol", mapping.lastNameCol);
      }

      const start = parseInt(mapping.startRow || "1", 10);
      const end = parseInt(mapping.endRow || "0", 10);
      if (!isNaN(start) && start > 1) params.append("startRow", String(start));
      if (!isNaN(end) && end > 0) params.append("endRow", String(end));

      const response = await fetch(`/api/skip-trace/upload?${params.toString()}`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) throw new Error("Failed to upload");

      const result = await response.json();

      toast({ title: "Job started", description: "Skip trace job has been queued." });
      queryClient.invalidateQueries({ queryKey: getListJobsQueryKey() });
      setLocation(`/jobs/${result.jobId}`);
    } catch {
      toast({ title: "Upload failed", description: "There was an error starting the job.", variant: "destructive" });
    } finally {
      setIsUploading(false);
    }
  };

  const setMode = (mode: NameMode) => setMapping((m) => ({ ...m, nameMode: mode }));

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
                  {/* File info */}
                  <div className="flex items-center justify-between p-4 bg-muted rounded-md border border-border">
                    <div className="flex items-center gap-3">
                      <FileText className="w-8 h-8 text-primary" />
                      <div>
                        <p className="font-medium">{file.name}</p>
                        <p className="text-xs text-muted-foreground font-mono">
                          {(file.size / 1024).toFixed(1)} KB
                        </p>
                      </div>
                    </div>
                    <Button variant="outline" size="sm" onClick={() => setFile(null)}>
                      Change File
                    </Button>
                  </div>

                  {/* Name mode toggle */}
                  <div className="space-y-3">
                    <Label className="text-sm font-semibold text-muted-foreground uppercase tracking-wider">
                      Name Format
                    </Label>
                    <div className="grid grid-cols-2 gap-3">
                      <button
                        type="button"
                        onClick={() => setMode("fullname")}
                        className={`flex items-center gap-3 p-3 rounded-md border text-left transition-colors ${
                          mapping.nameMode === "fullname"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        <Users className="w-4 h-4 shrink-0" />
                        <div>
                          <p className="text-xs font-semibold">Full Name Column</p>
                          <p className="text-xs opacity-70">e.g. "SMITH JOHN" (Last First)</p>
                        </div>
                      </button>
                      <button
                        type="button"
                        onClick={() => setMode("separate")}
                        className={`flex items-center gap-3 p-3 rounded-md border text-left transition-colors ${
                          mapping.nameMode === "separate"
                            ? "border-primary bg-primary/10 text-primary"
                            : "border-border text-muted-foreground hover:border-primary/50"
                        }`}
                      >
                        <SplitSquareHorizontal className="w-4 h-4 shrink-0" />
                        <div>
                          <p className="text-xs font-semibold">Separate Columns</p>
                          <p className="text-xs opacity-70">First Name + Last Name</p>
                        </div>
                      </button>
                    </div>
                  </div>

                  {/* Column mapping */}
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {mapping.nameMode === "fullname" ? (
                      <div className="space-y-2 md:col-span-2">
                        <Label>
                          Owner Name Column{" "}
                          <span className="text-destructive">*</span>
                          <span className="ml-2 text-xs text-muted-foreground font-normal">
                            (format: LASTNAME FIRSTNAME — we auto-extract the first name)
                          </span>
                        </Label>
                        <Select
                          value={mapping.ownerNameCol}
                          onValueChange={(v) => setMapping({ ...mapping, ownerNameCol: v })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="Select column" />
                          </SelectTrigger>
                          <SelectContent>
                            {csvHeaders.map((h) => (
                              <SelectItem key={h} value={h}>
                                {h}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                    ) : (
                      <>
                        <div className="space-y-2">
                          <Label>
                            First Name Column <span className="text-destructive">*</span>
                          </Label>
                          <Select
                            value={mapping.firstNameCol}
                            onValueChange={(v) => setMapping({ ...mapping, firstNameCol: v })}
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select column" />
                            </SelectTrigger>
                            <SelectContent>
                              {csvHeaders.map((h) => (
                                <SelectItem key={h} value={h}>
                                  {h}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <div className="space-y-2">
                          <Label>Last Name Column</Label>
                          <Select
                            value={mapping.lastNameCol || "none"}
                            onValueChange={(v) =>
                              setMapping({ ...mapping, lastNameCol: v === "none" ? "" : v })
                            }
                          >
                            <SelectTrigger>
                              <SelectValue placeholder="Select column (optional)" />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="none">-- None --</SelectItem>
                              {csvHeaders.map((h) => (
                                <SelectItem key={h} value={h}>
                                  {h}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      </>
                    )}

                    <div className="space-y-2">
                      <Label>
                        Address Column <span className="text-destructive">*</span>
                      </Label>
                      <Select
                        value={mapping.addressCol}
                        onValueChange={(v) => setMapping({ ...mapping, addressCol: v })}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select column" />
                        </SelectTrigger>
                        <SelectContent>
                          {csvHeaders.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>City Column</Label>
                      <Select
                        value={mapping.cityCol || "none"}
                        onValueChange={(v) =>
                          setMapping({ ...mapping, cityCol: v === "none" ? "" : v })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select column (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">-- None --</SelectItem>
                          {csvHeaders.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <Label>State Column</Label>
                      <Select
                        value={mapping.stateCol || "none"}
                        onValueChange={(v) =>
                          setMapping({ ...mapping, stateCol: v === "none" ? "" : v, defaultState: v === "none" ? mapping.defaultState : "" })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select column (optional)" />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="none">-- None --</SelectItem>
                          {csvHeaders.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>

                    {/* Default state — shown when no state column selected */}
                    {!mapping.stateCol && (
                      <div className="space-y-2">
                        <Label>
                          Default State
                          <span className="ml-2 text-xs text-muted-foreground font-normal">
                            (used for all rows)
                          </span>
                        </Label>
                        <Input
                          placeholder="e.g. TX"
                          maxLength={2}
                          className="uppercase font-mono"
                          value={mapping.defaultState}
                          onChange={(e) =>
                            setMapping({ ...mapping, defaultState: e.target.value.toUpperCase() })
                          }
                        />
                      </div>
                    )}
                  </div>

                  {/* Preview table */}
                  <div className="rounded-md border border-border overflow-hidden">
                    <Table>
                      <TableHeader className="bg-muted/50">
                        <TableRow>
                          {csvHeaders.slice(0, 5).map((h) => (
                            <TableHead key={h} className="font-mono text-xs truncate max-w-[150px]">
                              {h}
                            </TableHead>
                          ))}
                          {csvHeaders.length > 5 && (
                            <TableHead className="w-[50px] text-muted-foreground">+{csvHeaders.length - 5}</TableHead>
                          )}
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {csvPreview.map((row, i) => (
                          <TableRow key={i}>
                            {row.slice(0, 5).map((cell, j) => (
                              <TableCell key={j} className="text-xs truncate max-w-[150px]">
                                {cell}
                              </TableCell>
                            ))}
                            {row.length > 5 && (
                              <TableCell className="text-xs text-muted-foreground">...</TableCell>
                            )}
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  {/* Row range */}
                  <div className="rounded-md border border-border bg-muted/30 p-4 space-y-3">
                    <Label className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                      Row Range <span className="font-normal normal-case">(process a slice of your CSV)</span>
                    </Label>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <Label className="text-xs">Start Row</Label>
                        <Input
                          type="number"
                          min={1}
                          placeholder="1"
                          className="font-mono"
                          value={mapping.startRow}
                          onChange={(e) => setMapping({ ...mapping, startRow: e.target.value })}
                        />
                      </div>
                      <div className="space-y-1">
                        <Label className="text-xs">End Row <span className="text-muted-foreground font-normal">(blank = all)</span></Label>
                        <Input
                          type="number"
                          min={1}
                          placeholder="e.g. 500"
                          className="font-mono"
                          value={mapping.endRow}
                          onChange={(e) => setMapping({ ...mapping, endRow: e.target.value })}
                        />
                      </div>
                    </div>
                    {mapping.endRow && mapping.startRow && (
                      <p className="text-xs text-primary font-mono">
                        ▶ Will process rows {mapping.startRow} – {mapping.endRow} ({Math.max(0, parseInt(mapping.endRow) - parseInt(mapping.startRow) + 1)} leads)
                      </p>
                    )}
                  </div>

                  <Button
                    className="w-full font-bold"
                    size="lg"
                    onClick={handleStartJob}
                    disabled={isUploading || !isValid()}
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
                  {[1, 2, 3].map((i) => (
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
                  {jobs.slice(0, 10).map((job) => (
                    <div
                      key={job.jobId}
                      className="border border-border rounded-md p-4 hover:border-primary/50 transition-colors cursor-pointer bg-card/50 flex flex-col gap-3"
                      onClick={() => setLocation(`/jobs/${job.jobId}`)}
                      data-testid={`card-job-${job.jobId}`}
                    >
                      <div className="flex justify-between items-start">
                        <div className="truncate pr-4">
                          <p className="font-medium text-sm truncate" title={job.fileName}>
                            {job.fileName}
                          </p>
                          <p className="text-xs text-muted-foreground font-mono mt-1">
                            {new Date(job.createdAt).toLocaleString()}
                          </p>
                        </div>
                        <JobBadge status={job.status} />
                      </div>

                      <div className="space-y-1">
                        <div className="flex justify-between text-xs font-mono">
                          <span>
                            {job.processedRows} / {job.totalRows} PROCESSED
                          </span>
                          <span className="text-primary">{job.foundCount} FOUND</span>
                        </div>
                        <Progress
                          value={job.totalRows > 0 ? (job.processedRows / job.totalRows) * 100 : 0}
                          className="h-1.5"
                        />
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
    case "completed":
      return (
        <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/20">
          <CheckCircle2 className="w-3 h-3 mr-1" /> DONE
        </Badge>
      );
    case "failed":
      return (
        <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/20">
          <XCircle className="w-3 h-3 mr-1" /> FAILED
        </Badge>
      );
    case "running":
      return (
        <Badge variant="outline" className="bg-primary/10 text-primary border-primary/20 animate-pulse">
          <Play className="w-3 h-3 mr-1" /> RUNNING
        </Badge>
      );
    case "pending":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <Clock className="w-3 h-3 mr-1" /> PENDING
        </Badge>
      );
    case "cancelled":
      return (
        <Badge variant="outline" className="text-muted-foreground">
          <XCircle className="w-3 h-3 mr-1" /> CANCELLED
        </Badge>
      );
    default:
      return <Badge variant="outline">{status}</Badge>;
  }
}
