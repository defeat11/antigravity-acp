import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Strips surrounding double or single quotes from a string if present.
 */
function stripQuotes(s: string): string {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

/**
 * Parses the .env file in cwd and extracts non-sensitive, non-empty secret values.
 */
function parseEnvValues(cwd: string): string[] {
  const envPath = join(cwd, ".env");
  try {
    if (!existsSync(envPath)) {
      return [];
    }
    const content = readFileSync(envPath, "utf8");
    const lines = content.split(/\r?\n/);
    const values = new Set<string>();
    const lineRegex = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.+?)\s*$/;
    const excluded = new Set(["true", "false", "localhost", "development", "production", "0", "1"]);

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }
      const match = trimmed.match(lineRegex);
      if (match) {
        let val = match[2]!.trim();
        val = stripQuotes(val);
        if (val.length >= 6 && !excluded.has(val.toLowerCase())) {
          values.add(val);
        }
      }
    }
    return Array.from(values);
  } catch {
    return [];
  }
}

/**
 * Redacts well-known API keys, tokens, and .env-defined values from the provided text.
 */
export function redactSecrets(text: string, cwd: string): string {
  if (!text || typeof text !== "string") {
    return text;
  }
  try {
    let result = text;
    // 1. telegram-token
    result = result.replace(/\b\d{8,10}:[A-Za-z0-9_-]{35}\b/g, "[REDACTED:telegram-token]");
    // 2. openai-key
    result = result.replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "[REDACTED:openai-key]");
    // 3. github-token
    result = result.replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED:github-token]");
    // 4. aws-key
    result = result.replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED:aws-key]");
    // 5. google-key
    result = result.replace(/\bAIza[0-9A-Za-z_-]{35}\b/g, "[REDACTED:google-key]");

    // Env values
    const envValues = parseEnvValues(cwd);
    for (const val of envValues) {
      if (val && result.includes(val)) {
        result = result.split(val).join("[REDACTED:env]");
      }
    }

    return result;
  } catch {
    return text;
  }
}
