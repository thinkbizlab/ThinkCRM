# API-First Coverage Map

This document tracks API coverage for plan-level business capabilities and confirms stable `/api/v1` contracts for future native mobile clients.

## Coverage Principles

- Every business capability is available via HTTP API under `/api/v1`.
- Mobile-safe contracts prioritize explicit resource paths over UI-coupled behavior.
- Compatibility aliases are provided where earlier endpoints used different paths.

## Capability Coverage

- **Tenant onboarding and activation**
  - `POST /api/v1/tenants/signup` (plan contract)
  - `POST /api/v1/tenants/onboard` (legacy-compatible onboarding path)
- **Billing and subscription**
  - `GET /api/v1/tenants/:id/subscription`
  - `POST /api/v1/tenants/:id/subscription/payment-method`
  - `PATCH /api/v1/tenants/:id/subscription/seats` (prorated seat updates; mirrors `PATCH /billing/subscription/seats`)
  - `POST /api/v1/billing/stripe/webhooks` (implemented in `billing` module: idempotency table + legacy + Stripe-shaped payloads)
  - `GET /api/v1/tenants/:id/storage/quota`
  - `GET /api/v1/tenants/:id/storage/usage`
- **User lifecycle and hierarchy scope**
  - `POST /api/v1/users/invite`
  - `PATCH /api/v1/users/:id/role`
  - `PUT /api/v1/users/:id/manager`
  - `GET /api/v1/users/:id/scope`
  - `GET /api/v1/tenants/:id/role-chain`
  - `PUT /api/v1/tenants/:id/role-chain` (persisted in `TenantRoleChain`)
- **Master data and extensibility**
  - `GET /api/v1/customers/:id`
  - `GET /api/v1/items/:id`
  - `PATCH /api/v1/customers/:id/addresses/:addressId/defaults`
  - `POST /api/v1/:entityType/:id/custom-fields`
- **Visit lifecycle**
  - `GET /api/v1/visits/:id` (hierarchy-scoped; implemented in `src/modules/visits/routes.ts`)
  - existing lifecycle endpoints remain in `src/modules/visits/routes.ts`
- **Deal and quotation lifecycle**
  - `GET /api/v1/deals/:id`
  - `POST /api/v1/deals/:id/items`
  - `PATCH /api/v1/quotations/:id/status` (persists `Quotation.status`)
  - existing deal/quotation endpoints remain in `src/modules/deals/routes.ts`
- **Dashboard breakdown for mobile**
  - `GET /api/v1/dashboard/summary`
  - `GET /api/v1/dashboard/pipeline`
  - `GET /api/v1/dashboard/visits`
  - `GET /api/v1/dashboard/team-performance`
  - `GET /api/v1/dashboard/gamification`

## Discovery Endpoint

- `GET /api/v1/api-capabilities` provides high-level capability groups for client bootstrap and API discovery.
