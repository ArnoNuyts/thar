# Releasing

## Branch model

```text
feature/* --PR--> release/next --merge--> beta release
release/next --PR--> main      --merge--> stable release
hotfix -----PR--> main         --merge--> stable patch --> back-merge to release/next
```

Both `main` and `release/next` are protected. Changes arrive through pull
requests only.

## Versions

- Stable: `v<package.json version>` (for example `v0.5.0`), npm tag `latest`.
- Beta: `<package.json version>-beta.<run_number>` (for example
  `0.5.0-beta.42`), npm tag `next`, GitHub prerelease.

Every merge to `main` must bump `package.json` to a new stable version. The
`version-guard` CI job rejects an unchanged or prerelease version.

After a stable release, back-merge `main` into `release/next` and bump the base
version there before the next beta cycle.

## Workflow

`.github/workflows/release.yml` runs on pushes to `main` and `release/next`:

1. `verify` calls the CI workflow.
2. `publish` creates the tag, publishes to npm, and creates or updates the
   GitHub release notes.
3. `native` builds `thar-rs` on each supported host and attaches the archives
   to that GitHub release:

   | Asset                     | Host               |
   | ------------------------- | ------------------ |
   | `thar-linux-x64.tar.gz`   | `ubuntu-22.04`     |
   | `thar-linux-arm64.tar.gz` | `ubuntu-22.04-arm` |
   | `thar-macos-x64.tar.gz`   | `macos-15-intel`   |
   | `thar-macos-arm64.tar.gz` | `macos-15`         |
   | `thar-windows-x64.zip`    | `windows-latest`   |

   Each archive contains `thar-rs`, `README.md` and `LICENSE`, plus a matching
   `.sha256` file. Linux binaries target glibc 2.35 from the 22.04 runner.
   macOS binaries are not code-signed or notarized yet (CP8); after downloading
   one, clear the quarantine attribute or build from source.

The publish job is idempotent: if the npm version already exists, it skips.
Native builds run for a fresh release and can be re-run for an existing tag to
rebuild or re-attach assets; they never block npm publication because they
start after `publish` finishes.

## First publish

The first npm publish needs a granular npm token with publish rights. Add it as
the `NPM_TOKEN` repository secret, run a beta or stable release, then configure
[trusted publishing](https://docs.npmjs.com/trusted-publishers) on npmjs.com:

- Repository: `ArnoNuyts/thar`
- Workflow: `release.yml`
- Environment: `npm`

After trusted publishing works, delete `NPM_TOKEN`; the workflow keeps
publishing from GitHub Actions with `id-token: write`.

## Dry run

Merge a small change into `release/next`, then verify:

```sh
npm view @arnoarnoarno/thar dist-tags
npm install -g @arnoarnoarno/thar@next
thar --version
```

Then promote `release/next` to `main` and repeat with `latest`.
