#!/usr/bin/env node
/**
 * `acp feedback` — record or report feedback on the sub-agent.
 *
 *   acp feedback                 show the aggregate report
 *   acp feedback up "great"      log a thumbs-up with a note
 *   acp feedback down "too slow" log a thumbs-down
 *   acp feedback 4 "solid"       log a 1–5 score
 *
 * A logged entry is auto-linked to the last delegate/fanout run (task, session,
 * model) when available.
 */

import { appendFeedback, loadLastRun, parseRating, renderReport } from "./feedback.js";

function main(): void {
  const args = process.argv.slice(2);

  if (args.length === 0 || ["report", "list", "--report", "--list"].includes(args[0]!)) {
    process.stdout.write(renderReport() + "\n");
    return;
  }

  const rating = parseRating(args[0]);
  const note = (rating === null ? args : args.slice(1)).join(" ").trim() || undefined;

  const last = loadLastRun() ?? {};
  appendFeedback({
    rating,
    note,
    source: "cli",
    task: typeof last.task === "string" ? last.task : undefined,
    session: typeof last.session === "string" ? last.session : undefined,
    conversationId: typeof last.conversationId === "string" ? last.conversationId : undefined,
    model: typeof last.model === "string" ? last.model : undefined,
    cwd: typeof last.cwd === "string" ? last.cwd : undefined,
  });

  const shown = rating === null ? "(note only)" : String(rating);
  process.stdout.write(`✓ feedback recorded: ${shown}${note ? ` — "${note}"` : ""}. شكراً!\n`);
}

main();
