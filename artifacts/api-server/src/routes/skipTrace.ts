import { Router } from "express";
import multer from "multer";
import { parse } from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";
import { v4 as uuidv4 } from "uuid";
import { eq, and } from "drizzle-orm";
import { db, skipTraceJobsTable, skipTraceResultsTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { runSkipTrace } from "../lib/skipTracer";

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

router.post("/skip-trace/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const { firstNameCol, lastNameCol, addressCol, cityCol, stateCol } = req.query as Record<string, string>;

    if (!addressCol) {
      res.status(400).json({ error: "addressCol query param is required" });
      return;
    }

    const csvText = req.file.buffer.toString("utf-8");
    let records: Record<string, string>[];
    try {
      records = parse(csvText, { columns: true, skip_empty_lines: true, trim: true }) as Record<string, string>[];
    } catch {
      res.status(400).json({ error: "Invalid CSV file" });
      return;
    }

    if (records.length === 0) {
      res.status(400).json({ error: "CSV file is empty" });
      return;
    }

    const columnMap = { firstNameCol: firstNameCol || "", lastNameCol: lastNameCol || "", addressCol, cityCol: cityCol || "", stateCol: stateCol || "" };
    const jobId = uuidv4();

    await db.insert(skipTraceJobsTable).values({
      jobId,
      status: "pending",
      totalRows: records.length,
      processedRows: 0,
      foundCount: 0,
      fileName: req.file.originalname,
      columnMap,
    });

    const resultRows = records.map((row, index) => ({
      id: uuidv4(),
      jobId,
      rowIndex: index,
      firstName: (columnMap.firstNameCol ? row[columnMap.firstNameCol] : "") || "",
      lastName: (columnMap.lastNameCol ? row[columnMap.lastNameCol] : "") || "",
      address: row[columnMap.addressCol] || "",
      city: (columnMap.cityCol ? row[columnMap.cityCol] : "") || "",
      state: (columnMap.stateCol ? row[columnMap.stateCol] : "") || "",
      phones: [],
      status: "pending",
      rawData: row,
    }));

    await db.insert(skipTraceResultsTable).values(resultRows);

    runSkipTrace(jobId).catch((err) => {
      logger.error({ err, jobId }, "Skip trace job failed");
    });

    res.json({ jobId, status: "pending" });
  } catch (err) {
    req.log.error({ err }, "Failed to upload skip trace list");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/skip-trace/jobs", async (req, res) => {
  try {
    const jobs = await db.select().from(skipTraceJobsTable).orderBy(skipTraceJobsTable.createdAt);
    res.json({ jobs: jobs.map(formatJob) });
  } catch (err) {
    req.log.error({ err }, "Failed to list jobs");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/skip-trace/jobs/:jobId", async (req, res) => {
  try {
    const { jobId } = req.params;
    const [job] = await db.select().from(skipTraceJobsTable).where(eq(skipTraceJobsTable.jobId, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const results = await db.select().from(skipTraceResultsTable)
      .where(eq(skipTraceResultsTable.jobId, jobId))
      .orderBy(skipTraceResultsTable.rowIndex);

    res.json({
      ...formatJob(job),
      results: results.map(formatResult),
      columnMap: job.columnMap as Record<string, string>,
    });
  } catch (err) {
    req.log.error({ err }, "Failed to get job");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.get("/skip-trace/jobs/:jobId/results", async (req, res) => {
  try {
    const { jobId } = req.params;
    const [job] = await db.select().from(skipTraceJobsTable).where(eq(skipTraceJobsTable.jobId, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    const results = await db.select().from(skipTraceResultsTable)
      .where(eq(skipTraceResultsTable.jobId, jobId))
      .orderBy(skipTraceResultsTable.rowIndex);

    const rows = results.map((r) => ({
      Row: r.rowIndex + 1,
      "First Name": r.firstName,
      "Last Name": r.lastName,
      Address: r.address,
      City: r.city,
      State: r.state,
      "Phone 1": (r.phones as string[])[0] || "",
      "Phone 2": (r.phones as string[])[1] || "",
      "Phone 3": (r.phones as string[])[2] || "",
      Status: r.status,
      Error: r.error || "",
    }));

    const csv = stringify(rows, { header: true });
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="skip-trace-results-${jobId.slice(0, 8)}.csv"`);
    res.send(csv);
  } catch (err) {
    req.log.error({ err }, "Failed to get job results");
    res.status(500).json({ error: "Internal server error" });
  }
});

router.post("/skip-trace/jobs/:jobId/cancel", async (req, res) => {
  try {
    const { jobId } = req.params;
    const [job] = await db.select().from(skipTraceJobsTable).where(eq(skipTraceJobsTable.jobId, jobId));
    if (!job) {
      res.status(404).json({ error: "Job not found" });
      return;
    }

    if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
      res.json({ jobId, status: job.status });
      return;
    }

    await db.update(skipTraceJobsTable)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(skipTraceJobsTable.jobId, jobId));

    res.json({ jobId, status: "cancelled" });
  } catch (err) {
    req.log.error({ err }, "Failed to cancel job");
    res.status(500).json({ error: "Internal server error" });
  }
});

function formatJob(job: typeof skipTraceJobsTable.$inferSelect) {
  return {
    jobId: job.jobId,
    status: job.status,
    totalRows: job.totalRows,
    processedRows: job.processedRows,
    foundCount: job.foundCount,
    fileName: job.fileName,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
  };
}

function formatResult(r: typeof skipTraceResultsTable.$inferSelect) {
  return {
    rowIndex: r.rowIndex,
    firstName: r.firstName,
    lastName: r.lastName,
    address: r.address,
    city: r.city || "",
    state: r.state || "",
    phones: (r.phones as string[]) || [],
    status: r.status,
    error: r.error || undefined,
  };
}

export default router;
