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

describe("always approving terminal commands, at the edges", () => {
  it("keys by the program as typed, past spaces and variable settings", () => {
    expect(ruleFor("  npm test  ").rule?.key).toBe("npm");
    expect(ruleFor("./scripts/build.sh --fast").rule?.key).toBe("./scripts/build.sh");
    expect(ruleFor("A=1 B=two make").rule?.key).toBe("make");
    expect(ruleFor("g++ -O2 main.cc").rule?.key).toBe("g++");
  });

  it("offers nothing for commands that span lines, escape, group or start with a wrapper", () => {
    for (const command of [
      "",
      "   ",
      "ls\nrm -rf ~",
      "ls \\\n; rm x",
      "(rm x)",
      "{ rm x; }",
      "ls & rm x",
      "cat < secret",
      "zsh -c ls",
      "sh script",
      "xargs rm",
      "nohup rm x",
      "time rm x",
      "exec rm x",
      "eval rm",
      "A=1 sudo ls",
      "'quoted' arg",
    ])
      expect(ruleFor(command), JSON.stringify(command)).toEqual({});
  });

  it("does not take a wrapper's name inside a longer program name", () => {
    expect(ruleFor("envsubst --help").rule?.key).toBe("envsubst");
    expect(ruleFor("bashate file.sh").rule?.key).toBe("bashate");
  });
});
