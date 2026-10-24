# The push relay (docs/push.md), as the image ghcr.io/<owner>/nudge-relay that release.yml pushes.
# Built from the repository's root:
#   docker build -f packages/relay/Dockerfile .
# Its data is in /data: relay.json, the APNs key and Firebase service account it names, and the
# relay-handle.key it makes on first start. packages/relay/deploy puts Caddy in front of it for TLS.
# The bundle is the same on every architecture, so it is built once, on the builder's own.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /src
COPY . .
# The relay bundles into one file, with what it runs on and nothing of @nudge/core.
RUN pnpm install --frozen-lockfile --filter @nudge/relay && pnpm -C packages/relay bundle

FROM node:24-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir /data && chown node:node /data
COPY --from=build /src/packages/relay/dist/bundle/ /opt/nudge-relay/
USER node
WORKDIR /data
VOLUME /data
EXPOSE 8790
ENTRYPOINT ["/usr/bin/tini", "--", "node", "/opt/nudge-relay/nudge-relay.mjs"]
CMD ["--config", "/data/relay.json", "--host", "0.0.0.0"]
