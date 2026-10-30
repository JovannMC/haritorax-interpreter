
{
  description = "haritorax-interpreter development environment";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs";

  outputs = { self, nixpkgs }:
    let
      systems = [
        "x86_64-linux"
        "aarch64-linux"
      ];
    in
    {
      devShells = nixpkgs.lib.genAttrs systems (system:
        let
          pkgs = import nixpkgs { inherit system; };

          python = pkgs.python311.withPackages (ps: [
            ps.setuptools
          ]);

          nativeLibraries = with pkgs; [
            bluez
            libusb1
            udev
          ];

        in
        {
          default = pkgs.mkShell {
            name = "haritorax-interpreter-dev";

            packages = with pkgs; [
              nodejs_24
              corepack_24

              python

              stdenv.cc
              gnumake
              pkg-config
            ];

            buildInputs = with pkgs; [
              bluez
              dbus
              libusb1
              udev
            ];

            LD_LIBRARY_PATH =
              pkgs.lib.makeLibraryPath nativeLibraries;

            PYTHON = "${python}/bin/python3";
            npm_config_python = "${python}/bin/python3";
          };
        });
    };
}
