# Safety boundaries

- Synthetic records and estimates are clearly labeled; no Cadent data, endorsement or connection is claimed.
- Missing risk feeds are `UNKNOWN`, never interpreted as low risk.
- Supplier notices and other free text are untrusted data. Instruction-like text is withheld before it reaches the AI prompt.
- AI Engine has a GET-only Core API client. It cannot decide authorization, change policy, approve or execute.
- Model output is strictly parsed and cross-checked against feasible option IDs and evidence IDs supplied by Core API.
- Infeasible alternate sourcing and work rescheduling remain blocked when qualification, work-order or safety evidence is missing.
- Transfer/expedite decisions require human approval in the demo policy. The “auto” path is limited to monitoring and only records simulated state.
- Failed AI calls use a deterministic degraded assessment and are not treated as model success.
- Demo role keys and in-memory controls are not production authentication or authorization.
- The Ariba adapter is simulated and disconnected; no real transaction can be executed.
