import { describe, expect, it } from "vitest";
import { CliArgError, HELP_TEXT, parseArgs } from "../args.js";

describe("parseArgs", () => {
  it("parses the required flags", () => {
    const options = parseArgs(["--input", "in.json", "--output", "out", "--package", "com.test"]);
    expect(options).toMatchObject({
      input: "in.json",
      output: "out",
      packageName: "com.test",
      prefix: undefined,
      excludeMode: undefined,
      layout: "flat",
      dryRun: false,
      check: false,
      onUnresolved: {},
    });
  });

  it("parses all optional flags, including a repeatable --on-unresolved", () => {
    const options = parseArgs([
      "--input",
      "in.json",
      "--output",
      "out",
      "--package",
      "com.test",
      "--prefix",
      "DT",
      "--exclude-mode",
      "ios",
      "--on-unresolved",
      "unsupported-value=warn",
      "--on-unresolved",
      "missing-alias-target=silent",
      "--dry-run",
    ]);
    expect(options.prefix).toBe("DT");
    expect(options.excludeMode).toBeInstanceOf(RegExp);
    expect(options.excludeMode?.test("ios-only")).toBe(true);
    expect(options.onUnresolved).toEqual({
      "unsupported-value": "warn",
      "missing-alias-target": "silent",
    });
    expect(options.dryRun).toBe(true);
  });

  it("throws for a missing required flag, listing every missing one", () => {
    expect(() => parseArgs(["--package", "com.test"])).toThrow(/--input, --output/);
  });

  it("throws for an unknown flag", () => {
    expect(() => parseArgs(["--bogus"])).toThrow(CliArgError);
  });

  it("throws when a flag's value is missing", () => {
    expect(() => parseArgs(["--input"])).toThrow(/--input requires a value/);
  });

  it("throws for a malformed --on-unresolved (no '=')", () => {
    expect(() =>
      parseArgs(["--input", "i", "--output", "o", "--package", "p", "--on-unresolved", "bogus"]),
    ).toThrow(/expects/);
  });

  it("throws for an unknown reason or action in --on-unresolved", () => {
    expect(() =>
      parseArgs([
        "--input",
        "i",
        "--output",
        "o",
        "--package",
        "p",
        "--on-unresolved",
        "not-a-reason=warn",
      ]),
    ).toThrow(/unknown reason/);
    expect(() =>
      parseArgs([
        "--input",
        "i",
        "--output",
        "o",
        "--package",
        "p",
        "--on-unresolved",
        "unsupported-value=maybe",
      ]),
    ).toThrow(/unknown action/);
  });

  it("rejects --dry-run combined with --check", () => {
    expect(() =>
      parseArgs(["--input", "i", "--output", "o", "--package", "p", "--dry-run", "--check"]),
    ).toThrow(/mutually exclusive/);
  });

  it("--help throws the help text itself, not an error condition", () => {
    expect(() => parseArgs(["--help"])).toThrow(HELP_TEXT);
  });

  it("parses --layout legacy", () => {
    const options = parseArgs([
      "--input",
      "i",
      "--output",
      "o",
      "--package",
      "p",
      "--layout",
      "legacy",
    ]);
    expect(options.layout).toBe("legacy");
  });

  it("throws for an unknown --layout value", () => {
    expect(() =>
      parseArgs(["--input", "i", "--output", "o", "--package", "p", "--layout", "bogus"]),
    ).toThrow(/--layout expects/);
  });
});
