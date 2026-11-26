{
  lib,
  rustPlatform,
  cargo-tauri,
  nodejs_24,
  pnpm_10,
  fetchPnpmDeps,
  pnpmConfigHook,
  pkg-config,
  wrapGAppsHook3,
  glib,
  gtk3,
  webkitgtk_4_1,
  libsoup_3,
  glib-networking,
  openssl,
  librsvg,
  withSync ? false,
}:

rustPlatform.buildRustPackage (finalAttrs: {
  pname = "sliver";
  version = "0.1.0";

  src = lib.cleanSource ../.;

  cargoLock.lockFile = ../Cargo.lock;

  pnpmDeps = fetchPnpmDeps {
    inherit (finalAttrs) pname version src;
    pnpm = pnpm_10;
    fetcherVersion = 5;
    hash = "sha256-jB/zAcIoFkq7OBYV1V2Oi03g2cO1BF59Rq8USjlgbmY="; # replace after the first build
  };

  nativeBuildInputs = [
    cargo-tauri.hook
    nodejs_24
    pnpm_10
    pnpmConfigHook
    pkg-config
    wrapGAppsHook3
  ];

  buildInputs = [
    glib
    gtk3
    webkitgtk_4_1
    libsoup_3
    glib-networking # TLS for the webview's package downloads
    openssl
    librsvg
  ];

  # tauri.conf.json lives here; Cargo.lock is at the workspace root
  buildAndTestSubdir = "src-tauri";

  buildFeatures = lib.optional withSync "sync";

  doCheck = false;

  meta = {
    description = "A Typst-based Zettelkasten notetaking app";
    mainProgram = "sliver";
    platforms = lib.platforms.linux;
  };
})
