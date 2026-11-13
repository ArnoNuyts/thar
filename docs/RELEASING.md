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
2. `build` creates the five single-file executables.
3. `publish` creates the tag, publishes to npm, and creates or updates the
   GitHub release with binaries and `SHA256SUMS`.

The publish job is idempotent: if the npm version already exists, it skips.

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
