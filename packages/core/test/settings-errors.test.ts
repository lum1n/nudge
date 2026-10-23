import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { settingsProblems } from "../src/extensions/settings-errors.ts";

const Settings = Type.Object({
  hosts: Type.Array(
    Type.Object({
      name: Type.String({ pattern: "^[a-z]+$", description: "Lowercase letters only." }),
      port: Type.Optional(Type.Number()),
      auth: Type.Optional(Type.Union([Type.Literal("key"), Type.Literal("agent")])),
      user: Type.String({ minLength: 1, title: "User name" }),
    }),
  ),
  approveStart: Type.Boolean(),
});

describe("settingsProblems", () => {
  it("says what is wrong in the words of the settings form", () => {
    expect(
      settingsProblems(Settings, {
        hosts: [{ name: "10.0.0.2", port: "22", auth: "password", user: "" }],
        approveStart: true,
      }),
    ).toEqual([
      'Hosts › 1 › Name: "10.0.0.2" isn\'t valid here. Lowercase letters only.',
      "Hosts › 1 › Port: must be a number.",
      'Hosts › 1 › Auth: must be one of "key", "agent".',
      "Hosts › 1 › User name: can't be empty.",
    ]);
  });

  it("names what is missing", () => {
    expect(settingsProblems(Settings, { hosts: [{ name: "box" }] })).toEqual([
      "Approve start: is missing.",
      "Hosts › 1 › User name: is missing.",
    ]);
  });
});
