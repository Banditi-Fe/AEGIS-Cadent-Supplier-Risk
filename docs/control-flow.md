# Control flow and demo decisions

Core API computes operational impacts and candidate options from the supplier graph and synthetic stock/demand records. The AI Engine may explain this result and identify one candidate. Core API then applies its hard-coded demo rule:

- `MONITOR`: may be recorded as `AUTO` in simulation.
- Feasible transfer or expedite: requires a manager approval step.
- Option marked infeasible, viewer requesting a controlled action, or missing required evidence: `BLOCKED`.

No decision runs a real connector. In-memory action and audit records disappear on process restart. These are proof-of-concept safeguards, not a deployable policy engine.
