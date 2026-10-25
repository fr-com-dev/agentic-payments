# syntax=docker/dockerfile:1
# One image for every process (specs/011 research R14). It holds no key or env file; each Container App
# sets its own command and gets its secrets as Key Vault references:
#   node dist/src/hosted-main.js                     hosted agent service (L1-6)
#   node dist/src/layer2-control/service.js          L2 control (with the loopback proxy sidecar)
#   node dist/src/layer3-settlement/service.js       L3 verifier (with the loopback proxy sidecar)
#   node dist/src/counterparty/seller.js             demo seller
#   node dist/src/main.js --scripted --check-baseline   post-deployment regression job
#   node dist/scripts/{approve,reject,escalations,ledger-verify}.js   operator job
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
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production MASTRA_TELEMETRY_DISABLED=1
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /app/dist ./dist
COPY config ./config
# The API-docs module resolves the OpenAPI file relative to itself (dist/src/layer2-control → dist/docs).
COPY docs ./dist/docs
# L2 mounts its NFS ledger share here (L2-6); everything else leaves it empty.
RUN mkdir -p /app/.local && chown node:node /app/.local
USER node
