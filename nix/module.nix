{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.misskey-media-proxy;

  # start.ts loads its configuration from MISSKEY_MEDIA_PROXY_CONFIG. Bun parses
  # TOML natively, so the module can generate a plain data file instead of
  # emitting JavaScript.
  configFile = (pkgs.formats.toml { }).generate "misskey-media-proxy-config.toml" cfg.settings;
in
{
  options.services.misskey-media-proxy = {
    enable = lib.mkEnableOption "Misskey media proxy";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The misskey-media-proxy package to use.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the server listens on.";
    };

    environmentFile = lib.mkOption {
      type = lib.types.nullOr lib.types.path;
      default = null;
      example = "/run/secrets/misskey-media-proxy.env";
      description = ''
        File containing extra environment variables (for example
        `HTTP_PROXY`) to pass to the service.
      '';
    };

    memoryMax = lib.mkOption {
      type = lib.types.nullOr lib.types.str;
      default = null;
      example = "1G";
      description = ''
        Optional systemd `MemoryMax=` for the service. Image conversion can
        spike while decoding, so this acts as a backstop.
      '';
    };

    settings = lib.mkOption {
      type = lib.types.toml;
      default = {
        userAgent = "MisskeyMediaProxy";
        allowedPrivateNetworks = [ ];
        maxSize = 262144000;
        "Access-Control-Allow-Origin" = "*";
        "Access-Control-Allow-Headers" = "*";
        "Content-Security-Policy" =
          "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
        maxConcurrentConversions = 4;
      };
      description = ''
        Contents of the generated TOML config (see `config.example.toml` in the
        repository). Values must be representable as TOML.
      '';
    };
  };

  config = lib.mkIf cfg.enable {
    systemd.services.misskey-media-proxy = {
      description = "Misskey Media Proxy";
      wantedBy = [ "multi-user.target" ];
      wants = [ "network-online.target" ];
      after = [ "network-online.target" ];

      environment = {
        PORT = toString cfg.port;
        MISSKEY_MEDIA_PROXY_CONFIG = configFile;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;

        DynamicUser = true;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;

        Restart = "on-failure";
        RestartSec = 5;

        MemoryMax = lib.mkIf (cfg.memoryMax != null) cfg.memoryMax;

        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictAddressFamilies = [
          "AF_INET"
          "AF_INET6"
          "AF_UNIX"
          # cacheable-lookup calls os.networkInterfaces() at startup, which uses
          # getifaddrs() -> a NETLINK_ROUTE socket. Without AF_NETLINK this fails
          # with "uv_interface_addresses returned Unknown system error 97"
          # (EAFNOSUPPORT) and the service crash-loops.
          "AF_NETLINK"
        ];
      };
    };
  };
}
