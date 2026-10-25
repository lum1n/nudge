import { WebSpeechDictationAdapter } from "@assistant-ui/react";

// Speech to text for the composer, with the browser's own recognizer (the Web Speech API). Unlike
// the apps', it may send the audio to the browser maker's service (Google for Chrome, Apple for
// Safari): redaction (ADR 2) only sees the text, so the player agrees to that once per device.
const ALLOWED = "nudge.dictation";

/** Whether this browser recognizes speech at all. */
export function dictationSupported(): boolean {
  return WebSpeechDictationAdapter.isSupported();
}

/** Whether the player let this device's browser hear them. */
export function dictationAllowed(storage: Pick<Storage, "getItem"> = localStorage): boolean {
  return storage.getItem(ALLOWED) === "yes";
}

export function allowDictation(storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(ALLOWED, "yes");
}

/**
 * The language to listen for: the one in the player's profile, as a BCP 47 tag, else the
 * browser's. A profile's language that isn't a tag, such as "Norwegian", falls back too.
 */
export function speechLanguage(profile: string | undefined, browser: string): string {
  const typed = profile?.trim();
  if (typed !== undefined && typed !== "") {
    try {
      return Intl.getCanonicalLocales(typed)[0]!;
    } catch {
      // Not a tag.
    }
  }
  return browser;
}

/** The composer's recognizer for `language`; undefined in a browser without one. */
export function dictationFor(language: string): WebSpeechDictationAdapter | undefined {
  return dictationSupported() ? new WebSpeechDictationAdapter({ language }) : undefined;
}

export const DICTATION_NOTICE =
  "Dictation uses your browser's speech recognition, which may send what you say to its maker " +
  "(Google in Chrome, Apple in Safari) to turn it into text. Nudge keeps personal details from " +
  "the model in the text only, not in the audio. Dictate on this device?";
