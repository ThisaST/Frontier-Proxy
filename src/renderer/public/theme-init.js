// Sets `data-theme` / `data-effects` on <html> before first paint, so switching
// theme never flashes the wrong palette. Loaded as a plain (non-module) script
// before the stylesheet, so it runs synchronously during HTML parsing. Kept out
// of the Vite/TS build on purpose: the CSP has no 'unsafe-inline', so this has to
// be a same-origin file, and it must not depend on any bundled module.
// Mirrored (not shared — this file cannot import anything) by src/renderer/src/theme.ts,
// which takes over live updates once the app has booted.
(function () {
  var THEME_KEY = 'fp-theme'
  var EFFECTS_KEY = 'fp-effects'
  var root = document.documentElement
  try {
    var storedTheme = localStorage.getItem(THEME_KEY) || 'system'
    var storedEffects = localStorage.getItem(EFFECTS_KEY) || 'on'
    var prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches
    var resolvedTheme = storedTheme === 'system' ? (prefersDark ? 'console' : 'daylight') : storedTheme
    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    var resolvedEffects = (storedEffects === 'off' || reducedMotion) ? 'off' : 'on'
    root.setAttribute('data-theme', resolvedTheme)
    root.setAttribute('data-effects', resolvedEffects)
  } catch (error) {
    root.setAttribute('data-theme', 'console')
    root.setAttribute('data-effects', 'off')
  }
})()
