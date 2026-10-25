import type { Messages } from "../en.ts";
import { plural } from "../plural.ts";

export const panels: Messages["panels"] = {
  backToRoom: "Tilbake til rommet",
  connecting: "Kobler til …",
  disconnected: (error: string | undefined) => `Frakoblet${error ? `: ${error}` : ""}.`,
  takeControl: "Ta kontrollen",
  someoneElse: "Noen andre",
  set: "lagt inn",
  notSet: "ikke lagt inn",
  clear: "Fjern",
  api: {
    notSignedIn: "Ikke logget inn",
    notSignedInTo: (assistant: string) => `Ikke logget inn på ${assistant}`,
  },
  model: {
    title: "Hva modellen ser",
    refresh: "Oppdater",
    intro:
      "Rommets neste forespørsel til modellen, slik leverandøren får den. Navn, adresser, numre og alt annet som er merket privat sendes som plassholdere, for eksempel ⟦NAME1⟧, og settes bare inn igjen her, på verten. Beskrivelsene av verktøyene sendes også; de inneholder ikke noe personlig.",
    empty: "Ingenting ennå: rommet har ikke hatt noen tur.",
    role: {
      system: "Instruksjoner",
      user: "Inn",
      assistant: "Modell",
      toolResult: "Verktøyresultat",
    },
  },
  documents: {
    title: "Dokumenter",
    intro:
      "Kvitteringer, garantier, kontrakter og brev for dette rommet. Teksten leses her, på verten, så assistenten kan søke i dem; filene lagres kryptert. Bilder tas vare på, men leses ikke.",
    notFound:
      "Denne assistenten har ingen dokumentutvidelse her, eller du er ikke med i dette rommet.",
    upload: "Last opp",
    uploading: (name: string) => `Laster opp ${name} …`,
    empty: "Ingen dokumenter ennå.",
    pages: (n: number) => `${n} ${plural(n, "side", "sider")} · `,
    confirmDelete: (name: string) => `Slette ${name}?`,
    delete: "Slett",
  },
  activity: {
    title: "Aktivitet",
    removed: "Du ble fjernet fra dette rommet.",
    noRoom: "Rommet finnes ikke.",
    empty: "Ingenting ennå: verktøykall, påminnelser, overvåkinger og godkjenninger vises her.",
    loadEarlier: "Last inn eldre",
    nudgeFor: (name: string) => `En påminnelse til ${name}`,
    approvalFor: (name: string) => `En godkjenning for ${name} er avsluttet`,
    decided: (by: string | undefined, denied: boolean, summary: string, failed: boolean) =>
      `${by ?? "Noen"} ${denied ? "avslo" : "godkjente"} ${summary}${failed ? " — det mislyktes" : ""}`,
    thinking: "Tankegang",
    working: "Jobber …",
    tool: { pending: "venter", running: "kjører", done: "ferdig", failed: "mislyktes" },
  },
  lists: {
    title: "Lister",
    intro:
      "Delt med alle i rommet, og med assistenten: be den legge til i en liste, eller kryss av ting her.",
    notFound:
      "Denne assistenten har ingen listeutvidelse her, eller du er ikke med i dette rommet.",
    empty: "Ingen lister ennå.",
    newList: "Ny liste, for eksempel handleliste",
    start: "Lag liste",
    clearDone: (n: number) => `Fjern ${n} ferdige`,
    confirmDelete: (name: string) => `Slette listen «${name}»?`,
    deleteList: "Slett liste",
    removeItem: (text: string) => `Fjern ${text}`,
    addItem: "Legg til noe",
    add: "Legg til",
  },
  desktop: {
    title: "Skrivebord",
    intro:
      "Dette er rommets eget skrivebord, der assistenten bruker apper. Se den jobbe, eller ta kontrollen og bruk appene selv. Assistenten leser appene som tekst og ser aldri dette bildet.",
    notFound:
      "Denne assistenten har ingen skrivebordsutvidelse, eller du er ikke med i dette rommet.",
    starting: "Starter skrivebordet …",
    canvas:
      "Rommets skrivebord. Klikk for å velge det, og skriv; vinduet under pekeren får tastene.",
    watching: (holder: string) => `${holder} bruker skrivebordet; du ser på.`,
    start: (app: string) => `Start ${app}`,
    windows: "Vinduer:",
    raise: (window: string) => `Hent ${window} fram`,
    waiting: "Venter på skjermen …",
    assistant: "Assistenten:",
  },
  terminal: {
    title: "Terminal",
    intro:
      "Kommandoene assistenten kjører i rommets avskjermede arbeidsområde, mens de kjører. De som sletter eller sender noe, venter på at noen her godkjenner dem.",
    notFound:
      "Dette rommet har ingen terminal: terminalutvidelsen er ikke på her, eller du er ikke i dette rommet.",
    empty: "Ingen kommandoer ennå.",
    status: {
      waiting: "venter på godkjenning",
      running: "kjører…",
      done: "avslutningskode 0",
      failed: "feilet",
      stopped: "stoppet",
      denied: "avslått",
    },
    exit: (code: number) => `avslutningskode ${code}`,
    approvedBy: (name: string) => `godkjent av ${name}`,
    deniedBy: (name: string) => `avslått av ${name}`,
  },
  connectors: {
    title: "Koblinger",
    intro:
      "API-er som assistenten i dette rommet kan kalle. Be den i chatten om å legge til en, og si hva den skal brukes til. Kryss av for «Bruk den alltid først» for å få den til å prøve en før noe annet for de oppgavene. API-nøkler legges inn bare her: assistenten ser dem aldri.",
    notFound:
      "Denne assistenten har ingen koblingsutvidelse her, eller du er ikke med i dette rommet.",
    empty: "Ingen koblinger ennå.",
    shared: "Delt med alle rom",
    confirmRemove: (name: string) => `Fjerne ${name}?`,
    usedFirstFor: "Brukes først til: ",
    learned: (notes: string) => `Lært: ${notes}`,
    useFor: "Bruk den til",
    alwaysFirst: "Bruk den alltid først til dette, før nettlesing eller svar fra hukommelsen",
    apiKey: (where: string) => `API-nøkkel (${where} `,
    replaceKey: "Bytt ut nøkkelen",
    pasteKey: "Lim inn nøkkelen",
    privateNetwork: "Kan nå denne maskinen og det lokale nettverket (Home Assistant, en NAS)",
    readPathsBefore: "Kall som bare leser, selv om de ikke er GET: én ",
    readPathsBetween: " per linje, for eksempel ",
    readPathsAfter: ". De kjøres uten å spørre.",
    saveReadPaths: "Lagre lesestier",
  },
  mcp: {
    title: "MCP-servere",
    intro:
      "MCP-servere som assistenten i dette rommet kan bruke. Be den i chatten om å legge til en. Nøkler og innlogginger legges inn bare her: assistenten ser dem aldri.",
    notFound: "Denne assistenten har ingen MCP-utvidelse her, eller du er ikke med i dette rommet.",
    empty: "Ingen MCP-servere ennå.",
    approvals: {
      writes: "Spør før kall som endrer noe",
      always: "Spør før hvert kall",
      never: "Spør aldri",
    },
    confirmRemove: (name: string) => `Fjerne ${name}, med nøklene og innloggingen?`,
    addedBy: (name: string) => `Lagt til av ${name}`,
    tools: (n: number) => ` · ${n} verktøy`,
    signedIn: "Logget inn.",
    notSignedIn: "Ikke logget inn. Servere som trenger det, ber om det.",
    signInAgain: "Logg inn på nytt",
    signIn: "Logg inn",
    signOut: "Logg ut",
    trustReadOnly: "Stol på serverens merking av kall som bare leser",
    tryAgain: "Prøv igjen",
    header: "Header",
    variable: "Variabel",
    replace: "Bytt den ut",
    paste: (prefix: string | undefined) =>
      `Lim den inn${prefix ? ` (uten «${prefix.trim()}»)` : ""}`,
  },
  browser: {
    title: "Nettleser",
    intro:
      "Dette er rommets egen nettleser. Logg inn på et nettsted her når assistenten ber deg om det. Det du skriver, går bare til denne nettleseren; assistenten ser aldri passord.",
    notFound:
      "Denne assistenten har ingen nettleserutvidelse, eller du er ikke med i dette rommet.",
    starting: "Starter nettleseren …",
    watching: (holder: string) => `${holder} bruker nettleseren; du ser på.`,
    address: "Adresse",
    go: "Gå",
    canvas: "Rommets nettleser. Klikk for å velge den, og skriv.",
    waiting: "Venter på siden …",
    remember: "Husk innlogginger jeg skriver her, så assistenten kan logge inn selv neste gang",
    done: "Ferdig",
    savedFor: (hosts: string) => `Lagret innloggingen for ${hosts}.`,
    nothingToSave: "Ingenting å lagre.",
    askAgain: "Be assistenten prøve igjen.",
    savedLogins: "Lagrede innlogginger",
    noLogins: "Ingen ennå. Innlogginger du husker her, vises her.",
    saved: (date: string) => `lagret ${date}`,
    forget: "Glem",
  },
};
