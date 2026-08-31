import { describe, it, expect } from "vitest";
import { tmpdir } from "node:os";
import {
  readVarint,
  walkFields,
  isProse,
  guessKind,
  readConversation,
} from "../../src/conversation-store.js";

describe("readVarint", () => {
  it("reads a single-byte varint", () => {
    expect(readVarint(Buffer.from([0x0e]), 0)).toEqual([14n, 1, true]);
  });
  it("reads a multi-byte varint (300)", () => {
    const [value, , complete] = readVarint(Buffer.from([0xac, 0x02]), 0);
    expect(value).toBe(300n);
    expect(complete).toBe(true);
  });
  it("flags a truncated varint as incomplete", () => {
    const [, , complete] = readVarint(Buffer.from([0x80]), 0);
    expect(complete).toBe(false);
  });
});

describe("walkFields", () => {
  it("decodes a varint field (tag 1)", () => {
    const fields = [...walkFields(Buffer.from([0x08, 0x0e]))];
    expect(fields[0]).toMatchObject({ field: 1, wire: 0, varint: 14n });
  });
  it("decodes a length-delimited string field (tag 2)", () => {
    const fields = [...walkFields(Buffer.from([0x12, 0x02, 0x68, 0x69]))];
    expect(fields[0]!.field).toBe(2);
    expect(fields[0]!.bytes!.toString("utf8")).toBe("hi");
  });
  it("stops on malformed input instead of looping", () => {
    expect([...walkFields(Buffer.from([0x80]))]).toEqual([]);
  });
});

describe("isProse", () => {
  it.each([
    ["I have created the file hello.js. DONE", true],
    ["OK", true],
    ["bot-610ac3b8-5ba0-4a1f-b093-645b5709730f", false],
    ['{"CodeContent":"x"}', false],
    ["cb219704-28f6-4f75-9957-d4370cfacc1a", false],
    ["qf3nacye", false],
    ["lu9bbje9", false],
    ["", false],
  ])("%s -> %s", (input, expected) => {
    expect(isProse(input as string)).toBe(expected);
  });
});

describe("guessKind", () => {
  it.each([
    ["write_to_file", "edit"],
    ["edit_file", "edit"],
    ["run_command", "execute"],
    ["read_file", "read"],
    ["search_codebase", "search"],
    ["delete_file", "delete"],
    ["xyzzy_tool", "other"],
  ])("%s -> %s", (name, kind) => {
    expect(guessKind(name as string)).toBe(kind);
  });
});

// The golden-fixture cases that used to live here read a real agent
// conversation database. That file is local machine state, not source, so it
// is not part of this repository and those two cases were dropped with it.
describe("readConversation", () => {
  it("rejects a non-UUID conversation id (path-traversal guard)", () => {
    expect(readConversation(tmpdir(), "../../etc/passwd", -1)).toBeNull();
  });
});
