---
name: prune-agent-docs
description: Test every statement in a repo's agent docs by asking blind headless agents that cannot see them, delete what they already get right, rewrite the survivors with writing-for-agents, verify, and commit on a branch.
argument-hint: "[<repo-path>]"
disable-model-invocation: true
---

Prune a repo's **agent docs** down to what an agent cannot work out alone. The evidence is **blind probes**: headless `claude -p` runs in a copy of the repo with the docs removed. They run outside the Agent tool because Claude Code injects `AGENTS.md`/`CLAUDE.md` into subagents. Run end to end without asking; the branch is the review point.

The repo is the argument, else the working directory. `$SKILL` is this skill's folder; `$WORK` is `/tmp/prune-<repo-name>`, emptied before step 1.

## Steps

1. **Inventory.** Create the branch `prune-agent-docs` off HEAD; commit pending edits to the docs as their own commit, so the pruning diff shows only the pruning, and copy each gitignored doc into `$WORK/ignored/`, since git holds no original of it. The docs are every file the harness auto-loads (`CLAUDE.md`, `CLAUDE.local.md`, `AGENTS.md` at any depth, `.claude/rules/`) plus every file they point to that exists only for agents (such as `docs/agents/`). The README, ADRs, `CONTEXT.md` and other human docs are **environment**: they stay in the copy and out of scope. Also find:
   - **skill-consumed** docs: grep the skill and plugin folders (`~/.claude/skills`, `~/.agents/skills`, `~/.claude/plugins`, the repo's `.claude/skills`) for each doc's path; those skills read the file, so it is reworded only, keeping every operation they rely on.
   - gitignored paths a doc names (`git check-ignore`), which the copy needs to contain.

   Write `$WORK/ledger.md`: one numbered row per statement with its file, its text, and its kind: **fact** (where/how), **style** (a rule code must follow), or **preference** (a user preference or orchestrator workflow, not a fact about the code). Done when every line of every doc is in a row.

2. **Blind copy.** `$SKILL/blind-copy.sh <repo> $WORK/blind <doc-path>... -- <ignored-path>...`.

3. **Write probes.** One file per area in `$WORK/probes/` (about 5–8 areas, e.g. workflow commands, backend, conventions, a UI task, tests, git). Test facts with questions; test style with a realistic task ("write X as you'd commit it"), since a task shows behaviour where a question only gets the rule recited. Phrase nothing that leaks the answer. Done when every fact and style row names the probe question that tests it, or says why none can.

4. **Probe blind.** Run in the background and wait for it to exit: `$SKILL/run-probes.sh $WORK/blind $WORK/probes $WORK/out/blind 2 <repo> <doc-file-names>...`. Read every audit hit; a run with NO RESULT, or one that reached the docs, the real repo, `$WORK` or git, is void: put its probe alone in `$WORK/rerun/`, rerun it once with `$SKILL/run-probes.sh $WORK/blind $WORK/rerun $WORK/out/rerun 1 <repo> <doc-file-names>...`, and grade that run instead.

5. **Grade** each row against every non-void run, quoting the answer; a row whose probe has none is untested:
   - every run got it right, in its reasoning and its code, from the code or config: **delete**;
   - a run got it right only by reading a human doc (its `.tools.txt` shows where it looked): **keep**, as a **cache**, so agents skip reading the README and user-facing docs to find it;
   - any run got it wrong or broke it: **keep**;
   - no run exercised it: **keep**, as untested;
   - preference: **keep** untested.

   A doc statement a probe contradicts while the code agrees with the probe is **stale**: check the code, and delete it like any other the probes got right.

6. **Rewrite.** Delete the delete rows. Load the `writing-for-agents` skill and rewrite every survivor with it, as short as its meaning allows. Beyond that skill: tables become lists; a reason stays only when it drives effort (such as "CI shares CPU" behind lean tests); a code example that only restates its rule goes. Run the repo's formatter on the docs. Delete a file left empty, then fix every link to it across the repo.

7. **Verify.** `$SKILL/blind-copy.sh <repo> $WORK/verify -- <ignored-path>... <gitignored-doc>...` keeps the new docs, then `$SKILL/run-probes.sh $WORK/verify $WORK/probes $WORK/out/verify 1 <repo>`. A kept rule the run still breaks gets one sharper rewrite. A deleted statement the run gets wrong is restored, rewritten. A void verify run leaves its rows untested. Done when every row has its verify outcome.

8. **Commit** only the doc files and step 6's link fixes on the branch, never force-adding a gitignored doc, then report:
   - each gitignored doc's diff against its `$WORK/ignored/` copy, since the branch does not show it;
   - deleted, kept and restored rows, each with its evidence;
   - untested rows; cache rows, each with the human doc it came from; stale rows; kept rules the verify run still broke;
   - the audit result;
   - caveats: two blind runs and one verify run per probe; the probes still load the user-level `~/.claude*/CLAUDE.md`.

   Keep `$WORK` for the user to inspect.
