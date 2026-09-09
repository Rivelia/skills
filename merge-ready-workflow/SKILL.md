---
name: merge-ready-workflow
description: Repeats the adversarial code review over a scope (uncommitted | branch | unpushed | codebase), re-scouting the finders every round, until a round fixes too little to justify another, then runs the simplify workflow over the same scope.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model]"
disable-model-invocation: true
---

One Workflow runs the whole sequence you used to drive by hand: an adversarial review round, a look at what it fixed, a fresh round when the fixes justify one, and the simplify workflow once the review is quiet. Every round starts from nothing: a state agent re-reads the tree and a scout designs the finder dimensions again from the scope as it stands, told nothing about earlier rounds, so the cut drifts with the fixes the way it did when you cleared the conversation and relaunched by hand. A round is followed by another when any critical or high finding it fixed changed production behaviour, when it fixed or covered at least as many issues as it had finders, or when a finder failed. The loop mechanics live in [merge-ready.mjs](merge-ready.mjs) in this skill's folder; it launches the sibling skills' scripts unchanged, [review.mjs](../adversarial-review-workflow/review.mjs) for each round and [simplify.mjs](../simplify-workflow/simplify.mjs) at the end, so both must be installed. You orchestrate from outside: resolve the scope, describe the project, launch, report.

## Steps

1. **Resolve the arguments.** The first must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use and stop without launching anything. An optional second argument is the model that replaces Fable for the review implementers, the only agents that run on it: a plausible model name such as `opus`, `sonnet` or `haiku`. If the token after the scope is not a model name, ask the user what they meant and stop. Any further argument: ask the user what it means and stop. The simplify phase keeps the fixed models set in its own script.

   Resolve `base`, the commit bounding the diff, once; the loop pins it for every round and for the simplify phase, so a fix a round commits stays in scope for the next:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `codebase`: none; omitted from the args.

   If `git diff --stat <BASE>` prints nothing and `git ls-files -o --exclude-standard` prints nothing, report that there is nothing to review and stop without launching.

2. **Locate the three scripts.** [merge-ready.mjs](merge-ready.mjs) sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. `review.mjs` sits in the `adversarial-review-workflow` skill folder and `simplify.mjs` in the `simplify-workflow` skill folder: look for each as a sibling of this skill's folder first, then in the skills directory that holds this skill (e.g. `~/.claude/skills/<name>/`). Resolve all three to absolute paths, following symlinks (`readlink -f`). If either sibling script is missing, tell the user which skill to install and stop.

3. **Describe the project** in `context`, a string every agent of every round reads: the stack, where the agent docs live (CLAUDE.md, AGENTS.md, docs the skeptics must quote before invoking a convention), where ADRs or domain docs live, and the commit-message convention implementers follow (name the doc, or state it).

   Then discover how the project verifies itself, twice, because the two workflows consume it differently:
   - `checks`, for the review implementers: typecheck, lint and how to run the tests that cover a given file, as commands the implementer can run on the files it touched, never a watch mode. Confirm each script or target exists; if nothing trustworthy is found, omit `checks` and the implementers verify by reading.
   - `checkCmd`, for the simplify phase: a single non-interactive command, preferring typecheck plus tests joined with `&&`, never a watch mode. Run it once via Bash from the project root: failing checks are fine (the simplify workflow baselines them), but if the command itself cannot run (unknown script, missing tooling), discard it. If nothing trustworthy is found, omit `checkCmd`.

   Set `pruneExts` to the comment-carrying source extensions of this repo, e.g. `[".ts", ".js", ".svelte"]`, the set for the repo rather than the extensions that happen to appear in the diff. Optionally set `excludePattern`, an extended regex with no single quote, when the default in [merge-ready.mjs](merge-ready.mjs) would let a build output directory, generated code or a vendored tree of this repo into the simplify phase; it filters the simplify file list and both prune candidate lists.

4. **Launch the workflow.** Substitute the resolved paths:

   ```
   Workflow({
     scriptPath: "<absolute path to merge-ready.mjs>",
     args: { scope: "<scope>", root: "<absolute project root>", base: "<commit, omitted for codebase>", reviewScript: "<absolute path to review.mjs>", simplifyScript: "<absolute path to simplify.mjs>", context: "<project description>", checks: "<check commands, omitted when none found>", checkCmd: "<single check command, omitted when none found>", pruneExts: [<extensions>], excludePattern: "<regex, omitted to keep the default>", implementerModel: "<model argument, omitted when not given>" }
   })
   ```

   Pass `pruneExts` as a real JSON array. The script validates the args and throws on a missing one.

   What the script does, so you know what the result means. Each round:
   - Scout: a Sonnet state agent records `dirtyAtLaunch`, the untracked files and the changed file list from git; a Fable scout designs the dimensions from that shape with the same rules the single-run skill gives you. Neither agent is told the round number, an earlier split, or what earlier fixes touched: the prompt is the same on every round and only the tree differs. A file the scout assigns to no dimension gets a catch-all finder, so coverage never depends on the scout.
   - Review: `review.mjs` runs with those dimensions and the round's fresh tree state; its phases, models, budgets and excluded kinds are its own.
   - Triage (Opus, medium): for every critical or high finding the round fixed or covered, decides from the fix's hunks whether it changed production behaviour. Comments, docs, tests and fixtures, CI and build config, runtime-free type annotations, formatting, log text, user-facing copy and translations do not count; a fix that also changed shipped logic does. A dead triage agent counts every candidate as production.
   - Decision: another round when at least one of these holds: a severe fix changed production behaviour; the fixed plus covered count is at least the number of finders; a finder failed. Otherwise the loop is done (`converged`). A round whose implementer died leaving protected paths possibly dirty stops the loop (`possibly-dirty`) whatever else happened. A `MAX_ROUNDS` backstop of ten rounds ends a loop that keeps justifying itself (`max-rounds`).
   - Only a `converged` loop goes on to simplify. A Sonnet prepare agent runs the simplify skill's own shell pipelines with the pinned base (file list, tracked and untracked prune candidates, raw untracked baseline, tree hash), then `simplify.mjs` runs with the same scope and no model override. A loop that stopped any other way skips it, and so does a scope whose file list is empty after the exclusions.

   Every round's review agents and the simplify agents count against the harness's 1000-agent lifetime cap; a large branch that needs several rounds can hit it during simplify.

   The workflow returns `{scope, base, implementerModel, checksConfigured, checkCmdConfigured, maxRounds, stopReason, stopDetail, rounds, fixes, uncommittedFixFiles, possiblyDirty, simplify}`. `stopReason` is `converged`, `max-rounds`, `possibly-dirty`, `scope-empty`, `review-failed` or `agent-failed`, with `stopDetail` saying which round and agent. Each entry of `rounds` carries `round`, `dimensions` (`key`, `title`, `files`), `unassignedFiles` (what the catch-all took), `dirtyAtLaunch`, `review` (the full review.mjs result, or null with `error`), `triage` (`candidates`, `verdicts` with `id`, `production`, `reason`, `failed`, `productionIds`) and `decision` (`counts`, `reasons`, `continue`). `fixes` is every round's fixes with the round number; `uncommittedFixFiles` and `possiblyDirty` are unions over the rounds. `simplify` is `{ran, skipped, error, result}`: `ran` true with the full simplify.mjs result, or `skipped` naming why (`review-loop-<stopReason>`, `nothing-to-simplify`, `prepare-failed`, `simplify-failed`).

5. **Report.** Open with one table over the rounds: round, finders, findings registered and confirmed, fixed and covered, severe fixes that changed production behaviour (with their ids), and the decision with its reasons. Then state the stop reason in a sentence; for `max-rounds`, `possibly-dirty`, `review-failed` and `agent-failed` state prominently that the review never became quiet, quoting `stopDetail`, and that simplify did not run.

   Then report each round's review the way the single-run skill does: read the step titled Report in the `adversarial-review-workflow` SKILL.md next to the `review.mjs` located in step 2 and apply it to that round's `review`, with the finding numbers prefixed by the round (`2.5` is finding 5 of round 2) so numbering stays unique across the report. Add the round's `unassignedFiles` when non-empty, saying the scout left them out and a catch-all finder reviewed them. When a round's triage `failed`, say its severe fixes were assumed to have changed production behaviour. A round whose `review` is null gets its `error` instead.

   Then, when `simplify.ran`, report `simplify.result` the way the simplify skill does: read the step titled Report in the `simplify-workflow` SKILL.md next to the `simplify.mjs` located in step 2 and apply every row of its table whose condition holds. When it did not run, say why from `simplify.skipped` and `simplify.error`.

   Close with the loop-wide notes:
   - `checksConfigured` false: state that no check command was found for the review rounds, so every fix was verified only by reading.
   - `uncommittedFixFiles` non-empty: list them and say those fixes sit in the working tree next to the user's uncommitted work.
   - `possiblyDirty` non-empty: state prominently that an implementer died and the cleanup could not restore these paths because they were protected, so they may hold partial hunks the user must inspect.
   - When `implementerModel` is not `fable`, say which model applied the review fixes.
