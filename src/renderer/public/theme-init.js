// Sets the appearance attributes on <html> before first paint, so switching theme never
// flashes the wrong palette. Loaded as a plain (non-module) script before the stylesheet,
// so it runs synchronously during HTML parsing. Kept out of the Vite/TS build on purpose:
// the CSP has no 'unsafe-inline', so this has to be a same-origin file, and it must not
// depend on any bundled module. Never writes storage.
// It re-implements `resolveAppearance` from src/renderer/src/theme-model.ts by hand (this file
// cannot import); tests/appearance.test.ts runs both against the same inputs.
(function () {
  var DEFAULT_FAMILY = 'neutral' // keep in step with DEFAULT_FAMILY in theme-model.ts
  var root = document.documentElement
  // Not a setting: derived from navigator (platformAttribute in theme-model.ts), for the macOS traffic-light inset.
  try {
    var nav = typeof navigator === 'undefined' ? undefined : navigator
    var platform = (nav && ((nav.userAgentData && nav.userAgentData.platform) || nav.platform)) || ''
    root.setAttribute('data-platform', /mac/i.test(platform) ? 'mac' : 'other')
  } catch (error) { root.setAttribute('data-platform', 'other') }

  function pick(value, allowed, fallback) { return allowed.indexOf(value) !== -1 ? value : fallback }
  function media(query) { return !!(window.matchMedia && window.matchMedia(query).matches) }

  try {
    var families = ['neutral', 'mono', 'phosphor']
    var familyStored = families.indexOf(localStorage.getItem('fp-family')) !== -1
    var legacyTheme = localStorage.getItem('fp-theme')
    var legacy = legacyTheme === 'console' ? 'dark' : legacyTheme === 'daylight' ? 'light' : undefined
    var schemePref = pick(localStorage.getItem('fp-scheme'), ['system', 'light', 'dark'], (!familyStored && legacy) || 'system')
    var scheme = schemePref === 'system' ? (media('(prefers-color-scheme: dark)') ? 'dark' : 'light') : schemePref
    var effectsOff = localStorage.getItem('fp-effects') === 'off' || media('(prefers-reduced-motion: reduce)')
    root.setAttribute('data-family', pick(localStorage.getItem('fp-family'), families, DEFAULT_FAMILY))
    root.setAttribute('data-scheme', scheme)
    root.setAttribute('data-dock', pick(localStorage.getItem('fp-dock'), ['bottom', 'left', 'right'], 'bottom'))
    root.setAttribute('data-dock-labels', pick(localStorage.getItem('fp-dock-labels'), ['hover', 'always'], 'hover'))
    root.setAttribute('data-density', pick(localStorage.getItem('fp-density'), ['comfortable', 'compact'], 'comfortable'))
    root.setAttribute('data-font-size', pick(localStorage.getItem('fp-font-size'), ['default', 'large'], 'default'))
    root.setAttribute('data-effects', effectsOff ? 'off' : 'on')
  } catch (error) {
    root.setAttribute('data-family', DEFAULT_FAMILY)
    root.setAttribute('data-scheme', 'dark')
    root.setAttribute('data-dock', 'bottom')
    root.setAttribute('data-dock-labels', 'hover')
    root.setAttribute('data-density', 'comfortable')
    root.setAttribute('data-font-size', 'default')
    root.setAttribute('data-effects', 'off')
  }
})()
