# syntax=docker/dockerfile:1.7
#
# Builds of Sliver: a native Windows build (cross-compiled, no GTK involved),
# Linux packages, and a Linux runtime image that shows the app through the
# host's X11 display.
#
# Windows (installer and portable .exe into ./out; run from any OS):
#   docker build --target windows -o out .
#
# Linux packages (.deb and .rpm) into ./out:
#   docker build --target bundles -o out .
#
# Linux runtime image (Linux host with X11 or XWayland):
#   docker build -t sliver .
#   xhost +local:
#   docker run --rm -e DISPLAY -v /tmp/.X11-unix:/tmp/.X11-unix \
#     -v sliver-config:/home/sliver/.config -v "$PWD/vault":/vault sliver
#
# With P2P sync: add --build-arg FEATURES=sync.

ARG RUST_VERSION=1.99
ARG NODE_VERSION=24
ARG DEBIAN=trixie

FROM node:${NODE_VERSION}-${DEBIAN}-slim AS node

FROM rust:${RUST_VERSION}-${DEBIAN} AS rust-node
ARG PNPM_VERSION=12.9.0
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && npm install -g pnpm@${PNPM_VERSION}

FROM rust-node AS sources
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=sliver-pnpm,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile
COPY . .

# ---- Windows -----------------------------------------------------------------

# cargo-xwin fetches the MSVC CRT and Windows SDK (accepting Microsoft's licence
# for them) and links with lld; NSIS makes the installer. Tauri on Windows uses
# the system's WebView2, so nothing GTK-related is built or shipped.
FROM rust-node AS windows-toolchain
ARG WINDOWS_TARGET=x86_64-pc-windows-msvc
RUN apt-get update && apt-get install -y --no-install-recommends \
      clang \
      lld \
      llvm \
      nsis \
    && rm -rf /var/lib/apt/lists/*
RUN --mount=type=cache,id=sliver-cargo-registry,target=/usr/local/cargo/registry \
    rustup target add ${WINDOWS_TARGET} \
    && cargo install --locked cargo-xwin

FROM windows-toolchain AS windows-build
ARG FEATURES=""
ARG WINDOWS_TARGET=x86_64-pc-windows-msvc
COPY --from=sources /src /src
WORKDIR /src
RUN --mount=type=cache,id=sliver-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=sliver-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=sliver-xwin,target=/root/.cache/cargo-xwin \
    --mount=type=cache,id=sliver-target-windows,target=/src/target \
    pnpm tauri build --ci --runner cargo-xwin --target ${WINDOWS_TARGET} --bundles nsis \
      ${FEATURES:+--features $FEATURES} \
    && mkdir -p /out \
    && cp target/${WINDOWS_TARGET}/release/bundle/nsis/*.exe /out/ \
    && cp target/${WINDOWS_TARGET}/release/sliver.exe /out/sliver-portable.exe

FROM scratch AS windows
COPY --from=windows-build /out/ /

# ---- Linux -------------------------------------------------------------------

FROM rust-node AS linux-toolchain
RUN apt-get update && apt-get install -y --no-install-recommends \
      libwebkit2gtk-4.1-dev \
      libayatana-appindicator3-dev \
      librsvg2-dev \
      libxdo-dev \
      libssl-dev \
      build-essential \
      file \
      rpm \
    && rm -rf /var/lib/apt/lists/*

FROM linux-toolchain AS build
ARG FEATURES=""
COPY --from=sources /src /src
WORKDIR /src
# The target dir is a cache mount, so the bundles are copied out in the same step.
RUN --mount=type=cache,id=sliver-cargo-registry,target=/usr/local/cargo/registry \
    --mount=type=cache,id=sliver-cargo-git,target=/usr/local/cargo/git \
    --mount=type=cache,id=sliver-target,target=/src/target \
    pnpm tauri build --ci --bundles deb,rpm ${FEATURES:+--features $FEATURES} \
    && mkdir -p /out \
    && cp target/release/bundle/deb/*.deb target/release/bundle/rpm/*.rpm /out/

FROM scratch AS bundles
COPY --from=build /out/ /

# Last, so a plain `docker build` still gives the Linux runtime image.
FROM debian:${DEBIAN}-slim AS runtime
COPY --from=build /out/*.deb /tmp/
# The .deb declares the WebKitGTK runtime libraries; fonts and icons are for GTK's
# own UI (dialogs), since the previews use Typst's embedded fonts.
RUN apt-get update && apt-get install -y --no-install-recommends \
      /tmp/*.deb \
      fonts-dejavu-core \
      adwaita-icon-theme \
      dbus-x11 \
    && rm -rf /var/lib/apt/lists/* /tmp/*.deb \
    && useradd --create-home --uid 1000 sliver \
    && mkdir -p /vault && chown sliver:sliver /vault

# WebKitGTK's GPU paths need a DRI device a container usually lacks.
ENV WEBKIT_DISABLE_DMABUF_RENDERER=1 \
    WEBKIT_DISABLE_COMPOSITING_MODE=1 \
    NO_AT_BRIDGE=1

USER sliver
WORKDIR /home/sliver
VOLUME ["/vault"]
CMD ["dbus-launch", "--exit-with-session", "sliver"]
