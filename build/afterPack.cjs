const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// electron-builder 26 leaves macOS arm64 apps with a broken/stale code signature
// when no valid Developer ID (or usable Apple Development) certificate is present:
// it modifies the bundle (renames the binary, rewrites Info.plist) but then skips
// its own signing step, invalidating Electron's original signature. On Apple
// Silicon the kernel kills a bundle whose signature is broken, so the packaged
// app crashes immediately on launch ("cannot be opened").
//
// Apply a clean ad-hoc signature here — after the app is packed and before the
// DMG/zip are built — so the distributed artifact contains a valid signature and
// launches. Ad-hoc is not notarized, so a downloaded copy still trips Gatekeeper
// once (right-click → Open, or `xattr -dr com.apple.quarantine <app>`); for
// warning-free distribution, add a Developer ID identity + notarization instead.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // Sign nested frameworks and helper apps first (inside-out), then the bundle.
  const nested = `find ${JSON.stringify(appPath)}/Contents/Frameworks -type d \\( -name '*.app' -o -name '*.framework' \\)`
  for (const item of execFileSync('/bin/sh', ['-c', nested], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    execFileSync('codesign', ['--force', '--sign', '-', item], { stdio: 'inherit' })
  }
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • applied ad-hoc code signature  file=${appPath}`)
}
