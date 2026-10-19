# A Nudge server (ADR 11), built from the release archives bundle.sh makes:
#   linux-amd64.tar.gz and linux-arm64.tar.gz in the build context.
# The data, releases included, is in /data. The server updates itself there, so a newer image is
# only needed for a newer launcher; nudge-server takes the image's release when it is newer.
FROM debian:bookworm-slim

# Besides certificates and tini: what the browser extension's Chromium needs, as Playwright lists
# it for Debian 12, and Xvfb, the virtual display it runs headed on. Chromium itself is downloaded
# the first time a room browses, into /data.
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates tini \
    xvfb xfonts-scalable fonts-liberation fonts-noto-color-emoji fonts-unifont fonts-ipafont-gothic \
    fonts-wqy-zenhei fonts-tlwg-loma-otf fonts-freefont-ttf libfontconfig1 libfreetype6 \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libatspi2.0-0 libcairo2 libcups2 libdbus-1-3 \
    libdrm2 libgbm1 libglib2.0-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libxcb1 \
    libxcomposite1 libxdamage1 libxext6 libxfixes3 libxkbcommon0 libxrandr2 \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --system --uid 1000 --home-dir /data --shell /usr/sbin/nologin nudge \
  && mkdir /data && chown nudge:nudge /data

# The desktop extension's: D-Bus and AT-SPI, through which it reads and drives the apps, bubblewrap,
# which sandboxes them, and the apps it finds by itself, LibreOffice Writer and Calc on their Qt 6
# backend (on GTK 3 LibreOffice aborts when its windows are read), from bookworm-backports.
RUN echo 'deb http://deb.debian.org/debian bookworm-backports main' \
    >/etc/apt/sources.list.d/backports.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends dbus-daemon at-spi2-core bubblewrap \
  && apt-get install -y --no-install-recommends -t bookworm-backports \
    libreoffice-writer libreoffice-calc libreoffice-qt6 \
  && rm -rf /var/lib/apt/lists/*

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
