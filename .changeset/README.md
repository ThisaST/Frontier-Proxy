# Changesets

This folder holds pending release notes. Each `*.md` file here is one user-facing
change, created alongside the pull request that makes it:

```bash
pnpm changeset
```

Pick the bump (`patch` for fixes, `minor` for features, `major` for breaking changes) and
write one line for the changelog. Changes nobody would notice (CI, refactors, tests) need
no changeset.

You never edit the version by hand. On every push to `main`, the **Release** workflow
collects these files into a `chore: release` pull request that bumps `package.json` and
writes `CHANGELOG.md`. Merging that pull request tags `v<version>`, builds the macOS,
Windows and Linux installers, and publishes them as a GitHub release whose notes are that
version's changelog section. The version shown in the app comes from `package.json` at
build time.

Docs: https://changesets.dev
