# Build context MUST be the repo root (see docker-compose.yml): this is an npm
# workspace, so the only lockfile is the root one, and the web app compiles
# @apexops/shared from source.

FROM node:25-bookworm-slim AS build
WORKDIR /repo
# Every workspace manifest: `npm ci` checks the lockfile against all of them.
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY app/client/package.json app/client/
COPY app/server/package.json app/server/
COPY app/extension/package.json app/extension/
RUN npm ci --workspace app/client --workspace packages/shared --ignore-scripts
COPY packages/shared packages/shared
COPY app/client app/client
ARG VITE_API_URL
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build --workspace app/client

FROM nginx:1.27-alpine AS run
COPY --from=build /repo/app/client/dist /usr/share/nginx/html
COPY app/client/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
HEALTHCHECK --interval=10s --timeout=3s --retries=6 CMD wget -q -O /dev/null http://127.0.0.1/apexops.json || exit 1
CMD ["nginx", "-g", "daemon off;"]
