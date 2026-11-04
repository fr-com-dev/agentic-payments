# syntax=docker/dockerfile:1
# L1 image x402-l1-agent (specs/011 research R14): the hosted agent service and the regression job.
#   node dist/src/hosted-main.js                       hosted agent service (L1-6)
#   node dist/src/main.js --scripted --check-baseline  post-deployment regression job (L1-4)
# It holds only L1's code (src/layer1-intent, src/shared, the two entry points) and the packages that code
# imports: no signer, no L3 verifier, no seller.
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
RUN npm run build && npx tsx scripts/image-closure.ts l1-agent /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production MASTRA_TELEMETRY_DISABLED=1
WORKDIR /app
# package.json lists only the packages this image's code imports; the lockfile pins their versions.
COPY --from=build /out/package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /out/dist ./dist
# The API-docs module resolves the OpenAPI file relative to itself (dist/src/layer1-intent/hosted → dist/docs).
# It's read only with API_DOCS=1, which the Azure deployment never sets.
COPY docs/l1-hosted.openapi.yaml ./dist/docs/
# Load every module once, so a file or package the closure missed fails the build instead of a revision.
RUN node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const m of JSON.parse(readFileSync('dist/image-modules.json', 'utf8'))) await import('/app/' + m);"
USER node
