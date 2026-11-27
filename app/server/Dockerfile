# Build context MUST be the repo root (see docker-compose.yml): this is an npm
# workspace, so the only lockfile is the root one, and the Prisma schema lives at
# database/prisma/. The image mirrors the monorepo layout so the package.json
# `prisma.schema` path resolves in-container exactly as in dev.
#
# Targets: `run` (default) is the API. `migrate` applies database migrations and
# exits; it keeps the Prisma CLI, which the API image does not carry.

FROM node:22-bookworm-slim AS base
# Prisma picks its engine by the OpenSSL it finds, at generate and at run time.
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /repo
# Every workspace manifest: `npm ci` checks the lockfile against all of them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY app/client/package.json app/client/
COPY app/server/package.json app/server/
COPY app/extension/package.json app/extension/

FROM base AS build
RUN npm ci --workspace app/server --ignore-scripts
COPY database/prisma database/prisma
COPY app/server app/server
RUN npm run db:generate --workspace app/server && npm run build --workspace app/server

FROM build AS migrate
WORKDIR /repo/app/server
USER node
CMD ["npx", "--no-install", "prisma", "migrate", "deploy"]

FROM base AS run
ENV NODE_ENV=production
RUN npm ci --workspace app/server --omit=dev --ignore-scripts && npm cache clean --force
# The generated Prisma Client, from the build stage.
COPY --from=build /repo/node_modules/.prisma node_modules/.prisma
COPY --from=build /repo/app/server/dist app/server/dist
# /sdk/v1.js and the other static files the API serves.
COPY app/server/public app/server/public
WORKDIR /repo/app/server
USER node
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=6 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(b=>process.exit(b.database==='connected'?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
