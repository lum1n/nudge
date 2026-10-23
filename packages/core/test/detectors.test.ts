import { describe, expect, it } from "vitest";
import { builtinDetectors, quasiIdentifierDetectors, Vault } from "../src/index.ts";
import { domainDetector, ipDetector, usernameDetector } from "../src/privacy/hosts.ts";
import { orgDetector, placeDetector } from "../src/privacy/places.ts";
import {
  birthDateDetector,
  cardDetector,
  phoneCueDetector,
  type PiiDetector,
  secretDetector,
  plateDetector,
  vinDetector,
} from "../src/privacy/detectors.ts";

const found = (detector: PiiDetector, text: string) =>
  [...detector.find(text)].map(({ start, end }) => text.slice(start, end));

describe("quasi-identifiers", () => {
  it("finds Norwegian places and stations, leaving large cities and words alone", () => {
    const places = placeDetector();
    expect(found(places, "Toget fra Sørumsand stasjon til Oslo S går hver time.")).toEqual([
      "Sørumsand",
      "Oslo S",
    ]);
    expect(found(places, "Lillestrøms kommune; Bergen og Trondheim er byer, Oslo også.")).toEqual([
      "Lillestrøm",
    ]);
    // Short names that are words count only after "i", "fra" and the like.
    expect(found(places, "Ski er gøy. Moss på taket. Hell yes. Jeg bor i Ski.")).toEqual(["Ski"]);
    expect(found(placeDetector(["Sørumsand"]), "i Sørumsand")).toEqual([]);
  });

  it("finds the names of kindergartens, schools, clinics and clubs, and departments", () => {
    expect(
      found(
        orgDetector,
        "Barnet går i Skogkanten Barnehage, på avdelingene Blåveisen og Skogstjerna.",
      ),
    ).toEqual(["Skogkanten", "Blåveisen", "Skogstjerna"]);
    expect(found(orgDetector, "Vaksine hos Vethjem dyreklinikk, kamp mot Sørumsand IL.")).toEqual([
      "Vethjem",
      "Sørumsand",
    ]);
    expect(found(orgDetector, "Hun er på Revehiet-avdelingen.")).toEqual(["Revehiet"]);
    expect(
      found(orgDetector, "Den barnehagen er fin. Min skole. Oslo as well. Jeg kommer da. Hva if."),
    ).toEqual([]);
  });

  it("finds private and personal hosts, and leaves well-known sites and code alone", () => {
    expect(
      found(
        domainDetector,
        "HA på https://hass.kjeks.dev og http://homeassistant.local:8123, blogg på vegard.github.io, boks på box.tail1234.ts.net",
      ),
    ).toEqual(["hass.kjeks.dev", "homeassistant.local", "vegard.github.io", "box.tail1234.ts.net"]);
    expect(
      found(
        domainDetector,
        "Se yr.no, finn.no, www.vy.no, docs.github.com og example.com. Filer: README.md, index.ts, package.json. Kode: player.displayName, item.id, user.name, this.models.vault. Node.js.",
      ),
    ).toEqual([]);
    expect(found(domainDetector, "https://notes.md/x og kjeks.no")).toEqual([
      "notes.md",
      "kjeks.no",
    ]);
  });

  it("finds IP addresses but not loopback or versions", () => {
    expect(
      found(ipDetector, "Ruteren er 192.168.1.1, hjemme 84.210.3.7, lokal 127.0.0.1, v1.2.3.4"),
    ).toEqual(["192.168.1.1", "84.210.3.7"]);
  });

  it("finds user names in paths and logins", () => {
    expect(
      found(
        usernameDetector,
        "/home/vegard/repos, /Users/kari/Desktop, C:\\Users\\ola\\Documents, ~tor/notes, ssh vegard@box",
      ),
    ).toEqual(["vegard", "kari", "ola", "tor", "vegard"]);
    expect(
      found(usernameDetector, "/home/runner/work, root@box, pi-ai@1.2.0, react@latest, /home/user"),
    ).toEqual([]);
  });

  it("finds plates, VINs and birth dates, but not standards, hashes or other dates", () => {
    expect(
      found(plateDetector, "Bilen har skilt EL 12345 og AB12345. Se EN 12345 og NO 12345."),
    ).toEqual(["EL 12345", "AB12345"]);
    expect(
      found(vinDetector, "VIN 5YJYGDEF8NF123456, commit 3f9a1c2e4b5d6e7f8, ABCDEFGHJKLMNPRST"),
    ).toEqual(["5YJYGDEF8NF123456"]);
    expect(
      found(
        birthDateDetector,
        "Mora er født 3. mai 1958. DOB: 1990-04-12. Bursdag 12.04. Møtet er 3. mai.",
      ),
    ).toEqual(["3. mai 1958", "1990-04-12"]);
    expect(
      found(
        birthDateDetector,
        "Fødselsdatoen min er 17.08.1987. Birth date: 1989-06-11\nBursdager:\n- Astrid: 4. mai 1962\n- Ole: 19.10\n\nMøte 1.11.2026",
      ),
    ).toEqual(["17.08.1987", "1989-06-11", "4. mai 1962"]);
  });

  it("finds unbroken phone numbers after a word that says so, not other numbers", () => {
    expect(
      found(
        phoneCueDetector,
        "Mobil: 90512477. Send sms til 41234567, nummeret er 48219553. Ordrenr 41234567, 12345678 kr, tlf 123456789",
      ),
    ).toEqual(["90512477", "41234567", "48219553"]);
  });

  it("leaves famous people and well-known companies readable", () => {
    const vault = new Vault();
    expect(
      vault.redact(
        "Erling Haaland og Kari Nordby så Rosenborg BK, så til Komplett AS og Lindeberg skole.",
        quasiIdentifierDetectors,
      ),
    ).toBe("Erling Haaland og ⟦NAME1⟧ så Rosenborg BK, så til Komplett AS og ⟦ORG1⟧ skole.");
  });

  it("hides home network names", () => {
    expect(found(domainDetector, "GET http://hass.lindgard.home:8123/api og nas.intranet")).toEqual(
      ["hass.lindgard.home", "nas.intranet"],
    );
  });

  it("keeps the topic readable in a whole message", () => {
    const vault = new Vault();
    const text =
      "Vi bor på Sørumsand, barnet går i Skogkanten Barnehage, HA er på hass.kjeks.dev, Tesla Model Y 2022 med 65 000 km, ISO 27001, år 2022.";
    expect(vault.redact(text, quasiIdentifierDetectors)).toBe(
      "Vi bor på ⟦PLACE1⟧, barnet går i ⟦ORG1⟧ Barnehage, HA er på ⟦DOMAIN1⟧, Tesla Model Y 2022 med 65 000 km, ISO 27001, år 2022.",
    );
  });
});

describe("what every assistant hides (ADR 15)", () => {
  it("finds keys, tokens and passwords, not the words around them", () => {
    expect(
      found(
        secretDetector,
        [
          "key sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 and ghp_abcdefghijklmnopqrstuvwxyz0123456789",
          "AWS AKIAABCDEFGHIJKLMNOP, jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
          "passord: Hemmelig123. password=hunter2! token er abc123def",
          "the password is wrong, token expired, secret santa",
        ].join("\n"),
      ),
    ).toEqual([
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "AKIAABCDEFGHIJKLMNOP",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlLXZhbHVl",
      "Hemmelig123",
      "hunter2",
      "abc123def",
    ]);
  });

  it.each([
    ["Kortnummer 4111 1111 1111 1111, utløper 12/28", ["4111 1111 1111 1111"]],
    ["card: 5555-5555-5555-4444", ["5555-5555-5555-4444"]],
    ["Les https://www.nytimes.com/ og betal med 4012888888881881", ["4012888888881881"]],
    ["Link: https://shop.no/kvittering, kort 4111111111111111.", ["4111111111111111"]],
    ["Betal på kjeks.dev med 4111111111111111", ["4111111111111111"]],
    ["https://www.nytimes.com/live/2026/10/22/world/4111111111111111", []],
    ["https://example.com/article?id=4111111111111111&ref=home", []],
    ["se www.vg.no/nyheter/i/4111111111111111 i dag", []],
    ["nytimes.com/2026/10/22/4012888888881881.html", []],
    ["<a href='https://x.com/a#5555555555554444'>lenke</a>", []],
    ["ordre 4111111111111112", []],
  ])("finds the card numbers in %j", (text, cards) => {
    expect(found(cardDetector, text)).toEqual(cards);
  });

  it("leaves names, places, hosts and API words readable", () => {
    const vault = new Vault();
    const text =
      "Kari Nordby bor på Sørumsand, HA på hass.kjeks.dev, POST to NSR:StopPlace:58404, født 3. mai 1958, EL 12345. Ring +47 912 34 567.";
    expect(vault.redact(text, builtinDetectors)).toBe(
      "Kari Nordby bor på Sørumsand, HA på hass.kjeks.dev, POST to NSR:StopPlace:58404, født 3. mai 1958, EL 12345. Ring ⟦PHONE1⟧.",
    );
  });
});
