# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
# Build tools are needed because the workspace-wide install compiles
# better-sqlite3 (a relay-server dependency) from source.
RUN apk add --no-cache python3 make g++ && pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @ram-coffers-uplink/sidecar deploy --legacy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app
ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV VERSION=$VERSION GIT_SHA=$GIT_SHA BUILT_AT=$BUILT_AT
LABEL org.opencontainers.image.source="https://github.com/symphonic-navigator/ram-coffers-uplink" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.created=$BUILT_AT
CMD ["node", "dist/index.js"]
