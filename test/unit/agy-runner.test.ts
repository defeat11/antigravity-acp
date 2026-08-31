import { describe, it, expect } from "vitest";
import { AgyRunner, type AgyRunOptions } from "../../src/agy-runner.js";
import { loadConfig } from "../../src/config.js";
import { createLogger } from "../../src/logger.js";

function runner(env: NodeJS.ProcessEnv = {}): AgyRunner {
  return new AgyRunner(loadConfig(env), createLogger("error"));
}

const baseOpts: AgyRunOptions = {
  prompt: "do x",
  cwd: "C:/proj",
  additionalDirectories: [],
  conversationId: null,
  signal: new AbortController().signal,
  onStdout: () => {},
};

describe("AgyRunner.buildArgs", () => {
  it("includes model, auto-permission, timeout, and prompt last", () => {
    const args = runner().buildArgs(baseOpts);
    expect(args).toContain("--model");
    expect(args).toContain("gemini-3.6-flash-high");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--print-timeout");
    expect(args[args.length - 1]).toBe("--print=do x");
  });

  it("uses --conversation when an id is provided", () => {
    const args = runner().buildArgs({ ...baseOpts, conversationId: "abc-1" });
    expect(args).toContain("--conversation");
    expect(args).toContain("abc-1");
  });

  it("starts a fresh conversation (no --conversation) when no id", () => {
    const args = runner().buildArgs(baseOpts);
    expect(args).not.toContain("--conversation");
    expect(args).not.toContain("--continue");
  });

  it("passes --new-project when starting fresh, so agy actually uses cwd instead of its own resolved project", () => {
    const args = runner().buildArgs(baseOpts);
    expect(args).toContain("--new-project");
  });

  it("omits --new-project when resuming a conversation (it already has its own project)", () => {
    const args = runner().buildArgs({ ...baseOpts, conversationId: "abc-1" });
    expect(args).not.toContain("--new-project");
  });

  it("omits --model when configured empty", () => {
    const args = runner({ ACP_AGY_MODEL: "" }).buildArgs(baseOpts);
    expect(args).not.toContain("--model");
  });

  it("adds --sandbox in sandbox mode", () => {
    const args = runner({ ACP_AGY_PERMISSION_MODE: "sandbox" }).buildArgs(baseOpts);
    expect(args).toContain("--sandbox");
    expect(args).toContain("--dangerously-skip-permissions");
  });

  it("passes a --log-file when provided", () => {
    const args = runner().buildArgs(baseOpts, "C:/tmp/run.log");
    expect(args).toContain("--log-file");
    expect(args).toContain("C:/tmp/run.log");
  });

  it("forwards additional directories", () => {
    const args = runner().buildArgs({ ...baseOpts, additionalDirectories: ["C:/a", "C:/b"] });
    const joined = args.join(" ");
    expect(joined).toContain("--add-dir C:/a");
    expect(joined).toContain("--add-dir C:/b");
  });
});
