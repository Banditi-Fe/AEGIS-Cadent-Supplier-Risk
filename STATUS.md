# Project status — Cadent supplier-risk focus

## Implemented in this handoff

- Cadent-oriented, synthetic multi-tier supplier network and ten-day supplier-delay demonstration.
- Upstream dependency traversal, depot stock cover, shortage estimates, risk categories and evidence references.
- Recovery-option comparison with explicit feasibility, costs, lead times, residual shortage and approval constraints.
- Supplier-risk assessment API and AI Engine endpoint. Model output is schema-checked, limited to supplied feasible option IDs and evidence, and never provides the final authorization decision.
- Core API deterministic fallback; unknown data feeds stay unknown.
- Demo role gates, in-memory approval/decision records and simulated Ariba status.
- Persistent local materials register with role-gated CRUD, real-time stock-cover/shortage/value statistics, and disruption calculations derived from saved stock, demand, lead-time and transfer data.
- Tenant-scoped Prisma domain schema.
- Responsive interactive dashboard served by Core API, with supplier graph, impact timeline, risk coverage, evidence and simulated approval flow.

## Not implemented / not connected

- Persistent database repositories, migrations and production data loading.
- Cadent, SAP Ariba, ERP, inventory, supplier risk-feed, cyber, ESG, financial or geopolitical integrations.
- Real action execution, production identity, deployed policy configuration, durable audit/event storage, monitoring/alert delivery, or supplier-risk service-level evaluation.
- Real Cadent supplier, asset, depot, demand, work-order or cost data. Nothing in the demo indicates that Cadent uses or endorses AEGIS.

The materials register stores user-entered records locally in `apps/core-api/data/materials.json`; other seeded supplier, disruption and approval data is still in memory. Seed records are illustrative. The Ariba adapter reports disconnected. This is a local prototype and is not yet a shared company deployment or an operational supply-chain system.

## Verification status

The user confirmed the backend and contracts passed workspace typecheck/build before the latest static dashboard additions. Re-run typecheck/build after these changes, validate `apps/core-api/prisma/schema.prisma` after the relation fixes, and open the dashboard in a browser for a smoke check. Do not describe the prototype as production-ready.
