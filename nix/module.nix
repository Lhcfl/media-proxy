{
  config,
  lib,
  pkgs,
  ...
}:

let
  cfg = config.services.misskey-media-proxy;

  # start.js reads the media-proxy options from config.js. Generate it from the
  # `settings` option and point the service at it.
  configFile = pkgs.writeText "misskey-media-proxy-config.js" ''
    export default ${builtins.toJSON cfg.settings};
  '';
in
{
  options.services.misskey-media-proxy = {
    enable = lib.mkEnableOption "Misskey media proxy";

    package = lib.mkOption {
      type = lib.types.package;
      description = "The misskey-media-proxy package to use.";
    };

    host = lib.mkOption {
      type = lib.types.str;
      default = "127.0.0.1";
      example = "0.0.0.0";
      description = "Address the server listens on.";
    };

    port = lib.mkOption {
      type = lib.types.port;
      default = 3000;
      description = "Port the server listens on.";
    };

    openFirewall = lib.mkOption {
      type = lib.types.bool;
      default = false;
      description = "Open {option}`port` in the firewall.";
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

    settings = lib.mkOption {
      type = lib.types.attrsOf lib.types.anything;
      default = {
        userAgent = "MisskeyMediaProxy";
        allowedPrivateNetworks = [ ];
        maxSize = 262144000;
        "Access-Control-Allow-Origin" = "*";
        "Access-Control-Allow-Headers" = "*";
        "Content-Security-Policy" =
          "default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'";
      };
      description = ''
        Contents of `config.js` as a Nix attribute set. See the upstream
        README for the supported options.
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
        HOST = cfg.host;
        PORT = toString cfg.port;
        MISSKEY_MEDIA_PROXY_CONFIG = configFile;
      };

      serviceConfig = {
        ExecStart = lib.getExe cfg.package;

        DynamicUser = true;
        EnvironmentFile = lib.mkIf (cfg.environmentFile != null) cfg.environmentFile;

        Restart = "on-failure";
        RestartSec = 5;

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
        ];
      };
    };

    networking.firewall.allowedTCPPorts = lib.mkIf cfg.openFirewall [ cfg.port ];
  };
}
