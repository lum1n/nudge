import type { Accessory, EyeShape } from "../../avatar/appearance.ts";
import type { Mood } from "../../avatar/pose.ts";

/** Getting in: the setup wizard, signing in, pairing codes, and the robot's looks. */
export const setup = {
  wizard: {
    title: "Set up Nudge",
    setUpTitle: "Nudge is set up",
    setUpAlready: "This server is set up already.",
    signIn: "Sign in",
    closed:
      "Setup closed: the server is set up already, or took too many wrong codes. Restart it for a new code.",
    continue: "Continue",
    code: "Setup code",
    codeHint: "The server printed it when it started.",
    nameTitle: "Name your assistant",
    name: "Its name",
    nameHint: "What it calls itself. You can change it later.",
    namePlaceholder: "Robin",
    slug: "In its address",
    slugHint: "Part of every address of the people here, so this one stays.",
    modelTitle: "Choose its model",
    whoRuns: "Who runs the model",
    ownKey: "With your own API key",
    local: "Running on this machine; no key",
    model: "Model",
    key: "API key",
    keyHint: "Kept encrypted on this server, never shown again.",
    getKey: "Get one",
    tryingKey: "Trying the key…",
    youTitle: "And you?",
    yourName: "Your name",
    /** `assistant` is the name given a step before, if any. */
    yourNameHint: (assistant: string | undefined) =>
      `You will be ${assistant ?? "the assistant"}'s first person, its admin, and this server's owner.`,
    backups:
      "Back up every night, keeping two weeks, beside the data. Copy them somewhere else too: a backup on the same disk won't survive the disk.",
    settingUp: "Setting up…",
    setUp: "Set up",
  },
  done: {
    title: (assistant: string) => `${assistant} is ready`,
    phone: "Your phone",
    scan: (code: string) =>
      `Scan this with the Nudge app, or type the code ${code} in it. It works once, for ten minutes.`,
    kit: "Recovery kit",
    kitIntro:
      "With it and a backup, everything here can be brought back. Keep it somewhere other than this server, with the passphrase in your password manager.",
    passphrase: "Passphrase, 8 characters or more",
    again: "The same again",
    saveKit: "Save the recovery kit",
    savedKit: "Saved; save it again",
    open: (assistant: string) => `Open ${assistant}`,
  },
  login: {
    scan: "Scan this with your phone's camera and confirm in the Nudge app, to sign in here as yourself. Only scan a code you opened yourself.",
    qr: "Sign in with the Nudge app",
    qrFailed: "That didn't sign you in; scan the new code.",
    or: "or",
    token: "Token or pairing code",
    tokenPlaceholder: "nudge_… or ABCD-1234",
    remember: "Remember this device",
    signIn: "Sign in",
    signingIn: "Signing in…",
    unknownCode: "That code is unknown or expired.",
    unknownToken: "No assistant here knows that token.",
    newHere:
      "New here? Ask an admin to invite you: Invite someone, in the assistant's settings, gives them a pairing code for you. An admin signs in another device of theirs there too.",
  },
  join: {
    noLink:
      "This page joins an assistant from your home's Other assistants, under Profile. Open it from there again.",
    /** Around the assistant's name, in bold. */
    vouchesBefore: "Your home assistant vouches for you to ",
    vouchesAfter: (host: string) => ` on ${host}. You join with your name and picture from home.`,
    remember: "Remember this device",
    join: (name: string) => `Join ${name}`,
    askAgain: "Ask for the link again from your home, under Profile.",
    otherWay: "Sign in another way",
  },
  pairing: {
    noName: "Give them a name first.",
    scanSelf: "Scan this with the Nudge app on your other device, or type the code in it.",
    scanOther: (name: string) =>
      `Have ${name} scan this with the Nudge app on their phone, or type the code in it.`,
    /** Around the server's address, in a monospace font. */
    serverBefore: "The server is ",
    serverAfter: ".",
    expired: "This code expired. Make a new one.",
    qr: (name: string) => `Sign in as ${name} with the Nudge app`,
    /** `until` is a time of day. */
    once: (until: string, name: string) =>
      `It works once, until ${until}. Whoever has it signs in as ${name}.`,
    copy: "Copy the link",
    copied: "Copied",
    done: "Done",
  },
  push: {
    notAllowed: "Notifications are not allowed for this site",
  },
  avatar: {
    playingTurn: "playing a turn",
    mood: "Mood",
    playTurn: "Play a turn",
    followVoice: "Follow my voice when listening or speaking",
    noMicrophone: "The browser didn't give the microphone.",
    look: "Look",
    dark: "Dark background",
    moods: {
      idle: "idle",
      listening: "listening",
      thinking: "thinking",
      speaking: "speaking",
      working: "working",
      waiting: "waiting",
      happy: "happy",
      puzzled: "puzzled",
      sad: "sad",
      asleep: "asleep",
    } satisfies Record<Mood, string>,
  },
  look: {
    /** The presets' names, by their key in `PRESETS`. */
    presets: {
      Nudge: "Nudge",
      Ember: "Ember",
      Moss: "Moss",
      Grape: "Grape",
      Graphite: "Graphite",
    } as Readonly<Record<string, string>>,
    ribbon: "Ribbon",
    ribbonEnd: "Ribbon end",
    eyeColour: "Eyes",
    sparks: "Sparks",
    eyes: "Eyes",
    wears: "Wears",
    eyeShapes: {
      pill: "pill",
      round: "round",
      square: "square",
      wide: "wide",
    } satisfies Record<EyeShape, string>,
    accessories: {
      none: "none",
      antenna: "antenna",
      headphones: "headphones",
      sprout: "sprout",
      crown: "crown",
    } satisfies Record<Accessory, string>,
  },
};
