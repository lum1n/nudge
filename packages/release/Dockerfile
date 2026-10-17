# A Nudge server (ADR 11), built from the release archives bundle.sh makes:
#   linux-amd64.tar.gz and linux-arm64.tar.gz in the build context.
# The data, releases included, is in /data. The server updates itself there, so a newer image is
# only needed for a newer launcher; nudge-server takes the image's release when it is newer.
FROM debian:bookworm-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin nudge \
  && mkdir /data && chown nudge:nudge /data

ARG TARGETOS
ARG TARGETARCH
ADD ${TARGETOS}-${TARGETARCH}.tar.gz /opt/
RUN mv /opt/nudge-*-linux-* /opt/nudge \
  && printf '#!/bin/sh\nrelease=/data/releases/current\n[ -x "$release/bin/nudge" ] || release=/opt/nudge\nexec "$release/bin/nudge" "$@"\n' \
    >/usr/local/bin/nudge \
  && chmod +x /usr/local/bin/nudge

USER nudge
ENV NUDGE_HOME=/data
VOLUME /data
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/nudge/bin/nudge-server"]
CMD ["--host", "0.0.0.0"]
