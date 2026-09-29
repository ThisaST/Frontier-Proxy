import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Releases are cut by merging the Changesets release PR (see .github/workflows/
// release.yml): `changeset version` edits package.json and nothing else, so any
// other place that spells the version out would silently go stale.
describe('release versioning', () => {
  it('never hard-codes the app version in the renderer shell', () => {
    const html = readFileSync('src/renderer/index.html', 'utf8')
    expect(html).toContain('%APP_VERSION%')
    expect(html).not.toMatch(/\bv?\d+\.\d+\.\d+\b/)
  })

  it('versions the private app package without trying to publish it', () => {
    const config = JSON.parse(readFileSync('.changeset/config.json', 'utf8')) as { baseBranch: string; privatePackages: { version: boolean; tag: boolean } }
    expect(config.baseBranch).toBe('main')
    // version: the release PR bumps package.json. tag: false — the release
    // workflow creates the tag with the GitHub release, not `changeset tag`.
    expect(config.privatePackages).toEqual({ version: true, tag: false })
  })
})
