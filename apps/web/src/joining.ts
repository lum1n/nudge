import type { PlaceRequest, Sealed } from "@nudge/client";

/**
 * The assistant a join link names: the `nudge://join?server=…&assistant=…` an admin elsewhere
 * gets when they invite someone's address. Also takes the link's server address and the
 * assistant's name typed in apart, as `https://nudge.example.com robin`. Undefined for anything
 * else, or a server that isn't http(s).
 */
export function parseJoinLink(text: string): PlaceRequest | undefined {
  const trimmed = text.trim();
  let server: string | null;
  let assistant: string | null;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "nudge:") {
      // `nudge://join?…` parses with the host "join", or as the path "//join" in some engines.
      if (url.host !== "join" && !url.pathname.startsWith("//join")) return undefined;
      server = url.searchParams.get("server");
      assistant = url.searchParams.get("assistant");
    } else return undefined;
  } catch {
    const [address, name, ...rest] = trimmed.split(/\s+/);
    if (rest.length > 0) return undefined;
    server = address ?? null;
    assistant = name ?? null;
  }
  assistant = assistant?.trim() ?? "";
  if (server === null || assistant === "") return undefined;
  try {
    // As the link has it: the assistant there checks the address it is vouched to letter by letter.
    const { protocol } = new URL(server.trim());
    if (protocol !== "http:" && protocol !== "https:") return undefined;
    return { server: server.trim(), assistant };
  } catch {
    return undefined;
  }
}

/** Whether `server` is the one this page came from, so its assistants are joined from here. */
export function isThisServer(server: string, origin: string): boolean {
  try {
    return new URL(server).origin === new URL(origin).origin;
  } catch {
    return false;
  }
}

/**
 * The page on `place`'s own server that joins it with `assertion`: a browser keeps tokens per
 * server, and only that server's page can call its API. The assertion is in the fragment, which
 * never reaches a server or its logs; it is sealed for that assistant, short-lived and used once.
 */
export function joinPage(place: PlaceRequest, assertion: Sealed): string {
  const hash = new URLSearchParams({
    assistant: place.assistant,
    assertion: JSON.stringify(assertion),
  });
  return `${place.server.replace(/\/+$/, "")}/join#${hash}`;
}

/** What `joinPage` put in the fragment; undefined when it isn't that. */
export function readJoinPage(hash: string): { assistant: string; assertion: Sealed } | undefined {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const assistant = params.get("assistant")?.trim();
  const sealed = params.get("assertion");
  if (assistant === undefined || assistant === "" || sealed === null) return undefined;
  try {
    const assertion = JSON.parse(sealed) as Sealed;
    const fields = [assertion.epk, assertion.iv, assertion.data, assertion.tag];
    if (assertion.v !== 1 || fields.some((field) => typeof field !== "string")) return undefined;
    return { assistant, assertion };
  } catch {
    return undefined;
  }
}
