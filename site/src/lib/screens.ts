// Eagerly-resolved map of the demo screenshots (site/src/assets/screens/*.png,
// captured from the real app by site/scripts/screenshots/capture.js) so
// Screenshot.astro can pass a plain name ("tasks") through to astro:assets'
// <Picture> without a dynamic, non-statically-analyzable import per file.
import type { ImageMetadata } from "astro";

const modules = import.meta.glob<{ default: ImageMetadata }>("/src/assets/screens/*.png", { eager: true });

export type ScreenName = "home" | "tasks" | "routing" | "agents" | "agent-drawer" | "review";
export type ScreenVariant = "console" | "daylight";

/** `screens.tasks.console` / `screens.tasks.daylight` → ImageMetadata. */
export const screens: Record<ScreenName, Record<ScreenVariant, ImageMetadata>> = Object.fromEntries(
  (["home", "tasks", "routing", "agents", "agent-drawer", "review"] as ScreenName[]).map((name) => [
    name,
    {
      console: modules[`/src/assets/screens/${name}-console.png`].default,
      daylight: modules[`/src/assets/screens/${name}-daylight.png`].default,
    },
  ]),
) as Record<ScreenName, Record<ScreenVariant, ImageMetadata>>;
