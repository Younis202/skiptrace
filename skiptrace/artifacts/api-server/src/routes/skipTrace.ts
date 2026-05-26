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

/**
 * Parse an "owner_name" field in "LASTNAME FIRSTNAME [MIDDLE] [& PARTNER] [JR/SR] [C/O ...]" format.
 * Returns { firstName, lastName } — firstName is the key match field.
 *
 * Examples:
 *   "WU ALPHONSE JUN"              → { lastName: "WU",      firstName: "ALPHONSE" }
 *   "CHIRINOS LUIS & ESTHER"       → { lastName: "CHIRINOS", firstName: "LUIS" }
 *   "TRICK-THORNTON ALISON D C/O"  → { lastName: "TRICK-THORNTON", firstName: "ALISON" }
 *   "MOORE HARRY J JR"             → { lastName: "MOORE",   firstName: "HARRY" }
 */
function parseOwnerName(raw: string): { firstName: string; lastName: string } {
  if (!raw) return { firstName: "", lastName: "" };

  let name = raw
    .replace(/\s+C\/O\b.*/i, "")       // strip C/O and everything after
    .replace(/\s+ET\s+AL\b.*/i, "")    // strip ET AL
    .replace(/\s+%\s+.*/i, "")         // strip % ...
    .replace(/\s+&\s+.*/i, "")         // strip & PARTNER
    .replace(/\bREVOCABLE\b.*/i, "")   // strip REVOCABLE TRUST etc.
    .replace(/\bTRUST\b.*/i, "")
    .replace(/\b(TR|LLC|INC|CORP|LTD)\b.*/i, "")
    .trim();

  const SUFFIXES = new Set(["JR", "SR", "II", "III", "IV", "JR.", "SR.", "ESQ"]);
  const parts = name.split(/\s+/).filter(Boolean);

  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };

  const lastName = parts[0];

  // Second word is first name — skip if it's a suffix
  let firstName = parts[1];
  if (SUFFIXES.has(firstName.toUpperCase()) && parts.length > 2) {
    firstName = parts[2];
  }

  return { firstName, lastName };
}

router.post("/skip-trace/upload", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      res.status(400).json({ error: "No file uploaded" });
      return;
    }

    const {
      firstNameCol,
      lastNameCol,
      ownerNameCol,
      addressCol,
      cityCol,
      stateCol,
      defaultState,
      startRow,
      endRow,
    } = req.query as Record<string, string>;

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

    // Apply row range slicing (1-based, inclusive)
    const start = parseInt(startRow || "1", 10);
    const end = parseInt(endRow || "0", 10);
    const sliceStart = isNaN(start) || start < 1 ? 0 : start - 1;
    const sliceEnd = isNaN(end) || end <= 0 ? records.length : Math.min(end, records.length);
    records = records.slice(sliceStart, sliceEnd);

    if (records.length === 0) {
      res.status(400).json({ error: "No rows in the selected range" });
      return;
    }

    const useOwnerName = Boolean(ownerNameCol);
    const columnMap = {
      ownerNameCol: ownerNameCol || "",
      firstNameCol: firstNameCol || "",
      lastNameCol: lastNameCol || "",
      addressCol,
      cityCol: cityCol || "",
      stateCol: stateCol || "",
      defaultState: defaultState || "",
    };
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

    const resultRows = records.map((row, index) => {
      let firstName = "";
      let lastName = "";

      if (useOwnerName && ownerNameCol && row[ownerNameCol]) {
        const parsed = parseOwnerName(row[ownerNameCol]);
        firstName = parsed.firstName;
        lastName = parsed.lastName;
      } else {
        firstName = (firstNameCol ? row[firstNameCol] : "") || "";
        lastName = (lastNameCol ? row[lastNameCol] : "") || "";
      }

      const state = (stateCol ? row[stateCol] : "") || defaultState || "";

      return {
        id: uuidv4(),
        jobId,
        rowIndex: index,
        firstName,
        lastName,
        address: row[addressCol] || "",
        city: (cityCol ? row[cityCol] : "") || "",
        state,
        phones: [],
        status: "pending",
        rawData: row,
      };
    });

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
    retryCount: r.retryCount,
    error: r.error || undefined,
  };
}

export default router;
