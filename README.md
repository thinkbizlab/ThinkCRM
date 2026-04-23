# ThinkCRM

Multi-tenant Sales CRM backend scaffold built in one-shot MVP mode.

## Stack
- Fastify + TypeScript
- Prisma + PostgreSQL
- Zod validation
- OpenAPI via Swagger

## Quick Start
1. Install dependencies:
   - `npm install`
2. Prepare environment:
   - `cp .env.example .env`
3. Apply database migrations:
   - `npm run prisma:generate`
   - `npm run prisma:migrate:deploy`
4. Start API:
   - `npm run dev`
5. Seed demo data (recommended for first run):
   - `npm run seed`

API base URL: `http://localhost:3000/api/v1`

Docs:
- Swagger UI: `http://localhost:3000/docs`
- OpenAPI JSON: `http://localhost:3000/openapi.json`
- Mobile-first web app: `http://localhost:3000/`
- AI single-shot scope: `docs/ai/single-shot-delivery.md`

## Authentication
- Protected routes require: `Authorization: Bearer <accessToken>`
- Login endpoint: `POST /api/v1/auth/login`
- Demo seeded login:
  - `tenantSlug`: `thinkcrm-demo`
  - `email`: `admin@thinkcrm.demo`
  - `password`: `ThinkCRM123!`
- Legacy headers (`x-tenant-id`, `x-user-id`, `x-user-role`) are no longer sufficient for protected routes.

## Major Implemented Modules (MVP Scaffold)
- Tenant onboarding + default bootstrap (admin user, stages, VAT config, default payment term)
- Master data APIs (`payment terms`, `customers`, `items`, contacts/addresses)
- Deal + quotation APIs (kanban list, stage updates, progress updates, close flow)
- Visit lifecycle APIs (planned/unplanned, check-in/out, calendar feed, prep suggestions)
- Integrations module (sources, mappings, sync jobs, webhook, test connection, logs)
- AI module scaffolds (visit recommendations, analysis runs/findings, voice-note confirmation flow)
- Dashboard + rep to-do APIs
- Tenant settings (branding, tax config, KPI targets, user integration bindings)
- Billing foundation (fixed per-user subscription capture + storage quota/overage metering APIs)

## Tests
- `npm test`

## Billing & Onboarding APIs
- Tenant onboarding now captures:
  - first admin bootstrap
  - fixed per-user subscription data (`seatPriceCents`, `initialSeatCount`, `paymentMethodRef`)
  - storage quota setup (`includedBytes`, `overagePricePerGb`)
- Key billing endpoints:
  - `GET /api/v1/billing/subscription`
  - `PUT /api/v1/billing/subscription/capture`
  - `PATCH /api/v1/billing/subscription/seats` (with prorated adjustment event)
  - `GET /api/v1/billing/storage/usage`
  - `POST /api/v1/billing/storage/usage/record`
  - `GET /api/v1/billing/storage/overage-preview`
  - `GET /api/v1/billing/invoices/monthly-preview`
  - `POST /api/v1/billing/invoices/finalize`
  - `GET /api/v1/billing/invoices`
- First-login password policy:
  - bootstrap admin must reset password before first login
  - reset endpoint: `POST /api/v1/auth/first-login-reset`

## Postman Smoke Pack
- Collection: `docs/postman/ThinkCRM-Smoke.postman_collection.json`
- Environment: `docs/postman/ThinkCRM-Smoke.local.postman_environment.json`
- Seed first: `npm run seed`

## End-user UI Testing
- Open `http://localhost:3000/`
- Login with demo account:
  - tenant slug: `thinkcrm-demo`
  - email: `admin@thinkcrm.demo`
  - password: `ThinkCRM123!`
- Use bottom navigation for:
  - Dashboard KPIs
  - Master Data (payment terms/customers)
  - Deals (kanban)
  - Visits (check-in/check-out actions)
  - Integration Logs
- In **Settings > Branding**, upload logo file directly (`png/jpg/webp/svg`, max 5MB) for white-label tenant branding.
- Master Data direct routes:
  - `/master/payment-terms`
  - `/master/customers`
  - `/master/items`
