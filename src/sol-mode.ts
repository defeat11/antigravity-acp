import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const SOL_FILE_NAME = "SOL-MODE.md";

let cachedSolContent: string | null = null;

/**
 * Reads the SOL mode preamble from the SOL-MODE.md file if it exists.
 * Environment variables ACP_SOL_MODE and ACP_SOL_FILE control its behavior.
 */
export function readSolPreamble(): string {
  const solMode = process.env["ACP_SOL_MODE"];
  if (solMode === "0" || solMode === "off") {
    return "";
  }

  if (cachedSolContent !== null) {
    return cachedSolContent;
  }

  const solFileEnv = process.env["ACP_SOL_FILE"];
  const filePath = solFileEnv && solFileEnv.trim() !== ""
    ? solFileEnv
    : join(dirname(dirname(fileURLToPath(import.meta.url))), SOL_FILE_NAME);

  try {
    if (!existsSync(filePath)) {
      return "";
    }
    const content = readFileSync(filePath, "utf8");
    // Cap content at 9000 chars (slice head, not tail)
    const sliced = content.slice(0, 9000);
    const wrapped = "## SOL MODE (mandatory engineering discipline)\n" + sliced + "\n\n---\n";
    cachedSolContent = wrapped;
    return wrapped;
  } catch {
    return "";
  }
}

/**
 * Helper function to clear the cached SOL content (primarily for unit tests).
 */
export function clearSolCache(): void {
  cachedSolContent = null;
}
