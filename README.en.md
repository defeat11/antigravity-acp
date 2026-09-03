# antigravity-acp

[العربية](README.md)

**You give it a text instruction. It runs the code, and a real exit code proves the result.**

An Agent Client Protocol (ACP) adapter written in TypeScript. It has 21,029 source lines and 533 test cases across 69 files.

It turns a CLI tool into a sub-agent inside any editor that speaks ACP. Two layers sit on top of it. One layer runs several agents in parallel. The other layer checks the work, and it never trusts what the agent says. CI builds and tests it on Windows and Ubuntu on every push.

---

## The problem

An agent writes "verified, tests pass." That is a sentence, not proof. The model writes the same sentence when the command passes and when it fails.

Three practical problems:

1. A claim with no proof. Nobody actually runs the build command.
2. One task at a time. The rest of the CPU cores sit idle.
3. An analysis task that edits files nobody asked it to touch.

This tool fixes all three.

---

## How it works

| Component | What it does |
|---|---|
| The adapter | Every ACP conversation turn becomes one CLI run. It streams as a tool call, and `session/cancel` stops it |
| `delegate` | One task. You get a live viewer in the browser. The summary is short, not the full stream |
| `fanout` | Runs separate tasks in parallel. Each task gets its own working copy (a git worktree with `--worktree`) |
| `swarm` | One goal, split up. A planner gives each agent its own files → parallel run → verification → one repair pass |
| `capacity` | Measures the memory of a real run. Then it says how many parallel agents this machine can take |
| `verify` | Runs the build or test command and reads the exit code |

---

## The key design decision

### 1. Verification reads the exit code, not the agent's prose

**Problem:** the agent writes the word "verified" in its text without running anything.

**Decision:** the adapter runs the verification command itself, as a child process. It prints the real exit code on a `verified: true (exit 0)` line. The timeout is 180 seconds. It keeps the last 40,000 characters of output.

**Payoff:** when the same command fails twice in a row, it prints `ESCALATE`. There is no third blind attempt. **Cost:** one build-command run per task.

### 2. Read-only is enforced by snapshot and restore

**Problem:** the sub-agent writes to disk. "Do not modify anything" is an instruction, not a guarantee.

**Decision:** before an analysis task, the adapter takes a snapshot of the file tree. After the task it restores the tree. It reverts every changed file and deletes every new file.

**Measured limits:** 5,000 files, 4 MB per file, 80 MB in total. The snapshot skips `.git`, `node_modules` and `dist`. Above the limit it cancels the snapshot instead of giving a false guarantee.

### 3. A guard on config files

**Problem:** the fastest way to pass a test is to edit the config file. Fixing the code is slower.

**Decision:** after every task the adapter checks the changed files. It compares them against six watched config names, among them `tsconfig.json`, `.eslintrc*` and `.acp-verify`. It also checks three sensitive fields in `package.json`: `eslintConfig`, `scripts.lint` and `scripts.test`.

The task text must name any change to them. If it does not, the adapter prints `config_tamper: BLOCKED`. The verification does not count.

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
| `--read-only` | Snapshot and restore. It reverts anything the agent writes |
| `--session <name>` | One saved session per project. The next edit resumes the same conversation |
| `--json` | Structured result: files, tools, summary, verification, timing |

Part of the output after the task finishes:

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

The two lines that matter are `verified` and `scope`. The first is a real exit code. The second compares two lists of files. One list is the files that changed. The other is the files the agent said it touched.

---

## Why I built it

I work as an IT supervisor, and I run coding tasks in parallel. By default the tool runs one agent per two CPU cores.

I was reviewing claims that nobody measured. So I built a layer that reads the exit code for me.
