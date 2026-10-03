# AI architecture for supplier risk

The Core API owns synthetic supplier, disruption, impact, option, role and simulated approval data. The AI Engine is an internal read-only advisory service.

```text
Demo client -> Core API -> tenant-scoped disruption context
                          -> AI Engine (read-only GET context)
                          <- constrained recommendation + evidence citations
Core API -> demo policy/role gate -> simulated approval record
```

The model receives only sanitized, relevant context. It has no tools, business credentials or write client. It cannot create new recovery options or change their feasibility/cost. The response must cite known evidence and choose a feasible option ID or none. Core API independently checks user role and records the decision. If the model or AI Engine is unavailable or fails contract validation, Core API returns a deterministic `DEGRADED` assessment.

Ollama is optional for local demonstration. The Prisma supplier-risk schema is present but not used by the in-memory service. No live Ariba, ERP, supplier feed or Cadent system is connected.
