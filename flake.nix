{
  description = "Sliver - a Typst notetaking app";
  inputs = {
    nixpkgs.url = "github:nixos/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };
  outputs =  { nixpkgs, flake-utils, rust-overlay, ... }: flake-utils.lib.eachDefaultSystem (system:
  let
    overlays = [ (import rust-overlay) ];
    pkgs = import nixpkgs {
      inherit system overlays;
    };
  in
  {
    packages.default = pkgs.callPackage ./nix/package.nix { };
    packages.sliver-sync = pkgs.callPackage ./nix/package.nix { withSync = true; };
    devShells.default = pkgs.mkShell {
      nativeBuildInputs = with pkgs; [ pkg-config ];
      buildInputs = with pkgs; [
        glib gtk3 webkitgtk_4_1 libsoup_3 cairo pango gdk-pixbuf atk librsvg openssl
      ];
      packages = with pkgs; [
        rust-bin.stable.latest.default
        nodejs_24
        pnpm
      ];
      shellHook = ''
        export XDG_DATA_DIRS=${pkgs.gsettings-desktop-schemas}/share/gsettings-schemas/${pkgs.gsettings-desktop-schemas.name}:${pkgs.gtk3}/share/gsettings-schemas/${pkgs.gtk3.name}:$XDG_DATA_DIRS
      '';
    };
  });
}
