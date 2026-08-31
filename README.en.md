# antigravity-acp

[العربية](README.md)

**A text instruction goes in — executed code, verified by a real exit code, comes out.**

An Agent Client Protocol (ACP) adapter written in TypeScript: 21,029 source lines and 533 test cases across 69 files.

It turns a CLI tool into a sub-agent inside any editor that speaks ACP. On top of it sits an orchestration layer that runs several agents in parallel, and a verification layer that does not take the agent's word for anything. Built and tested on Windows and Ubuntu in CI on every push.

---

## The problem

An agent writes "verified, tests pass." That is a sentence, not evidence. The model produces the same sentence whether the command succeeded or failed.

Three practical problems:

1. A claim with no proof. Nobody actually runs the build command.
2. One task at a time. The rest of the CPU cores sit idle.
3. An analysis task that ends by editing files nobody asked it to touch.

This tool handles all three.

---

## How it works

| Component | What it does |
|---|---|
| The adapter | Every ACP conversation turn becomes one CLI run, streamed as a tool call, cancellable through `session/cancel` |
| `delegate` | One task, a live viewer in the browser, and a compact summary instead of the full stream |
| `fanout` | Independent tasks in parallel, each in its own isolated working copy (a git worktree with `--worktree`) |
| `swarm` | One goal, split up: a planner hands out disjoint files → parallel execution → verification → a single repair pass |
| `capacity` | Measures the memory of a real run and recommends how many parallel agents this machine can take |
| `verify` | Runs the build or test command and reads the exit code |

---

## The key design decision

### 1. Verification reads the exit code, not the agent's prose

**Problem:** the agent writes the word "verified" in its text without running anything.

**Decision:** the adapter runs the verification command itself, as a child process, and prints its real exit code on a `verified: true (exit 0)` line. The timeout is 180 seconds, and the last 40,000 characters of output are kept.

**Payoff:** after the same command fails twice in a row, it prints `ESCALATE` instead of a third blind attempt. **Cost:** one build-command run per task.

### 2. Read-only is enforced by snapshot and restore

**Problem:** the sub-agent writes to disk. "Do not modify anything" is an instruction, not a guarantee.

**Decision:** before an analysis task the file tree is snapshotted, and afterwards it is restored. Every changed file is reverted, and every new file is deleted.

**Measured limits:** 5,000 files, 4 MB per file, 80 MB in total. The snapshot skips `.git`, `node_modules` and `dist`. Past the limit the snapshot is cancelled rather than handing back a false guarantee.

### 3. A guard on config files

**Problem:** the fastest way to make a test pass is to edit the config file, not to fix the code.

**Decision:** after every task the adapter compares the changed files against six watched config names, among them `tsconfig.json`, `.eslintrc*` and `.acp-verify`, and against three sensitive fields in `package.json`: `eslintConfig`, `scripts.lint` and `scripts.test`.

If one of them changed without being named in the task text, `config_tamper: BLOCKED` is printed and the verification does not count.

---

## Running it

Needs Node.js 20 or newer, plus an agent CLI installed and logged in.

```bash
npm ci && npm run build
acp init .
acp "add a /health route and a test for it" --verify "npm test"
```

| Flag | Effect |
|---|---|
| `--verify "<cmd>"` | The adapter runs the command and prints its exit code. A failure makes the program exit non-zero |
| `--read-only` | Snapshot and restore: anything the agent writes is reverted |
| `--session <name>` | A persistent session per project; the next edit resumes the same conversation |
| `--json` | Structured result: files, tools, summary, verification, timing |

An excerpt of the output once the task finishes:

```
===== ACP-DELEGATE-RESULT =====
status: ok
session: main (resumed · pinned)
stopReason: end_turn
elapsed: 14.2s
files_touched: server.js, server.test.js
tool_calls: 2
verified: true (exit 0)
scope: ok
viewer: http://127.0.0.1:57868
===============================
```

The two lines that matter are `verified` and `scope`. The first is a real exit code. The second compares the files that changed against the files the agent said it touched.

---

## Why I built it

I work as an IT supervisor and I run coding tasks in parallel; by default the tool runs one agent per two CPU cores.

I was reviewing claims nobody had measured, so I built a layer that reads the exit code instead of me.
