# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN apk add --no-cache python3 make g++ && pnpm install --frozen-lockfile
RUN pnpm build
RUN pnpm --filter @ram-coffers-uplink/relay-server deploy --legacy --prod /out

FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
COPY --from=build /app/apps/relay/web/dist ./web-dist
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown -R app:app /data /app
USER app
ARG VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ARG BUILT_AT=unknown
ENV VERSION=$VERSION GIT_SHA=$GIT_SHA BUILT_AT=$BUILT_AT \
    PORT=8080 DATABASE_PATH=/data/relay.db WEB_ROOT=/app/web-dist
LABEL org.opencontainers.image.source="https://github.com/symphonic-navigator/ram-coffers-uplink" \
      org.opencontainers.image.version=$VERSION \
      org.opencontainers.image.revision=$GIT_SHA \
      org.opencontainers.image.created=$BUILT_AT
EXPOSE 8080
VOLUME ["/data"]
CMD ["node", "dist/index.js"]
