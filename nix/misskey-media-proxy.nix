{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      lib = pkgs.lib;
      version = (lib.importJSON ../package.json).version;

      nodejs = pkgs.nodejs_24;
      # node-gyp wrapper that uses the local Node.js headers (no download).
      nodeGyp = pkgs.node-gyp.override { inherit nodejs; };
      pnpm = pkgs.pnpm_10;

      # Everything the TypeScript build and pnpm install need. Keeping this
      # explicit means the flake files themselves are not part of src.
      src = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../src
          ../assets
          ../package.json
          ../pnpm-lock.yaml
          ../tsconfig.json
          ../server.js
          ../start.js
        ];
      };

      misskey-media-proxy = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "misskey-media-proxy";
        inherit src version;

        __structuredAttrs = true;
        strictDeps = true;

        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs)
            pname
            version
            src
            pnpmInstallFlags
            ;
          inherit pnpm;
          fetcherVersion = 4;
          # Set to lib.fakeHash, build, and copy the correct hash from the
          # error log whenever pnpm-lock.yaml changes.
          hash = "sha256-gJ3nDlrdUq/uk84CL27mqtcThQs9qlO/HqGPYX/6RZQ=";
        };

        # sharp ships prebuilt binaries as optionalDependencies, but the
        # add-on is built from source against the libvips from nixpkgs.
        pnpmInstallFlags = [ "--no-optional" ];

        nativeBuildInputs = [
          nodejs
          pnpm
          pkgs.pnpmConfigHook
          pkgs.pkg-config
          pkgs.python3
          nodeGyp
          pkgs.makeWrapper
        ];

        buildInputs = [ pkgs.vips ];

        preBuild = ''
          # pnpmConfigHook installs with --ignore-scripts, and sharp has no
          # install script anyway. Build the native add-on ourselves so it
          # links against the libvips provided by Nix.
          sharpDir=$(readlink -f node_modules/sharp)
          ( cd "$sharpDir" && SHARP_FORCE_GLOBAL_LIBVIPS=1 node-gyp rebuild --directory=src )
        '';

        buildPhase = ''
          runHook preBuild
          pnpm run build
          # Drop devDependencies. optional=false keeps prune from trying to
          # fetch the @img/sharp-* prebuilts (there is no network in the sandbox).
          npm_config_optional=false pnpm prune --prod
          # pnpm with optional=false leaves dangling symlinks for the skipped
          # @img/sharp-* prebuilts; drop them so the fixup check passes.
          find node_modules -xtype l -delete
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/lib/misskey-media-proxy
          cp -r built start.js server.js package.json node_modules assets \
            $out/lib/misskey-media-proxy/

          mkdir -p $out/bin
          makeWrapper ${lib.getExe nodejs} $out/bin/misskey-media-proxy \
            --add-flags "$out/lib/misskey-media-proxy/start.js"

          runHook postInstall
        '';

        meta = {
          description = "The Media Proxy for Misskey (maintained fork)";
          homepage = "https://github.com/misskey-dev/media-proxy";
          license = lib.licenses.agpl3Plus;
          mainProgram = "misskey-media-proxy";
          platforms = lib.platforms.unix;
        };
      });
    in
    {
      packages.default = misskey-media-proxy;
      packages.misskey-media-proxy = misskey-media-proxy;

      apps.default = {
        type = "app";
        program = lib.getExe misskey-media-proxy;
      };
    };
}
