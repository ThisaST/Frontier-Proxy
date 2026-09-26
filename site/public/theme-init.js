// Sets `data-theme` / `data-effects` on <html> before first paint, so switching
// theme never flashes the wrong palette. Loaded as a plain (non-module) script
// before the stylesheet, so it runs synchronously during HTML parsing. Mirrors
// src/renderer/public/theme-init.js in the desktop app (same keys, same logic)
// so the site and the app behave identically; kept as its own file for the same
// reason the app's is — same-origin only, no bundled module dependency.
(function () {
  var THEME_KEY = 'fp-theme'
  var root = document.documentElement
  try {
    var storedTheme = localStorage.getItem(THEME_KEY) || 'system'
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    var resolvedTheme = storedTheme === 'system' ? (prefersDark ? 'console' : 'daylight') : storedTheme
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    root.setAttribute('data-theme', resolvedTheme)
    root.setAttribute('data-effects', reducedMotion ? 'off' : 'on')
  } catch (error) {
    root.setAttribute('data-theme', 'console')
    root.setAttribute('data-effects', 'off')
  }
})()
