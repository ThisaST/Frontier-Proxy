// Sets `data-scheme` (light or dark) on <html> before first paint, so switching
// scheme never flashes the wrong palette. Loaded as a plain (non-module) script
// before the stylesheet, so it runs synchronously during HTML parsing. Mirrors
// the scheme half of src/renderer/public/theme-init.js in the desktop app (same
// `fp-scheme` key: system, light or dark, and the same fallback) — the site has
// one theme family, so there is no family, dock, density or effects here.
// Kept as its own file for the same reason the app's is: same-origin only, no
// bundled module dependency.
(function () {
  var root = document.documentElement
  try {
    var stored = localStorage.getItem('fp-scheme')
    var scheme = stored === 'light' || stored === 'dark' ? stored : 'system'
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    root.setAttribute('data-scheme', scheme === 'system' ? (prefersDark ? 'dark' : 'light') : scheme)
  } catch (error) {
    root.setAttribute('data-scheme', 'dark')
  }
})()
