/**
 * Classifies a failure error to help pinpoint the category of error.
 */
export function classifyFailure(err: unknown): string {
  try {
    const message = (err as { message?: string })?.message ?? String(err);

    if (/not logged|authenticat/i.test(message)) {
      return "auth_required";
    }
    if (/ETIMEDOUT|timed out|\btimeout\b/i.test(message)) {
      return "timeout";
    }
    if (/ECONNRESET|ECONNREFUSED|ENOTFOUND|EPIPE|fetch failed|network/i.test(message)) {
      return "network";
    }
    if (/exit code|spawn.*ENOENT|closed unexpectedly|process exited|unexpected end|stream closed/i.test(message)) {
      return "agy_crashed";
    }
    if (/protocol|invalid response|unexpected message/i.test(message)) {
      return "protocol";
    }
    return "failed";
  } catch {
    return "failed";
  }
}

/**
 * Extracts a concise summary and truncated call stack from an error.
 */
export function buildErrorDetail(err: unknown): { message: string; stack: string[] } {
  try {
    const message = (err as { message?: string })?.message ?? String(err);
    const rawStack = (err as { stack?: string })?.stack;
    const stack: string[] = [];

    if (rawStack && typeof rawStack === "string") {
      const lines = rawStack.split(/\r?\n/);
      const limit = Math.min(lines.length, 3);
      for (let i = 0; i < limit; i++) {
        stack.push(lines[i]!.trim());
      }
    }

    return { message, stack };
  } catch {
    return { message: String(err), stack: [] };
  }
}
