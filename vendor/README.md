# Pinned local Forge service artifact

- Package: `@zihanw/pi-forge@0.5.3-hitch.1` (unpublished integration prerelease).
- Source repository: https://github.com/MacroSony/pi-forge (operator local branch
  `feat/hitch-mode-a-service`; this commit has not been pushed).
- Source commit: `06ae10a664bcfe734b3bca26f9f5f79dbc8bdaa0` (based on upstream 0.5.3 / `a5b0408`).
- Tarball: `zihanw-pi-forge-0.5.3-hitch.1.tgz`
- SHA-256: `fb0f2dfca4ed7faaf02ea3ef720ca07cb62259661be0eefc9a6138af31a6bdd9`
- npm SHA-512 integrity is recorded in `../package-lock.json`.
- MIT license is included in the package. Hitch imports only the intentional
  `/service` export, never the root Pi extension or private package submodules.

To reproduce from the indicated source commit: install the Forge development
lockfile, run `npm run build`, then `npm pack --ignore-scripts`. Copy the tarball
here and install it explicitly. The committed Hitch lockfile also passes clean
`npm ci --offline --ignore-scripts`; no existing Pi dependency version changed.

Source verification: `npm run verify` passed 372 unit tests, 21 browser tests,
typecheck, generated client/dist validation, docs, package layout, and packed
main-only runtime/type import tests. Optional subagent packed smoke was skipped
because the optional checkout was absent; Mode A does not use subagents.

Do not overwrite this tarball from an unrecorded worktree. An upstream published
service release can replace the local artifact in a separate reviewed update.
