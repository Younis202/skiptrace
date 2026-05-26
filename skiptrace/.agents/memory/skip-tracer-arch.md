---
name: Skip Tracer architecture
description: Key decisions for the skip tracing automation system
---

**Job lifecycle:**
1. CSV upload → multer → DB insert (job + results rows) → async `runSkipTrace(jobId)` fires
2. Frontend polls `GET /api/skip-trace/jobs/:jobId` every 2s while status is pending/running
3. Job status: pending → running → completed/failed/cancelled

**Retry system (MAX_RETRIES=3):**
- After pass 1, collect rows with status=error and retryCount < MAX_RETRIES
- Increment retryCount, rotate to fresh browser + new proxy
- Up to 3 retry passes after the main pass
- Retries tracked in DB column `retry_count` on `skip_trace_results`

**Proxy rotation:**
- Round-robin across active proxies from `proxies` table
- Auto-disable proxy after 5 consecutive failures
- Rotate browser mid-job after 3 consecutive errors

**Browser stealth:**
- `playwright-extra` + `puppeteer-extra-plugin-stealth` (11 evasion techniques)
- Random delays 2-5s between rows; 3-6s after errors
- Warm-up: visit homepage before starting scrape loop
- Stealth UA + sec-ch-ua headers matching Chrome 131

**Column mapping:** passed as query params on `/api/skip-trace/upload` (not body) to avoid Zod/TS collision with multipart File type.
