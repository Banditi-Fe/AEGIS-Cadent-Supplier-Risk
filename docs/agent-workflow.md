# Supplier disruption analysis workflow

1. A business user reports a supplier, material and delay.
2. Core API validates the demo request and builds a tenant-scoped disruption context from the synthetic multi-tier network.
3. Deterministic code traces affected downstream suppliers, calculates stock cover and shortage, lists evidence, and creates feasible/infeasible recovery options.
4. Core API sends a read-only analysis request to AI Engine. AI Engine fetches the context using an internal GET-only client and a service credential.
5. The model summarizes the disruption and may select one feasible option already computed by Core API. Strict Zod validation rejects unknown options, invalid structure and evidence IDs not present in the context. Invalid or unavailable model output falls back to a deterministic recommendation.
6. Core API applies the demo role rule: monitor-only may be automatic; stock transfer or expedite requires a manager; unsupported options are blocked. Approval and audit state are simulation-only.

AI never authorizes, approves, executes or writes to Core API. Database storage and production policy/authentication are not connected. See [the Cadent demo scenario](cadent-demo.md).
