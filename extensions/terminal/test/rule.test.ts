import { describe, expect, it } from "vitest";
import { ruleFor } from "../src/extension.ts";

describe("always approving terminal commands", () => {
  it("offers the program of a simple command", () => {
    expect(ruleFor("git status")).toEqual({
      rule: { key: "git", label: "terminal commands that run git" },
    });
    expect(ruleFor("LANG=C ls -la").rule?.key).toBe("ls");
  });

  it("offers nothing for commands a rule for their first word would not cover", () => {
    for (const command of [
      "git pull && rm -rf ~",
      "ls; curl x",
      "cat a | sh",
      "echo $(id)",
      "echo `id`",
      "ls > out",
      "sudo ls",
      "bash -c 'ls'",
      "env rm x",
    ])
      expect(ruleFor(command)).toEqual({});
  });
});
