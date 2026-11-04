# syntax=docker/dockerfile:1
# L2 image x402-l2-control (specs/011 research R14): the control service and the operator job.
#   node dist/src/layer2-control/service.js                         L2 (with the loopback proxy sidecar)
#   node dist/scripts/{approve,reject,escalations,ledger-verify}.js  operator job
# It holds only L2's code (src/layer2-control, src/shared, the operator scripts) and the packages that code
# imports: no agent framework or model SDK, no L3 verifier, no seller.
# scripts/image-closure.ts derives both from the import graph and fails the build when a file from another
# layer would be included. No key or env file is inside; each Container App or job gets its secrets as Key
# Vault references.
# Base: node:22-bookworm-slim, index digest pinned 2026-10-22 (Node >= 22.13 for Mastra).
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
# --ignore-scripts: the image's npm 10 would run native install scripts (ganache's ws helpers) that need a
# compiler; nothing the build or the runtime uses has an install script.
RUN npm install --no-audit --no-fund --ignore-scripts
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build && npx tsx scripts/image-closure.ts l2-control /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json lists only the packages this image's code imports; the lockfile pins their versions.
COPY --from=build /out/package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /out/dist ./dist
COPY config ./config
# The API-docs module resolves the OpenAPI file relative to itself (dist/src/layer2-control → dist/docs).
COPY docs/l2-control.openapi.yaml ./dist/docs/
# L2 mounts its NFS ledger share here (L2-6).
RUN mkdir -p /app/.local && chown node:node /app/.local
# Load every module once, so a file or package the closure missed fails the build instead of a revision.
RUN node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const m of JSON.parse(readFileSync('dist/image-modules.json', 'utf8'))) await import('/app/' + m);"
USER node
