# AI Single-Shot Delivery Scope

This document defines the first-release AI scope for ThinkCRM, including the minimum data prerequisites and governance controls required before production use.

## High-Impact Features Included In Single-Shot Release

1. **AI Plan Visit Recommendations**
   - Generate visit recommendations for each rep from:
     - open deal follow-ups in `Opportunity` and `Quotation` stages
     - customer inactivity windows (`> 6 months`, `> 12 months`)
     - customers with no purchase history
   - Require explicit rep confirmation before creating any visit plans.
   - Endpoints:
     - `POST /api/v1/visits/ai-recommendations`
     - `GET /api/v1/visits/ai-recommendations/:runId`
     - `POST /api/v1/visits/ai-recommendations/:runId/confirm`
     - `POST /api/v1/visits/ai-recommendations/:runId/reject`

2. **AI Analysis Insights**
   - Run scoped behavioral analysis by tenant/hierarchy for selected date range and optional team/rep/stage filters.
   - Return findings across:
     - patterns (for example, afternoon-heavy check-ins)
     - anomalies (for example, low visit completion, overdue follow-up risk)
     - recommendations (for example, follow-up recovery actions)
   - Endpoints:
     - `POST /api/v1/ai-analysis/runs`
     - `GET /api/v1/ai-analysis/runs`
     - `GET /api/v1/ai-analysis/runs/:runId`

3. **Voice Note Transcription + Summary With Human Confirmation**
   - Accept voice note input for `Visit` or `Deal` context.
   - Produce transcript and summary preview.
   - Require explicit confirmation before writing data to progress logs.
   - Support reject path with no record mutation.
   - Endpoints:
     - `POST /api/v1/voice-notes`
     - `GET /api/v1/voice-notes/:jobId`
     - `POST /api/v1/voice-notes/:jobId/confirm`
     - `POST /api/v1/voice-notes/:jobId/reject`

4. **Post-Visit Structured Summary Assist**
   - Use the same transcript-confirmation guardrail model as voice notes.
   - Persist only user-approved summary text into visit/deal activity streams.

## Explicitly Out Of Scope For First Release

- Deal win-probability scoring.
- Next-best-action orchestration per deal/customer.
- Forecasting for KPI target attainment.
- Territory/schedule optimization.
- Autonomous coaching and alert automation without confirmation.

## Data Prerequisites (Production Gate)

AI features are production-ready only when the following conditions are met:

1. **Tenant-Isolated Core Data Completeness**
   - Complete `visit`, `deal`, `quotation`, and `kpi target` datasets with strict `tenant_id` ownership.
   - No cross-tenant joins in AI query inputs.

2. **Lifecycle Timestamp Quality**
   - Reliable timestamps for:
     - visit lifecycle (`planned`, `checkin`, `checkout`)
     - deal lifecycle (stage transitions, follow-up changes, close outcomes)
   - Server-authoritative timestamps for compliance-sensitive events.

3. **Hierarchy and Role Integrity**
   - Valid reporting chain mappings (`manager_user_id`, role chain rank).
   - User visibility scope derivation must be deterministic and auditable.

4. **Taxonomy/Status Normalization**
   - Stable, validated status labels for visits, deals, and stages.
   - Known stage naming conventions for recommendation and analysis logic.

5. **Traceability Dataset**
   - Recommendation decisions logged with immutable states:
     - `recommended`
     - `accepted`
     - `rejected`
   - Analysis run metadata and evidence snapshots retained for auditability.

## Governance Controls (Mandatory)

1. **Human-In-The-Loop Write Controls**
   - No AI action can mutate customer-facing records without explicit user confirmation.
   - Confirmation and rejection actions must be separately logged.

2. **Tenant Isolation And Access Scope**
   - Every AI read/write path must enforce tenant boundaries and hierarchy visibility.
   - Analysis scope must never exceed requester permissions.

3. **Explainability Standard**
   - Every recommendation/finding must include:
     - reason text
     - confidence score
     - evidence snippet or metrics used to justify output

4. **Safety And Privacy**
   - Redact secrets and direct identifiers in logs and prompt traces.
   - Do not persist raw credentials/tokens in AI artifacts.
   - Maintain masked integration logs and retention policies.

5. **Operational Monitoring**
   - Track recommendation acceptance/rejection rates by tenant and team.
   - Track false-positive feedback from users where available.
   - Alert on quality drift, missing evidence fields, or unusual run failures.

## Release Readiness Checklist (AI-Specific)

- [ ] Recommendation creation is blocked until explicit confirmation.
- [ ] Voice note confirmation is required before progress-log writes.
- [ ] AI analysis outputs include confidence and evidence payloads.
- [ ] Tenant/hierarchy scoped access checks are validated in tests.
- [ ] Decision audit trail (`recommended/accepted/rejected`) is queryable.
- [ ] Monitoring dashboards include run count, failure rate, and acceptance rate.
