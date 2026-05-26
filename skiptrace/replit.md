# Skip Tracer Pro

A real estate wholesaler automation tool that takes a CSV list of property addresses and automatically finds homeowner phone numbers via Cyber Background Checks.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 5000)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (`zod/v4`), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)
- Browser automation: Playwright (stealth mode, Chromium headless)
- CSV: csv-parse, csv-stringify
- File upload: multer (multipart/form-data)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for API contracts
- `lib/db/src/schema/skipTrace.ts` — DB schema for jobs + results
- `artifacts/api-server/src/routes/skipTrace.ts` — skip trace API route handlers
- `artifacts/api-server/src/lib/skipTracer.ts` — Playwright-based scraping engine
- `artifacts/skip-tracer/src/` — React frontend (dark mission-control theme)

## Architecture decisions

- File uploads use multipart/form-data via multer; column mapping passed as query params (avoids Zod File/Blob codegen issues)
- Skip tracing runs async in the background after job creation; frontend polls every 2s
- Playwright uses stealth headers + navigator spoofing to avoid Cloudflare bot detection
- Jobs stored in DB so progress survives server restarts
- Results downloadable as enriched CSV

## Product

- Upload a CSV list of property addresses
- Map columns (first name, last name, address, city, state)
- Preview CSV before submitting
- Watch real-time progress with live polling
- Download enriched CSV with phone numbers found

## User preferences

_Populate as you build — explicit user instructions worth remembering across sessions._

## Gotchas

- Playwright Chromium must be installed: `npx playwright install chromium` in api-server
- Upload endpoint uses query params for column mapping, NOT request body (avoids TS codegen collision with multipart File type)
- After OpenAPI spec changes, always re-run codegen before typechecking

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
