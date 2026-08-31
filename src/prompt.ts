/**
 * Translate ACP prompt content into the single text prompt that `agy --print`
 * accepts, and assemble per-session conversation context.
 *
 * agy print mode takes one text prompt, so richer ACP content blocks are
 * flattened into a readable textual form (with clearly marked file references).
 */

import type { ContentBlock } from "@agentclientprotocol/sdk";
import type { Turn } from "./session.js";

export interface RenderedPrompt {
  readonly text: string;
  /** Human-readable notes about content we could not pass losslessly. */
  readonly warnings: readonly string[];
}

export function renderPrompt(blocks: readonly ContentBlock[]): RenderedPrompt {
  const parts: string[] = [];
  const warnings: string[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case "text":
        parts.push(block.text);
        break;

      case "resource_link":
        parts.push(formatResourceLink(block.uri, block.name));
        break;

      case "resource": {
        const res = block.resource;
        if ("text" in res && typeof res.text === "string") {
          parts.push(formatEmbeddedText(res.uri, res.text));
        } else {
          warnings.push(`Skipped binary embedded resource: ${res.uri}`);
          parts.push(`[Attached binary resource: ${res.uri}]`);
        }
        break;
      }

      case "image":
        warnings.push("Image content is not supported by agy print mode and was omitted.");
        parts.push("[An image was attached but cannot be forwarded to the CLI.]");
        break;

      case "audio":
        warnings.push("Audio content is not supported by agy print mode and was omitted.");
        parts.push("[Audio was attached but cannot be forwarded to the CLI.]");
        break;

      default:
        warnings.push(`Skipped unknown content block: ${(block as { type: string }).type}`);
    }
  }

  return { text: parts.join("\n\n").trim(), warnings };
}

function formatResourceLink(uri: string, name: string): string {
  const path = fileUriToPath(uri);
  return path ? `@${path}` : `Referenced resource: ${name} (${uri})`;
}

function formatEmbeddedText(uri: string, text: string): string {
  const label = fileUriToPath(uri) ?? uri;
  return `--- Embedded context from ${label} ---\n${text}\n--- end of ${label} ---`;
}

function fileUriToPath(uri: string): string | null {
  if (!uri.startsWith("file://")) return null;
  try {
    const u = new URL(uri);
    let p = decodeURIComponent(u.pathname);
    // Windows file URLs look like file:///C:/path -> strip the leading slash.
    if (/^\/[A-Za-z]:/.test(p)) p = p.slice(1);
    return p;
  } catch {
    return null;
  }
}

/**
 * Build a compact transcript preamble of prior turns, newest-biased, capped at
 * `maxChars`. Used only when conversation continuity can't be delegated to agy
 * (persist=transcript, or interleaved sessions with persist=continue).
 */
export function buildContextPreamble(turns: readonly Turn[], maxChars: number): string {
  if (turns.length === 0) return "";

  const rendered: string[] = [];
  let total = 0;
  // Walk newest -> oldest so the most recent context survives the cap.
  for (let i = turns.length - 1; i >= 0; i--) {
    const turn = turns[i]!;
    const speaker = turn.role === "user" ? "User" : "Assistant";
    const entry = `${speaker}: ${turn.text}`;
    if (total + entry.length > maxChars) break;
    rendered.unshift(entry);
    total += entry.length;
  }

  if (rendered.length === 0) return "";
  return (
    "Earlier conversation in this session (for context only, do not repeat it):\n" +
    rendered.join("\n\n") +
    "\n\n---\n\n"
  );
}
