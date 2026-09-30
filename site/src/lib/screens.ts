// Eagerly-resolved map of the app screenshots (site/src/assets/screens/*.png,
// captured from the real app by site/scripts/screenshots/capture.js) so
// Screenshot.astro can pass a plain name ("tasks") through to astro:assets'
// <Picture> without a dynamic, non-statically-analyzable import per file.
import type { ImageMetadata } from "astro";

const modules = import.meta.glob<{ default: ImageMetadata }>("/src/assets/screens/*.png", { eager: true });

export type ScreenName = "tasks-compose" | "tasks" | "workspaces" | "review" | "agents" | "settings-appearance";
export type ScreenVariant = "light" | "dark";

const NAMES: ScreenName[] = ["tasks-compose", "tasks", "workspaces", "review", "agents", "settings-appearance"];

/** `screens.tasks.light` / `screens.tasks.dark` → ImageMetadata. */
export const screens: Record<ScreenName, Record<ScreenVariant, ImageMetadata>> = Object.fromEntries(
  NAMES.map((name) => [
    name,
    {
      light: modules[`/src/assets/screens/${name}-light.png`].default,
      dark: modules[`/src/assets/screens/${name}-dark.png`].default,
    },
  ]),
) as Record<ScreenName, Record<ScreenVariant, ImageMetadata>>;
