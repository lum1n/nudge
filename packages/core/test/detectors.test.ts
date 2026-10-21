import { describe, expect, it } from "vitest";
import { builtinDetectors, Vault } from "../src/index.ts";
import { domainDetector, ipDetector, usernameDetector } from "../src/privacy/hosts.ts";
import { orgDetector, placeDetector } from "../src/privacy/places.ts";
import {
  birthDateDetector,
  phoneCueDetector,
  type PiiDetector,
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
        builtinDetectors,
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
    expect(vault.redact(text, builtinDetectors)).toBe(
      "Vi bor på ⟦PLACE1⟧, barnet går i ⟦ORG1⟧ Barnehage, HA er på ⟦DOMAIN1⟧, Tesla Model Y 2022 med 65 000 km, ISO 27001, år 2022.",
    );
  });
});
