import type { Messages } from "../en.ts";

export const profile: Messages["profile"] = {
  nav: {
    rooms: "Rom",
    profile: "Profil",
    settings: "Innstillinger",
    signOut: "Logg ut",
  },
  rooms: {
    title: "Rom",
    kinds: { lobby: "Alle", personal: "Personlig", shared: "Delt" },
    toApprove: (n: number) => `${n} til godkjenning`,
    answering: "svarer …",
    openMine: "Åpne rommet mitt",
    newShared: "Nytt delt rom",
    name: "Navn på rommet",
    members: "Medlems-ID-er, skilt med komma (valgfritt)",
    create: "Opprett",
  },
  notifications: {
    title: "Varsler",
    on: "Denne nettleseren får svar, påminnelser og godkjenninger fra rommene dine.",
    off: "Få svar, påminnelser og godkjenninger fra rommene dine i denne nettleseren.",
    turnOff: "Slå av",
    turnOn: "Slå på",
    unsupported:
      "Denne nettleseren kan ikke vise varsler. På iPhone må du først legge Nudge til på Hjem-skjermen.",
    blocked: "Varsler er blokkert for dette nettstedet i nettleserens innstillinger.",
    unavailable: "Denne serveren sender ingen varsler.",
  },
  page: {
    title: "Profil",
    intro:
      "Slik kjenner assistenten deg: den leser tidene i påminnelsene dine i din tidssone og svarer deg på ditt språk.",
    guestBefore: "Du ble med fra hjemmeassistenten din, som ",
    guestAfter:
      ". Navnet, bildet, tidssonen, språket og innstillingene dine kommer derfra: endre dem i appen til hjemmet ditt.",
    unreadableImage: "Bildet kunne ikke leses.",
    choosePicture: "Velg et bilde",
    name: "Navn",
    timeZone: "Tidssone",
    assistantsTimeZone: "Assistentens",
    language: "Språk",
    languageExample: "For eksempel nb, en eller de",
    notifications: "Varsler",
    answers: "Svar og påminnelser",
    approvals: "Handlinger som venter på godkjenning",
    saved: "Lagret.",
  },
  personal: {
    title: "Personlige opplysninger",
    intro:
      "Til å fylle ut skjemaer, skrive e-post og finne det som er i nærheten. Bare du ser dem: modellen får plassholdere som ⟦EMAIL1⟧, bare i ditt eget rom og dine private meldinger, og verktøy får de ekte verdiene når de handler for deg. Posisjonen din går også til delte rom der du slår den på, under Posisjon i rommet.",
    fields: { fullName: "Fullt navn", email: "E-post", phone: "Telefon", address: "Adresse" },
    whereYouAre: "Hvor du er",
    notShared: "Ikke delt. Appene kan dele den mens du beveger deg.",
    noGeolocation: "Denne nettleseren kan ikke se hvor du er.",
    shareNow: "Del hvor jeg er nå",
    forget: "Glem den",
  },
  places: {
    title: "Steder",
    intro:
      "Be assistenten lagre et sted eller minne deg på noe når du kommer et sted. Modellen ser bare steder som plassholdere som ⟦PLACE:home⟧. Nudge-appen på telefonen sier fra til hjemmet når du kommer fram, med Påminnelser når jeg kommer fram slått på i profilen din.",
    none: "Ingen steder eller påminnelser ennå.",
    forget: "Glem",
    arriving: "Når du kommer til",
    leaving: "Når du drar fra",
    anyKind: (kind: string | undefined) => `hvilken som helst ${kind}`,
    everyTime: ", hver gang",
  },
  spend: {
    intro:
      "Hva svarene kostet i modellbruk denne måneden, i amerikanske dollar. Over en grense slutter assistenten å svare til måneden er omme.",
    mine: "Dine meldinger",
    everyone: "Alle",
    of: (limit: string) => ` av ${limit}`,
    ofLimit: (label: string) => `${label}, av grensen`,
  },
  memberships: {
    title: "Andre assistenter",
    addressBefore: "Adressen din er ",
    addressAfter:
      ". En administrator for en annen assistent kan invitere deg med den, og sende deg en invitasjonslenke å lime inn her.",
    open: "Åpne",
    join: "Bli med",
    joinLink: "Invitasjonslenke",
    notJoinLink: "Det er ikke en invitasjonslenke. Den begynner med nudge://join.",
    notInvited: (assistant: string) =>
      `${assistant} har ikke invitert adressen din. Be en administrator der om å gjøre det.`,
    thisAssistant: "Det er denne assistenten.",
    none: "Du har ikke blitt med i noen ennå.",
    where: (host: string, since: string) => `på ${host}, siden ${since}`,
    confirmLeave: (assistant: string) =>
      `Slutte å sende profilen og minnet ditt til ${assistant}? Du er fortsatt medlem der.`,
    leave: "Forlat",
    carryMemory: "Ta med mitt eget minne dit (ikke det jeg har gjort privat)",
  },
};
