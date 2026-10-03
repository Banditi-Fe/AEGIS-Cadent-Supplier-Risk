# syntax=docker/dockerfile:1
# AEGIS PAY - AI Engine. Build from the repository root:  docker build -t aegis-ai-engine .
ARG NODE_VERSION=22.12.0

FROM node:${NODE_VERSION}-slim AS build
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install -g pnpm@11.5.2
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY packages/contracts/ai/package.json packages/contracts/ai/
COPY packages/contracts/core/package.json packages/contracts/core/
COPY apps/core-api/package.json apps/core-api/
COPY apps/ai-engine/package.json apps/ai-engine/
RUN --mount=type=cache,id=pnpm,target=/pnpm/store pnpm install --frozen-lockfile
COPY packages packages
COPY apps apps
RUN pnpm --filter @aegis/contracts-ai build && pnpm --filter @aegis/ai-engine build
# Production dependencies only, with workspace packages materialised (no symlinks to the source tree).
RUN pnpm --filter @aegis/ai-engine deploy --prod --legacy /out && cp -r apps/ai-engine/dist /out/dist

FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production HOST=0.0.0.0 PORT=4100
WORKDIR /app
COPY --from=build --chown=node:node /out /app
USER node
EXPOSE 4100
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# Secrets (AI_ENGINE_SHARED_SECRET, CORE_API_SERVICE_KEY, ...) are injected at runtime, never baked into the image.
CMD ["node", "dist/server.js"]

