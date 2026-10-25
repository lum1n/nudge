import { BACKGROUND_CONTEXT, createNudge, LOBBY, type ModelContext, type Nudge } from "@nudge/core";
import {
  createModels,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@nudge/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Contact,
  type ContactsBackend,
  contactsExtension,
  KnownContacts,
  matches,
  parseVCards,
  phoneKeys,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const by = { playerId: "owner", displayName: "Kari Nordmann" };

const CARDS = [
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Ingrid Hansen",
  "N:Hansen;Ingrid;;;",
  "NICKNAME:Mormor,Grandma",
  "EMAIL;TYPE=INTERNET,HOME:ingrid@example.no",
  "TEL;TYPE=CELL:+47 912 34 567",
  "ADR;TYPE=HOME:;;Storgata 1;Oslo;;0155;Norge",
  "BDAY:1950-03-04",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:4.0",
  "FN:Rørlegger Berg AS",
  "ORG:Rørlegger Berg AS",
  'TEL;VALUE=uri;TYPE="voice,work":tel:+47-22-33-44-55',
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Kari Nordmann",
  "N:Nordmann;Kari;;;",
  "EMAIL:kari@example.no",
  "END:VCARD",
  "BEGIN:VCARD",
  "VERSION:3.0",
  "FN:Mom",
  "TEL:+44 7700 900123",
  "END:VCARD",
].join("\r\n");

describe("vCards", () => {
  it("reads people and companies from 3.0 and 4.0 cards", () => {
    const [ingrid, plumber, , mom] = parseVCards(CARDS);
    expect(ingrid).toEqual({
      name: "Ingrid Hansen",
      given: "Ingrid",
      family: "Hansen",
      nicknames: ["Mormor", "Grandma"],
      emails: [{ value: "ingrid@example.no", label: "home" }],
      phones: [{ value: "+47 912 34 567", label: "cell" }],
      addresses: [{ value: "Storgata 1, 0155 Oslo, Norge", label: "home" }],
      birthday: "1950-03-04",
    });
    expect(plumber).toMatchObject({
      name: "Rørlegger Berg AS",
      company: true,
      phones: [{ value: "+47-22-33-44-55", label: "work" }],
    });
    expect(mom).toMatchObject({ name: "Mom", phones: [{ value: "+44 7700 900123" }] });
  });

  it("finds a contact by every word, best match first", () => {
    const [ingrid] = parseVCards(CARDS);
    expect(matches(ingrid!, ["mormor"])).toBe(0);
    expect(matches(ingrid!, ["ingrid"])).toBe(1);
    expect(matches(ingrid!, ["hansen", "ingrid"])).toBe(2);
    expect(matches(ingrid!, ["91234567"])).toBe(2);
    expect(matches(ingrid!, ["ingrid", "berg"])).toBeUndefined();
  });
});

describe("known contacts", () => {
  const spans = (known: KnownContacts, text: string) =>
    known.detectors.flatMap((detector) =>
      [...detector.find(text)].map((span) => [detector.kind, text.slice(span.start, span.end)]),
    );

  it("writes a number with and without its country code and trunk 0", () => {
    expect(phoneKeys("+47 912 34 567")).toEqual(
      expect.arrayContaining(["4791234567", "91234567", "091234567"]),
    );
    expect(phoneKeys("+44 7700 900123")).toEqual(expect.arrayContaining(["07700900123"]));
    expect(phoneKeys("1234")).toEqual([]);
  });

  it("hides whole names, the contacts' addresses and numbers however they are written", () => {
    const known = new KnownContacts();
    known.set(parseVCards(CARDS), { names: true, readable: new Set(["kari nordmann"]) });
    expect(
      spans(
        known,
        "Ring Ingrid  Hansen på 91234567 eller +47 91 23 45 67, mail ingrid@EXAMPLE.no. " +
          "Mom: 07700 900123. Ingrid alone, Kari Nordmann and Rørlegger Berg AS stay; " +
          "so do 591234567 and 2026-10-22 18:00.",
      ),
    ).toEqual([
      ["NAME", "Ingrid  Hansen"],
      ["EMAIL", "ingrid@EXAMPLE.no"],
      ["PHONE", "91234567"],
      ["PHONE", "+47 91 23 45 67"],
      ["PHONE", "07700 900123"],
    ]);
    // Two numbers written one after the other.
    expect(spans(known, "ring 22 33 44 55 91234567")).toEqual([
      ["PHONE", "22 33 44 55"],
      ["PHONE", "91234567"],
    ]);
  });

  it("leaves names readable when told to", () => {
    const known = new KnownContacts();
    known.set(parseVCards(CARDS), { names: false, readable: new Set() });
    expect(spans(known, "Ingrid Hansen, ingrid@example.no")).toEqual([
      ["EMAIL", "ingrid@example.no"],
    ]);
  });
});

class FakeContacts implements ContactsBackend {
  calls = 0;
  list: Contact[] = parseVCards(CARDS);

  async contacts(): Promise<Contact[]> {
    this.calls++;
    return this.list;
  }
}

function textOf(message: ModelContext["messages"][number]): string {
  return typeof message.content === "string"
    ? message.content
    : message.content.map((part) => (part.type === "text" ? part.text : "")).join("");
}

describe("contacts_search", () => {
  let nudge: Nudge;
  let book: FakeContacts;
  let requests: ModelContext[];

  beforeEach(async () => {
    process.env.TEST_CARDDAV_PASSWORD = "pw";
    book = new FakeContacts();
    requests = [];
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const answer = (request: ModelContext) => {
      requests.push(request);
      const last = request.messages.findLast((m) => m.role !== "system")!;
      if (last.role === "toolResult") return fauxAssistantMessage([fauxText(textOf(last))]);
      if (/grandma/i.test(textOf(last)))
        return fauxAssistantMessage([fauxToolCall("contacts_search", { query: "grandma" })], {
          stopReason: "toolUse",
        });
      return fauxAssistantMessage([fauxText("Okay.")]);
    };
    faux.setResponses(Array.from({ length: 20 }, () => answer));
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: contactsExtension({ backend: book }),
            settings: {
              accounts: [
                {
                  id: "family",
                  url: "https://dav.example/",
                  user: "fam",
                  password: "${TEST_CARDDAV_PASSWORD}",
                  rooms: ["*"],
                },
              ],
            },
          },
        ],
      },
      context,
    );
  });

  afterEach(async () => {
    await nudge.close(context);
    delete process.env.TEST_CARDDAV_PASSWORD;
  });

  const say = async (text: string) => {
    const settled = await (await nudge.submit(LOBBY, { text, author: by }, context)).wait(context);
    if (settled.status !== "done") throw new Error(`unanswered: ${JSON.stringify(settled)}`);
  };
  const seen = () => requests.flatMap((request) => request.messages.map(textOf)).join("\n");

  it("finds grandma, and the model sees her name, address and number only as placeholders", async () => {
    await say("Send the photos to grandma");
    const output = textOf(requests.at(-1)!.messages.findLast((m) => m.role === "toolResult")!);
    expect(output).toMatch(
      /^⟦NAME\d+⟧ \(Mormor, Grandma\)\n {2}e-mail: ⟦EMAIL\d+⟧ \(home\)\n {2}phone: ⟦PHONE\d+⟧ \(cell\)\n {2}address: Storgata 1, 0155 Oslo, Norge \(home\)\n {2}birthday: 1950-03-04$/,
    );
    // What people say later is hidden too, also a number the built-in detectors leave alone.
    await say("Ingrid Hansen has a new number, 91234567");
    const all = seen();
    expect(all).not.toContain("Ingrid Hansen");
    expect(all).not.toContain("ingrid@example.no");
    expect(all).not.toContain("91234567");
    expect(all).not.toContain("912 34 567");
    // A player who joins later, named as a contact is, gets their name back readable, also in
    // what the model saw before.
    await nudge.players.ensure("owner", "Kari Nordmann", context);
    await say("Kari Nordmann here");
    await say("Hello again");
    const last = requests.at(-1)!.messages.map(textOf).join("\n");
    expect(last).toContain("Kari Nordmann (");
    expect(last).toContain("Kari Nordmann here");
    expect(last).not.toContain("Ingrid Hansen");
  });

  it("tells the model where to look people up", async () => {
    await say("Hello");
    expect(JSON.stringify(requests[0])).toContain("contacts_search: family");
  });
});
