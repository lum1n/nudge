/** The assistant's pages for one person: the header, the rooms list and the profile. */
export const profile = {
  nav: {
    rooms: "Rooms",
    profile: "Profile",
    settings: "Settings",
    signOut: "Sign out",
  },
  rooms: {
    title: "Rooms",
    kinds: { lobby: "Everyone", personal: "Personal", shared: "Shared" },
    toApprove: (n: number) => `${n} to approve`,
    answering: "answering…",
    openMine: "Open my room",
    newShared: "New shared room",
    name: "Room name",
    members: "Member ids, comma-separated (optional)",
    create: "Create",
  },
  notifications: {
    title: "Notifications",
    on: "This browser gets answers, nudges and approvals from your rooms.",
    off: "Get answers, nudges and approvals from your rooms on this browser.",
    turnOff: "Turn off",
    turnOn: "Turn on",
    unsupported:
      "This browser can't show notifications. On an iPhone, add Nudge to the home screen first.",
    blocked: "Notifications are blocked for this site in the browser's settings.",
    unavailable: "This server sends no notifications.",
  },
  page: {
    title: "Profile",
    intro:
      "How the assistant knows you: it reads your nudges' times in your time zone and answers you in your language.",
    /** Around the guest's address, in a monospace font. */
    guestBefore: "You joined from your home assistant, as ",
    guestAfter:
      ". Your name, picture, time zone, language and settings come from there: change them in your home's app.",
    unreadableImage: "That image could not be read.",
    choosePicture: "Choose a picture",
    name: "Name",
    timeZone: "Time zone",
    assistantsTimeZone: "The assistant's",
    language: "Language",
    languageExample: "Such as en, nb or de",
    notifications: "Notifications",
    answers: "Answers and nudges",
    approvals: "Actions waiting for approval",
    saved: "Saved.",
  },
  personal: {
    title: "Personal details",
    intro:
      "For filling in forms, writing mail and finding what is near you. Only you see them: the model gets placeholders such as ⟦EMAIL1⟧, in your own room and your private messages only, and tools get the real values when they act for you. Where you are also goes to shared rooms where you turn it on, under Location in the room.",
    fields: { fullName: "Full name", email: "E-mail", phone: "Phone", address: "Address" },
    whereYouAre: "Where you are",
    notShared: "Not shared. The apps can share it as you move.",
    noGeolocation: "This browser can't tell where you are.",
    shareNow: "Share where I am now",
    forget: "Forget it",
  },
  places: {
    title: "Places",
    intro:
      "Ask the assistant to save a place or remind you when you get somewhere. The model only sees places as placeholders such as ⟦PLACE:home⟧. The Nudge app on your phone tells home when you get there, with Reminders when I arrive on in your profile.",
    none: "No places or reminders yet.",
    forget: "Forget",
    arriving: "Getting to",
    leaving: "Leaving",
    /** A reminder for any place of a kind, such as a shop. */
    anyKind: (kind: string | undefined) => `any ${kind}`,
    everyTime: ", every time",
  },
  spend: {
    intro:
      "What answering cost in model use this month, in US dollars. Past a limit the assistant stops answering until the month is over.",
    mine: "Your messages",
    everyone: "Everyone",
    /** After the amount spent. */
    of: (limit: string) => ` of ${limit}`,
    ofLimit: (label: string) => `${label}, of the limit`,
  },
  memberships: {
    title: "Other assistants",
    /** Around the person's address, in a monospace font. */
    addressBefore: "Your address is ",
    addressAfter:
      ". An admin of another assistant can invite you by it, and send you a join link to paste here.",
    open: "Open",
    join: "Join",
    joinLink: "Join link",
    notJoinLink: "That isn't a join link. It starts with nudge://join.",
    notInvited: (assistant: string) =>
      `${assistant} hasn't invited your address. Ask an admin there to.`,
    thisAssistant: "That is this assistant.",
    none: "You haven't joined any yet.",
    /** `host` is the other server's, `since` a date. */
    where: (host: string, since: string) => `at ${host}, since ${since}`,
    confirmLeave: (assistant: string) =>
      `Stop sending your profile and memory to ${assistant}? You stay a member there.`,
    leave: "Leave",
    carryMemory: "Take my own memory there (not what I made private)",
  },
};
