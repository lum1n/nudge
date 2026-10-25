import { en, type Messages } from "./en.ts";
import { nb } from "./nb.ts";

export type { Messages };
export { plural } from "./plural.ts";

/** The languages the web app speaks. */
export type Locale = "en" | "nb";

const MESSAGES: Record<Locale, Messages> = { en, nb };

/**
 * The language to show, from the browser's languages in order of preference: Norwegian of any
 * kind (nb, nn, no) gets bokmål, anything else English. The first language either knows wins.
 */
export function pickLocale(languages: readonly string[]): Locale {
  for (const language of languages) {
    const base = language.toLowerCase().split(/[-_]/)[0];
    if (base === "nb" || base === "nn" || base === "no") return "nb";
    if (base === "en") return "en";
  }
  return "en";
}

function browserLanguages(): readonly string[] {
  const navigator = globalThis.navigator as Navigator | undefined;
  if (navigator === undefined) return [];
  return navigator.languages?.length ? navigator.languages : [navigator.language];
}

/** The language the app is showing. */
export let locale: Locale = pickLocale(browserLanguages());
/** What the app says, in [locale]: `m.room.send`, `m.room.typing(name)`. */
export let m: Messages = MESSAGES[locale];

/**
 * The locale for dates, times and numbers: the browser's own form of the app's language
 * ("en-GB", "nb-NO"), so a German browser showing the English app doesn't get German dates.
 */
export function dateLocale(): string {
  return (
    browserLanguages().find((language) => pickLocale([language]) === locale) ??
    (locale === "nb" ? "nb-NO" : "en")
  );
}

/** Shows the app in another language; tests use it, the app follows the browser. */
export function setLocale(next: Locale): void {
  locale = next;
  m = MESSAGES[next];
  if (typeof document !== "undefined") document.documentElement.lang = next;
}
