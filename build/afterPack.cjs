const { execFileSync } = require('node:child_process')
const { join } = require('node:path')

// electron-builder 26 leaves the packaged macOS app with a broken/stale code
// signature when no valid Developer ID (or usable Apple Development) certificate
// is present: it modifies the bundle (renames the binary, rewrites Info.plist)
// but then skips its own signing step, invalidating Electron's signature. On
// Apple Silicon the kernel kills a bundle whose signature is broken, and an
// unsigned x64 bundle is flagged as "damaged" by Gatekeeper once downloaded — so
// the packaged app crashes / can't be opened.
//
// Apply a clean ad-hoc signature here — after the app is packed, before the
// DMG/zip are built — so the distributed artifact contains a valid signature and
// launches. `--deep` signs every nested Mach-O (frameworks, helpers, the crashpad
// handler) inside-out; a manual per-framework pass is not enough because the x64
// Electron distribution ships some nested helpers unsigned.
//
// Ad-hoc is not notarized, so a downloaded copy still trips Gatekeeper once
// (right-click -> Open, or `xattr -dr com.apple.quarantine <app>`). For
// warning-free distribution, add a Developer ID identity + notarization instead.
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const appPath = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log(`  • applied ad-hoc code signature  file=${appPath}`)
}
