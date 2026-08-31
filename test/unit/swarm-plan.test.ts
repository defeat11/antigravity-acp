import { describe, it, expect } from "vitest";
import { extractJsonObject } from "../../src/swarm.js";

describe("extractJsonObject unit tests", () => {
  it("should extract valid JSON object even with surrounding prose", () => {
    const text = `
      Some introductory prose...
      {"contract": "interface Foo {}", "subtasks": [{"id": "t1", "task": "do something"}]}
      Some concluding prose...
    `;
    const result = extractJsonObject(text);
    expect(result).toEqual({
      contract: "interface Foo {}",
      subtasks: [{ id: "t1", task: "do something" }],
    });
  });

  it("should return null for text containing only a JSON array", () => {
    const text = `[{"id": "t1", "task": "do something"}]`;
    const result = extractJsonObject(text);
    expect(result).toBeNull();
  });

  it("should return null for text with no JSON object structure", () => {
    const text = "plain text with no brackets at all";
    const result = extractJsonObject(text);
    expect(result).toBeNull();
  });

  it("should return null for malformed JSON object (missing closing brace)", () => {
    const text = `{"contract": "interface Foo {}"`;
    const result = extractJsonObject(text);
    expect(result).toBeNull();
  });
});
