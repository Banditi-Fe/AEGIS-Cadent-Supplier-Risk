# Cadent-focused supplier-risk demo

## Materials register

The local dashboard provides an editable materials register. `GET /api/v1/materials` returns saved entries and calculated stock cover, shortage, at-risk count and estimated stock value. Operators, managers and admins may `POST` materials and `PATCH /api/v1/materials/:id`; managers and admins may `DELETE /api/v1/materials/:id`. Send `x-organization-id: cadent-demo` for reads and the configured `x-demo-role-key` for writes. Records persist on the Core API machine in `apps/core-api/data/materials.json`. Changes to the material tied to the seeded open disruption flow into its next impact assessment. Other disruption, supplier and action records remain sample/in-memory data.

## Why this workflow

Cadent Gas published a preliminary market engagement titled **Managing and Monitoring Multi-Tier Supplier Risk**. This prototype is shaped around that publicly described topic: seeing risk beyond direct suppliers, understanding dependencies and service-delivery exposure, monitoring disruption signals, and relating suppliers to an Ariba-style risk record. The notice is a market engagement; this prototype does not imply a contract, request from Cadent for AEGIS, endorsement, or access to Cadent systems/data.

## Synthetic walkthrough

1. Open `GET /api/v1/demo/supply-chain` and show the tier 1, 2 and 3 suppliers and the disconnected Ariba adapter.
2. Open `GET /api/v1/disruptions` and select `DSP-DEMO-001`.
3. The tier-2 casting delay propagates to the tier-1 valve supplier and the synthetic Manchester service depot. The example has 2,000 available units and 500 units/day demand, giving four days of cover. A ten-day delay leaves six uncovered days, or 3,000 units at risk.
4. `POST /api/v1/disruptions/DSP-DEMO-001/assess` retrieves a tenant-scoped evidence package and calls the AI Engine. The AI explains the impact and can recommend only a supplied, feasible option. If AI is offline, the Core API returns a degraded deterministic assessment.
5. Compare transfer, expedite, alternate-supplier and work-reschedule choices. The transfer and expedite are estimates requiring approval. The alternate and rescheduling choices remain infeasible because qualification or safety/work-order evidence is absent. Monitoring is feasible but does not close the shortage.
6. `POST /api/v1/disruptions/DSP-DEMO-001/decide` requests a simulated decision; `/api/v1/recovery-actions/{id}/approve` records a simulated manager approval. Neither endpoint executes a real transfer or purchase order.

The example cost of £18,000, quantities, suppliers, product, demand, locations and timing are invented for the demo. Revalidate all inventory, constraints, dates, service priorities and supplier commitments in real source systems before any operational use.

## Local API

Core API runs on port 3000. AI Engine runs on port 4100. The API is intended for local demonstration only. Set distinct random values for the Core API `INTERNAL_SERVICE_KEY`, AI Engine inbound `AI_ENGINE_SHARED_SECRET`, and role-specific `DEMO_ADMIN_KEY`, `DEMO_MANAGER_KEY`, `DEMO_OPERATOR_KEY`, and `DEMO_VIEWER_KEY` variables. Set AI Engine `CORE_API_SERVICE_KEY` equal to Core API `INTERNAL_SERVICE_KEY`; set Core API `AI_ENGINE_SHARED_SECRET` equal to AI Engine `AI_ENGINE_SHARED_SECRET`. The `.env.example` files are reference lists; these apps do not load `.env` files automatically. Never publish populated secret files.

Example read:

```powershell
Invoke-RestMethod http://localhost:3000/api/v1/demo/supply-chain
```

Assessment example (use a configured demo role key):

```powershell
$headers = @{ 'x-organization-id' = 'cadent-demo'; 'x-demo-role-key' = '<your-demo-viewer-key>' }
Invoke-RestMethod -Method Post -Uri http://localhost:3000/api/v1/disruptions/DSP-DEMO-001/assess -Headers $headers -ContentType 'application/json' -Body '{}'
```

Decision endpoints are simulated and role gated. Inspect [the Core API controller](../apps/core-api/src/supply-chain/supply-chain.controller.ts) for exact request bodies before trying a decision.
