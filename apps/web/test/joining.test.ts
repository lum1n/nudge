import type { Sealed } from "@nudge/client";
import { describe, expect, it } from "vitest";
import { isThisServer, joinPage, parseJoinLink, readJoinPage } from "../src/joining.ts";

const SEALED: Sealed = { v: 1, epk: "e", iv: "i", data: "d+/=&", tag: "t" };

describe("parseJoinLink", () => {
  it("reads the link an invite gives", () => {
    expect(
      parseJoinLink(" nudge://join?server=https%3A%2F%2Fnudge.example.com&assistant=robin "),
    ).toEqual({ server: "https://nudge.example.com", assistant: "robin" });
  });

  it("keeps the server as the link has it, which the assistant there checks exactly", () => {
    expect(parseJoinLink("nudge://join?server=http://h.wired:8080/&assistant=a")?.server).toBe(
      "http://h.wired:8080/",
    );
  });

  it("takes a server and an assistant typed in apart", () => {
    expect(parseJoinLink("https://nudge.example.com robin")).toEqual({
      server: "https://nudge.example.com",
      assistant: "robin",
    });
  });

  it("refuses anything else", () => {
    expect(parseJoinLink("nudge://pair?server=https://x&code=ABCD-1234")).toBeUndefined();
    expect(parseJoinLink("nudge://join?server=https://x")).toBeUndefined();
    expect(parseJoinLink("nudge://join?server=ftp://x&assistant=a")).toBeUndefined();
    expect(parseJoinLink("https://nudge.example.com")).toBeUndefined();
    expect(parseJoinLink("hello there friend")).toBeUndefined();
    expect(parseJoinLink("")).toBeUndefined();
  });
});

describe("isThisServer", () => {
  it("compares origins", () => {
    expect(isThisServer("https://nudge.example.com/", "https://nudge.example.com")).toBe(true);
    expect(isThisServer("https://nudge.example.com:8443", "https://nudge.example.com")).toBe(false);
    expect(isThisServer("not a url", "https://nudge.example.com")).toBe(false);
  });
});

describe("joinPage", () => {
  it("hands the assertion to the other server's page in the fragment", () => {
    const page = joinPage({ server: "https://other.example.com/", assistant: "robin" }, SEALED);
    const url = new URL(page);
    expect(url.origin + url.pathname).toBe("https://other.example.com/join");
    expect(url.search).toBe("");
    expect(readJoinPage(url.hash)).toEqual({ assistant: "robin", assertion: SEALED });
  });

  it("reads nothing from a fragment that isn't a join's", () => {
    expect(readJoinPage("")).toBeUndefined();
    expect(readJoinPage("#assistant=robin")).toBeUndefined();
    expect(readJoinPage("#assistant=robin&assertion=nope")).toBeUndefined();
    expect(readJoinPage(`#assistant=robin&assertion=${encodeURIComponent('{"v":2}')}`)).toBe(
      undefined,
    );
  });
});
