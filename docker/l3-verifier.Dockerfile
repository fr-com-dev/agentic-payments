# syntax=docker/dockerfile:1
# L3 image x402-l3-verifier (specs/011 research R14): the settlement verifier.
#   node dist/src/layer3-settlement/service.js   L3 (with the loopback proxy sidecar)
# It holds only L3's code (src/layer3-settlement, src/shared) and the packages that code imports: no
# signer, no agent framework, no seller.
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
RUN npm run build && npx tsx scripts/image-closure.ts l3-verifier /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json lists only the packages this image's code imports; the lockfile pins their versions.
COPY --from=build /out/package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /out/dist ./dist
# Load every module once, so a file or package the closure missed fails the build instead of a revision.
RUN node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const m of JSON.parse(readFileSync('dist/image-modules.json', 'utf8'))) await import('/app/' + m);"
USER node
