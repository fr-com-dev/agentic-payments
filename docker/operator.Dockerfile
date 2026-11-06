# syntax=docker/dockerfile:1
# Operator image x402-operator (specs/011 research R14): the operator job, deployed by deploy-operator.yml.
#   node dist/scripts/ledger-verify.js                      its own command (what the pipelines start)
#   node dist/scripts/{approve,reject,escalations}.js       an operator's start overrides it (quickstart §5)
# It holds only the operator scripts and src/shared: they call L2's operator routes over HTTP with
# OPERATOR_TOKEN, so the image has no L2 code, no signer, no agent framework and no seller.
# scripts/image-closure.ts derives both from the import graph and fails the build when a file from a layer
# would be included. No key or env file is inside; the job gets its token as a Key Vault reference.
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
RUN npm run build && npx tsx scripts/image-closure.ts operator /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json lists only the packages this image's code imports; the lockfile pins their versions.
COPY --from=build /out/package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /out/dist ./dist
# Load every module once, so a file or package the closure missed fails the build instead of a job execution.
RUN node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const m of JSON.parse(readFileSync('dist/image-modules.json', 'utf8'))) await import('/app/' + m);"
USER node
