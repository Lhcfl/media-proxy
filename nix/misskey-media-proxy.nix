{ ... }:
{
  perSystem =
    { pkgs, ... }:
    let
      lib = pkgs.lib;
      version = (lib.importJSON ../package.json).version;

      bun = pkgs.bun;
      # Node.js + node-gyp are only used to compile sharp's native addon
      # against the libvips from nixpkgs. Anything recent works (sharp uses the
      # stable Node-API), so use the default Node.js which is in the binary
      # cache. The server itself runs on Bun.
      nodejs = pkgs.nodejs;
      nodeGyp = pkgs.node-gyp.override { inherit nodejs; };

      # node_modules, installed once as a fixed-output derivation so the main
      # build is offline. `copyfile` avoids symlinks into Bun's cache, which a
      # fixed-output derivation may not reference.
      bunDeps = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "misskey-media-proxy-node-modules";
        inherit version;
        src = lib.fileset.toSource {
          root = ../.;
          fileset = lib.fileset.unions [
            ../package.json
            ../bun.lock
          ];
        };

        nativeBuildInputs = [ bun ];
        impureEnvVars = [
          "http_proxy"
          "https_proxy"
          "HTTP_PROXY"
          "HTTPS_PROXY"
          "no_proxy"
          "NO_PROXY"
        ];

        outputHashMode = "recursive";
        outputHashAlgo = "sha256";
        # Reset to lib.fakeHash, build, and copy the hash from the error.
        outputHash = "sha256-wc0IPjKt6Yn5puK0Qqm/+DPQy1Bb7uncFeWedwYMP/A=";

        buildCommand = ''
          export HOME=$TMPDIR
          cp -r --no-preserve=mode $src/. .
          # --omit=optional skips sharp's prebuilt @img/* binaries; the add-on
          # is built from source below.
          bun install --frozen-lockfile --ignore-scripts --no-progress \
            --backend=copyfile --omit=optional
          mkdir -p $out
          cp -r node_modules $out/node_modules
        '';
      });

      # Everything the server needs at runtime, plus the sources.
      src = lib.fileset.toSource {
        root = ../.;
        fileset = lib.fileset.unions [
          ../src
          ../assets
          ../package.json
          ../bun.lock
          ../tsconfig.json
          ../start.ts
        ];
      };

      misskey-media-proxy = pkgs.stdenv.mkDerivation (finalAttrs: {
        pname = "misskey-media-proxy";
        inherit src version;

        __structuredAttrs = true;
        strictDeps = true;

        nativeBuildInputs = [
          bun
          nodejs
          pkgs.pkg-config
          pkgs.python3
          nodeGyp
          pkgs.makeWrapper
        ];

        buildInputs = [ pkgs.vips ];

        configurePhase = ''
          cp -r ${bunDeps}/node_modules .
          # node_modules comes from a read-only store path; make it writable so
          # node-gyp can create sharp/src/build.
          chmod -R u+w node_modules
        '';

        preBuild = ''
          # sharp has no install script, so build the native add-on ourselves
          # against the libvips provided by Nix.
          sharpDir=$(readlink -f node_modules/sharp)
          ( cd "$sharpDir" && SHARP_FORCE_GLOBAL_LIBVIPS=1 node-gyp rebuild --directory=src )
        '';

        buildPhase = ''
          runHook preBuild
          # Drop the dev-only type packages now that sharp is built.
          rm -rf node_modules/@types node_modules/typescript
          find node_modules -xtype l -delete
          runHook postBuild
        '';

        installPhase = ''
          runHook preInstall

          mkdir -p $out/lib/misskey-media-proxy
          cp -r src start.ts package.json node_modules assets \
            $out/lib/misskey-media-proxy/

          mkdir -p $out/bin
          makeWrapper ${lib.getExe bun} $out/bin/misskey-media-proxy \
            --add-flags "$out/lib/misskey-media-proxy/start.ts" \
            --prefix LD_LIBRARY_PATH : "${lib.makeLibraryPath [ pkgs.vips pkgs.stdenv.cc.cc.lib ]}"
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
