# mkScooterTask: package a Python system task (a click command decorated with
# scooter_task.task) as `bin/<name>`, with scooter-lib and scooter-task included.
#
#   mkScooterTask {
#     name = "weekly-digest";
#     entry = "digest:main";          # "<module>:<the @task command>"
#     src = ./digest;                 # a directory put on sys.path, or
#     packages = [ myPythonPackage ]; # Python packages that provide the module
#     pythonDeps = ps: [ ps.pyyaml ];
#   }
#
# `lib.getExe` on the result is a valid `scooter.systemTasks.<id>.command`.
{ lib, python3, writeTextFile, scooter-lib, scooter-task }:

{ name, entry, src ? null, packages ? [ ], pythonDeps ? (_: [ ]) }:

let
  parts = lib.splitString ":" entry;
  module = builtins.head parts;
  attr = lib.last parts;
  python = python3.withPackages (ps: [ scooter-lib scooter-task ] ++ packages ++ pythonDeps ps);
in
assert lib.assertMsg (builtins.length parts == 2 && module != "" && attr != "")
  "mkScooterTask ${name}: entry must be \"<module>:<command>\", got \"${entry}\"";
writeTextFile {
  inherit name;
  destination = "/bin/${name}";
  executable = true;
  text = ''
    #!${python}/bin/python3
    import sys
    ${lib.optionalString (src != null) "sys.path.insert(0, ${builtins.toJSON "${src}"})"}
    from ${module} import ${attr} as command
    command(prog_name=${builtins.toJSON name})
  '';
  meta.mainProgram = name;
  # Fails the build, not the first scheduled run, when the entry does not import.
  checkPhase = ''
    $target --help > /dev/null
  '';
}
