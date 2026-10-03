# AEGIS Supplier Risk — Cadent-focused demonstrator

AEGIS monitors a disruption across a synthetic, multi-tier supplier network, identifies affected network depots, estimates stock cover and shortages, and compares recovery options. The AI summarizes evidence and may recommend only a feasible option supplied by the Core API. Core API remains the control point for roles, policy, human approval and audit records.

This project is a prototype shaped around Cadent Gas's publicly advertised market-engagement topic, **Managing and Monitoring Multi-Tier Supplier Risk**. It is not a Cadent product, endorsement, integration, pilot or statement of Cadent's private operational data. All names, suppliers, stock, demand, lead times, costs and disruption facts shown here are synthetic. No SAP Ariba system is connected.

## Demonstration scenario

A synthetic tier-2 casting supplier reports a ten-day delay for DN300 pressure-regulator valves. The scenario has 2,000 usable units at a Manchester depot and demand of 500 per day: four days of cover and a projected 3,000-unit gap if the full delay occurs. The demo compares an inter-depot transfer, expedited shipment, an unqualified alternate, rescheduling work, and monitoring. Unsupported sourcing and work deferral are marked infeasible; transfers and expedite require human approval. Any displayed costs and quantities are illustrative and must be rechecked against real source systems before operational use.

The risk profile includes financial, operational, business-continuity, cyber, ESG, compliance, geopolitical and reputational categories. Missing feeds are `UNKNOWN`, not low risk.

## What is implemented

- NestJS Core API with Cadent-oriented synthetic supplier tiers, disruption, inventory, impact and recovery-option data.
- Read-only, tenant-scoped Core API context for the AI Engine.
- Ollama AI analysis endpoint at `POST /v1/analyze/disruption`, with strict response validation and deterministic fallback in Core API.
- Demo role keys for request, decision and approval routes. Decisions and approvals are recorded in in-memory simulation only.
- Prisma schema for the intended supplier-risk domain.
- SAP Ariba status/mapping preview that explicitly reports `SIMULATED_ADAPTER` and `connected: false`.
- Responsive interactive dashboard served by Core API, including supplier tiers, impact timeline, risk coverage, evidence, recovery comparison and simulated approval review.
- Materials register with role-protected create, edit and delete APIs. Entries persist locally in `apps/core-api/data/materials.json`; stock cover, projected shortage, at-risk count and inventory value are calculated from saved stock, demand, lead-time and unit-cost data.
- The dashboard refreshes material statistics across open browser sessions every five seconds. Updating a material linked to an open disruption also recalculates its impact context and the next AI assessment inputs.

## Prototype limits

The materials register persists to a local JSON file on the API machine; it is a single-process local prototype, not a shared company database. Suppliers, disruptions, assessments, recovery decisions and approvals still use in-memory sample records and reset when the API restarts. The Prisma schema is not wired to repositories or migrations. Demo role keys are not production identity management. The Ariba adapter, external risk feeds, ERP/inventory integrations, real action execution, durable audit storage and production authorization/policy configuration are not implemented. Do not treat the seeded supplier scenario as Cadent data or connect this prototype to live systems.

The AI Engine retains the original payment analysis endpoint for compatibility with the merged archive; it is outside this Cadent-focused demonstration. The active demonstration path is supplier disruption analysis.

## Run locally

Requirements: Node.js 22.12 or newer, pnpm, and optionally Ollama with a local model. Database and Ollama are not needed for the in-memory fallback demo.

```powershell
pnpm install
$env:INTERNAL_SERVICE_KEY = 'replace-with-a-random-internal-key'
$env:DEMO_VIEWER_KEY = 'replace-with-a-random-viewer-key'
$env:DEMO_MANAGER_KEY = 'replace-with-a-random-manager-key'
$env:DEMO_OPERATOR_KEY = 'replace-with-a-random-operator-key'
$env:DEMO_ADMIN_KEY = 'replace-with-a-random-admin-key'
corepack pnpm --dir apps/core-api run start:dev
```

For AI-backed analysis, start Ollama if available, then in a second terminal set `AI_ENGINE_SHARED_SECRET` to a random value, set `CORE_API_SERVICE_KEY` to the exact `INTERNAL_SERVICE_KEY` from the Core API terminal, set `CORE_API_BASE_URL=http://127.0.0.1:3000` and `OLLAMA_MODEL` to an installed model, then run `corepack pnpm --dir apps/ai-engine run dev`. Set the same `AI_ENGINE_SHARED_SECRET` in the Core API terminal so the Core API can call the AI Engine. If Ollama or the AI Engine is unavailable, the Core API returns a deterministic degraded assessment. Environment examples are reference files; these apps do not load `.env` files automatically.

Core API: `http://localhost:3000`; AI Engine: `http://localhost:4100`.

## Open the interactive dashboard

The Core API also serves the static dashboard at `http://localhost:3000`. The dashboard uses the same-origin API and works with the deterministic fallback when the AI Engine/Ollama is not running. To exercise assessment and simulated review buttons, configure local demo keys before starting Core API, for example in PowerShell:

```powershell
$env:DEMO_VIEWER_KEY = 'local-viewer-demo'
$env:DEMO_OPERATOR_KEY = 'local-operator-demo'
$env:DEMO_MANAGER_KEY = 'local-manager-demo'
corepack pnpm --dir apps/core-api run start:dev
```

Enter those matching values through the dashboard's demo-access settings. These are local demonstration keys, not production authentication. The dashboard keeps them in browser memory only. The settings panel explains how to configure keys, and the page itself clearly marks every scenario record as synthetic.

See [Cadent demo API and workflow](docs/cadent-demo.md) for request examples and the synthetic scenario walkthrough. See [STATUS.md](STATUS.md) for validation status.
