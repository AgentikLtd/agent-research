# Debian-slim, not Alpine — the fastembed native dep
# (@anush008/tokenizers) ships linux-x64-gnu only, no -musl variant
# in the published 0.0.0 lockfile. node:22-alpine triggers
# `Cannot find module '@anush008/tokenizers-linux-x64-musl'` at boot.
FROM node:22-slim AS build
RUN corepack enable
WORKDIR /app
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM node:22-slim
RUN corepack enable && apt-get update && apt-get install -y --no-install-recommends wget && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4003
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/manifest.yaml ./manifest.yaml
# Skill .md prompts (e.g. consolidate-prompt.md) are read at runtime from
# `dist/memory/...` paths; tsc doesn't copy non-TS assets so we mirror them
# here. Without this the consolidate-memories skill 500s at runtime.
COPY --from=build /app/src/memory/consolidate-prompt.md ./dist/memory/consolidate-prompt.md
EXPOSE 4003
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:4003/health || exit 1
CMD ["node", "dist/index.js"]
