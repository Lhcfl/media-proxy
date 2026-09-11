{
  description = "The Media Proxy for Misskey (maintained fork) with a Nix flake";

  inputs = {
    flake-parts.url = "github:hercules-ci/flake-parts";
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  };

  outputs =
    inputs@{ self, flake-parts, ... }:
    flake-parts.lib.mkFlake { inherit inputs; } {
      imports = [
        ./nix/misskey-media-proxy.nix
      ];

      systems = [
        "x86_64-linux"
        "aarch64-linux"
        "aarch64-darwin"
        "x86_64-darwin"
      ];

      flake = {
        nixosModules.default =
          { pkgs, lib, ... }:
          {
            imports = [ ./nix/module.nix ];

            services.misskey-media-proxy.package =
              lib.mkDefault
                self.packages.${pkgs.stdenv.hostPlatform.system}.default;
          };

        nixosModules.misskey-media-proxy = self.nixosModules.default;
      };
    };
}
