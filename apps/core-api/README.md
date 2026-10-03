# Core API — AEGIS Supplier Risk

NestJS API for the synthetic Cadent-focused supplier disruption demonstrator. It serves supplier tiers, disruptions, stock-cover/shortage estimates, evidence-backed recovery options and role-gated simulation decisions.

Read the root [README](../../README.md) and [Cadent demo API guide](../../docs/cadent-demo.md) before running. Core API uses in-memory data; the Prisma schema is not connected to repositories or migrations. No live Cadent or SAP Ariba system is connected, and no real action is executed.

The interactive frontend is served from `apps/core-api/public` by the same NestJS process at `http://localhost:3000`. No separate frontend server or dependency install is required. Set local `DEMO_VIEWER_KEY`, `DEMO_OPERATOR_KEY` and `DEMO_MANAGER_KEY` variables before startup to try assessment and the simulated review flow.
