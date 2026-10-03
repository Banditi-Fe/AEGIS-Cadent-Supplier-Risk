# Operations

## Run in a container
```bash
docker build -t aegis-ai-engine .
docker run --rm -p 4100:4100 \
  -e AI_ENGINE_SHARED_SECRET=... -e CORE_API_SERVICE_KEY=... \
  -e CORE_API_BASE_URL=http://core:4000 -e OLLAMA_BASE_URL=http://ollama:11434 \
  -e NODE_ENV=production aegis-ai-engine
```
The image runs as non-root, has a `/health` HEALTHCHECK, contains no secrets. Use `/ready` (with `READY_REQUIRES_CORE_API=true`, `READY_REQUIRES_OLLAMA=true`) as the orchestrator readiness probe and `/health` as liveness.

## CI
`.github/workflows/ci.yml`: on every push/PR → `pnpm install --frozen-lockfile`, `typecheck`, `build`, `test` on Node **22.12.0 and 24**, offline evaluation, and a Docker build. (The Node 24 job is what verifies the "Node 24+ compatible" requirement; check its first run.)

## Metrics (`GET /metrics`, header `X-Service-Key`)
| Metric | Meaning |
|---|---|
| `aegis_ai_analyses_total{status}` | COMPLETED / DEGRADED / FAILED |
| `aegis_ai_degraded_total{reason}` | why runs were DEGRADED (LLM_TIMEOUT, LLM_UNAVAILABLE, …) |
| `aegis_ai_fallback_total` | runs answered by the deterministic fallback |
| `aegis_ai_llm_calls_total`, `_retries_total`, `_repairs_total` | model usage |
| `aegis_ai_tool_failures_total` | failed Core API reads |
| `aegis_ai_rejected_total{reason}` | 429s (`org_rate_limit`, `concurrency`) |
| `aegis_ai_errors_total{code}` | FAILED runs by error code |
| `aegis_ai_analysis_duration_ms`, `aegis_ai_llm_latency_ms` | latency histograms |
| `aegis_ai_in_flight` | analyses running now |

Suggested alerts: `% DEGRADED` (DEGRADED / total) > 20 % for 10 min → model too slow or down (re-run `pnpm measure:latency`); `fallback_total` rising with `LLM_TIMEOUT` → raise `AI_REQUEST_TIMEOUT_MS`; any `ANALYSIS_TIMEOUT`; sustained `rejected_total` → capacity.

## Choosing the timeouts (backlog A12)
Run `pnpm measure:latency` on the production machine. It prints the measured p50/p95 per evidence size and the suggested `AI_REQUEST_TIMEOUT_MS` (worst p95 + 25 %) and `AI_TOTAL_TIMEOUT_MS` (3 × request + 5 s). The default 8 s has **not** been measured on CPU-only Ollama.

## Key rotation
1. Inbound: set `AI_ENGINE_SHARED_SECRET_PREVIOUS=<old>`, `AI_ENGINE_SHARED_SECRET=<new>`, redeploy; switch Core API to the new key; remove `..._PREVIOUS`, redeploy.
2. Outbound: Core API accepts old+new `CORE_API_SERVICE_KEY`; deploy the new value here; Core API drops the old one.

## Known operational limits
- The per-organization limiter and metrics are in-memory, per replica.
- `/metrics` is not a replacement for tracing; logs carry `requestId`, `agentRunId`, `caseId`.
