import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { collectGeneratedImages } from "../../src/images.js";

describe("collectGeneratedImages", () => {
  const tempBase = join(os.tmpdir(), `acp-test-images-${Date.now()}`);
  const tempHome = join(tempBase, "home");
  const tempCwd = join(tempBase, "cwd");
  const conversationId = "conv-123";
  const brainDir = join(tempHome, ".gemini", "antigravity-cli", "brain", conversationId);

  beforeAll(() => {
    mkdirSync(brainDir, { recursive: true });
    mkdirSync(tempCwd, { recursive: true });
  });

  afterAll(() => {
    try {
      rmSync(tempBase, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it("copies only new image files and handles duplicates", () => {
    const now = Date.now();
    const past = now - 10000;
    const sinceMs = now - 5000;

    const newPng = join(brainDir, "new-image.png");
    const oldPng = join(brainDir, "old-image.png");
    const notAnImage = join(brainDir, "notes.txt");

    writeFileSync(newPng, "new file content");
    writeFileSync(oldPng, "old file content");
    writeFileSync(notAnImage, "text content");

    // Adjust mtime
    const nowSecs = now / 1000;
    const pastSecs = past / 1000;
    utimesSync(newPng, nowSecs, nowSecs);
    utimesSync(oldPng, pastSecs, pastSecs);
    utimesSync(notAnImage, nowSecs, nowSecs);

    // Run collector
    const results = collectGeneratedImages({
      home: tempHome,
      conversationId,
      cwd: tempCwd,
      sinceMs,
    });

    // Expecting only the new image to be returned
    expect(results).toHaveLength(1);
    expect(results[0]!.name).toBe("new-image.png");
    expect(results[0]!.src).toBe(newPng);
    expect(results[0]!.bytes).toBe(16); // "new file content" is 16 bytes

    const copiedPath = join(tempCwd, ".acp-images", "new-image.png");
    expect(results[0]!.dest).toBe(copiedPath);
    expect(existsSync(copiedPath)).toBe(true);

    // Also verify notes.txt and old-image.png were not copied
    expect(existsSync(join(tempCwd, ".acp-images", "old-image.png"))).toBe(false);
    expect(existsSync(join(tempCwd, ".acp-images", "notes.txt"))).toBe(false);

    // Run again with the same file to verify counter/suffix duplication logic works
    const results2 = collectGeneratedImages({
      home: tempHome,
      conversationId,
      cwd: tempCwd,
      sinceMs,
    });
    expect(results2).toHaveLength(1);
    expect(results2[0]!.name).toBe("new-image_1.png");
    const duplicateCopiedPath = join(tempCwd, ".acp-images", "new-image_1.png");
    expect(results2[0]!.dest).toBe(duplicateCopiedPath);
    expect(existsSync(duplicateCopiedPath)).toBe(true);
  });
});
