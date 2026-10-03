# Core API contract — supplier-risk demo

All paths below are served from the Core API on port 3000. Data and writes are in-memory and synthetic.

## Demonstration routes

| Method | Path | Access | Purpose |
|---|---|---|---|
| GET | `/api/v1/demo/supply-chain` | Demo snapshot | Synthetic network, inventory and disconnected Ariba status |
| GET | `/api/v1/suppliers/network` | `X-Organization-Id: cadent-demo` | Tiered supplier network |
| GET | `/api/v1/suppliers/{id}/risk` | organization header | Eight-category supplier risk profile |
| GET | `/api/v1/disruptions` | organization header | List synthetic disruption contexts |
| POST | `/api/v1/disruptions` | Operator, manager or admin demo key | Add a demo disruption |
| POST | `/api/v1/disruptions/{id}/assess` | Any demo role key plus org header | AI analysis, or degraded deterministic fallback |
| POST | `/api/v1/disruptions/{id}/decide` | Any demo role key | Request a simulated recovery decision |
| POST | `/api/v1/recovery-actions/{id}/approve` | Manager or admin demo key | Record simulated approval/rejection |
| GET | `/api/v1/integrations/ariba/status` | organization header | Show the Ariba simulation state |

Demo role authentication uses `X-Demo-Role-Key` with one of `DEMO_VIEWER_KEY`, `DEMO_OPERATOR_KEY`, `DEMO_MANAGER_KEY`, or `DEMO_ADMIN_KEY`. Internal service calls use `X-Service-Key`; context also requires `X-Organization-Id`. The supported demo organization is `cadent-demo`.

Assessment request body: `{}`. Decision body: `{"organizationId":"cadent-demo","optionId":"OPT-TRANSFER-DEPOT-BIR"}`. Approval body: `{"approved":true}`. An approval records a simulation status only; no stock movement, purchase order or work-order change occurs.

## AI Engine contract

Core API calls `POST http://127.0.0.1:4100/v1/analyze/disruption` with service header and JSON `{ "organizationId": "cadent-demo", "disruptionId": "DSP-DEMO-001" }`. The AI Engine reads only `GET /internal/v1/disruptions/{id}/context` through its restricted GET-only client. It cannot write or execute actions. Its strict response schema is in `packages/contracts/ai/src/supplyChain.ts`.

The AI recommendation selects only a supplied feasible option and must cite supplied evidence. Core API owns role checks and the final simulated decision. When analysis fails, Core API supplies a deterministic result marked `DEGRADED`.

## Limits

This API is a local hackathon prototype: no durable database use, production authentication, external Ariba connection, external risk feeds, real source data, or execution adapter is present. Do not use synthetic values for operational decisions.
