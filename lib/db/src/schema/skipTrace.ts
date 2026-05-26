import { pgTable, text, integer, timestamp, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const skipTraceJobsTable = pgTable("skip_trace_jobs", {
  jobId: text("job_id").primaryKey(),
  status: text("status").notNull().default("pending"),
  totalRows: integer("total_rows").notNull().default(0),
  processedRows: integer("processed_rows").notNull().default(0),
  foundCount: integer("found_count").notNull().default(0),
  fileName: text("file_name").notNull(),
  columnMap: jsonb("column_map").notNull(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const skipTraceResultsTable = pgTable("skip_trace_results", {
  id: text("id").primaryKey(),
  jobId: text("job_id").notNull(),
  rowIndex: integer("row_index").notNull(),
  firstName: text("first_name").notNull().default(""),
  lastName: text("last_name").notNull().default(""),
  address: text("address").notNull().default(""),
  city: text("city").notNull().default(""),
  state: text("state").notNull().default(""),
  phones: jsonb("phones").notNull().default([]),
  status: text("status").notNull().default("pending"),
  error: text("error"),
  rawData: jsonb("raw_data"),
});

export const insertSkipTraceJobSchema = createInsertSchema(skipTraceJobsTable);
export const insertSkipTraceResultSchema = createInsertSchema(skipTraceResultsTable);

export type SkipTraceJob = typeof skipTraceJobsTable.$inferSelect;
export type InsertSkipTraceJob = z.infer<typeof insertSkipTraceJobSchema>;
export type SkipTraceResult = typeof skipTraceResultsTable.$inferSelect;
export type InsertSkipTraceResult = z.infer<typeof insertSkipTraceResultSchema>;
