# syntax=docker/dockerfile:1
# Portal image x402-portal (specs/013 research R16): the portal, deployed by deploy-portal.yml.
#   node dist/src/portal-main.js   the portal's API and the web app's static files (L2-8), on 4025
# It holds only the portal's code (src/portal, src/shared, its entry point), the packages that code imports,
# and the built web app (dist/portal-web): no layer, no signer, no agent framework, no seller. React and the
# web app's other packages are devDependencies that Vite bundles in the build stage; none is installed here.
# scripts/image-closure.ts derives the code and its packages from the import graph and fails the build when a
# file from a layer would be included. No key or env file is inside; the Container App gets its secrets as
# Key Vault references.
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
COPY web ./web
RUN npm run build && npm run build:web && npx tsx scripts/image-closure.ts portal /out

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
# package.json lists only the packages this image's code imports; the lockfile pins their versions.
COPY --from=build /out/package.json ./
COPY package-lock.json ./
RUN npm install --omit=dev --no-audit --no-fund --ignore-scripts && npm cache clean --force
COPY --from=build /out/dist ./dist
# The web app, built by Vite: the portal serves it from dist/portal-web (PORTAL_WEB_ROOT's default).
COPY --from=build /app/dist/portal-web ./dist/portal-web
# The API-docs module resolves the OpenAPI file relative to itself (dist/src/portal → dist/docs).
# It's read only with API_DOCS=1, which the Azure deployment never sets.
COPY docs/portal.openapi.yaml ./dist/docs/
# The portal mounts its NFS profiles share here (PROFILE_DIR is a folder inside it).
RUN mkdir -p /app/.local/portal && chown node:node /app/.local/portal
# Load every module once, so a file or package the closure missed fails the build instead of a revision.
RUN node --input-type=module -e "import { readFileSync } from 'node:fs'; for (const m of JSON.parse(readFileSync('dist/image-modules.json', 'utf8'))) await import('/app/' + m);"
USER node
