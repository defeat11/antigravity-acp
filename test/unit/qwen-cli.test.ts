import { describe, it, expect } from "vitest";
import { parseQwenArgs } from "../../src/qwen-cli.js";

describe("qwen-cli argument parsing & pure logic", () => {
  it("parses single question argument correctly", () => {
    const res = parseQwenArgs(["What is Node.js?"]);
    expect(res.question).toBe("What is Node.js?");
    expect(res.session).toBeUndefined();
    expect(res.isNew).toBeUndefined();
  });

  it("parses question with --session and --new flags", () => {
    const res = parseQwenArgs(["Explain Quantum Computing", "--session", "physics", "--new"]);
    expect(res.question).toBe("Explain Quantum Computing");
    expect(res.session).toBe("physics");
    expect(res.isNew).toBe(true);
  });

  it("parses --vip, --redact, --no-redact, --deep, and --retries flags", () => {
    const res = parseQwenArgs([
      "Evaluate CV",
      "--vip",
      "John Doe",
      "--redact",
      "Acme Corp,Secret Project",
      "--no-redact",
      "--deep",
      "--retries",
      "2",
    ]);

    expect(res.question).toBe("Evaluate CV");
    expect(res.vip).toBe("John Doe");
    expect(res.redact).toEqual(["Acme Corp", "Secret Project"]);
    expect(res.noRedact).toBe(true);
    expect(res.deep).toBe(true);
    expect(res.retries).toBe(2);
  });

  it("parses subcommands list, show, stats, export, resume", () => {
    const resList = parseQwenArgs(["list", "--limit", "10", "--search", "test", "--since", "2026-08-01"]);
    expect(resList.subcommand).toBe("list");
    expect(resList.limit).toBe(10);
    expect(resList.search).toBe("test");
    expect(resList.since).toBe("2026-08-01");

    const resShow = parseQwenArgs(["show", "12345678"]);
    expect(resShow.subcommand).toBe("show");
    expect(resShow.id).toBe("12345678");

    const resStats = parseQwenArgs(["stats", "--json"]);
    expect(resStats.subcommand).toBe("stats");
    expect(resStats.isJson).toBe(true);

    const resExport = parseQwenArgs(["export", "--format", "md", "--session", "work"]);
    expect(resExport.subcommand).toBe("export");
    expect(resExport.format).toBe("md");
    expect(resExport.session).toBe("work");

    const resResume = parseQwenArgs(["resume", "--session", "work"]);
    expect(resResume.subcommand).toBe("resume");
    expect(resResume.session).toBe("work");
  });

  it("returns help subcommand when --help or -h is passed", () => {
    const resHelp = parseQwenArgs(["--help"]);
    expect(resHelp.subcommand).toBe("help");
  });
});
