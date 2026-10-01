---
name: merge-ready-workflow
description: Repeats the adversarial code review over a scope (uncommitted | branch | unpushed | codebase), re-scouting the finders every round, until a round fixes too little to justify another, then runs the simplify workflow over the same scope.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model]"
disable-model-invocation: true
---

One Workflow runs adversarial review rounds, each with freshly scouted finder dimensions, until a round fixes too little to justify another, then the simplify workflow. The mechanics live in [merge-ready.mjs](merge-ready.mjs), and running it needs nothing from inside it; it launches the sibling skills' [review.mjs](../adversarial-review-workflow/review.mjs) and [simplify.mjs](../simplify-workflow/simplify.mjs), so both must be installed. You resolve the scope, describe the project, launch and report.

## Steps

1. **Resolve the arguments.** The first must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use and stop without launching anything. An optional second argument is a model for the scout, the review implementers and the simplify appliers, and no other agent; without it those three inherit the session's model. It is a plausible model name such as `opus`, `sonnet` or `haiku`. If the token after the scope is not a model name, ask the user what they meant and stop. Any further argument: ask the user what it means and stop.

   Resolve `base`, the commit bounding the diff, once; the loop pins it for every round and for the simplify phase, so a fix a round commits stays in scope for the next:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `codebase`: none; omitted from the args.

   Set `loopStart` to `git rev-parse HEAD`, omitted for `codebase`. The author's commits are `<BASE>..loopStart`; every commit after it is the loop's.

   For a diff-bounded scope, count the paths first, via Bash from the project root: `git diff --name-only <BASE> | wc -l` and `git ls-files -o --exclude-standard | wc -l`. If together they are 200 or fewer, list them for the launch, with `git -c core.quotePath=false`, since passing them costs less than the agents the workflow would spend listing them:
   - `files`: `git diff --name-only <BASE>`.
   - `untracked`: `git ls-files -o --exclude-standard`.
   - `dirtyAtLaunch`: `git diff --name-only --no-renames HEAD` plus the untracked paths.

   For `codebase`, or more than 200 paths, list nothing: the workflow lists them itself.

2. **Locate the three scripts.** [merge-ready.mjs](merge-ready.mjs) sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. `review.mjs` sits in the `adversarial-review-workflow` skill folder and `simplify.mjs` in the `simplify-workflow` skill folder: look for each as a sibling of this skill's folder first, then in the skills directory that holds this skill (e.g. `~/.claude/skills/<name>/`). Resolve all three to absolute paths, following symlinks (`readlink -f`). If either sibling script is missing, tell the user which skill to install and stop.

3. **Describe the project** in `context`, a string every agent of every round reads: the stack, where the agent docs live (CLAUDE.md, AGENTS.md, docs the skeptics must quote before invoking a convention), where ADRs or domain docs live, and the commit-message convention implementers follow (name the doc, or state it). `context` describes the project; the diff's risks are the finders' to discover. A hypothesis written there ("the key risk is guidance lost in the move") is read by every finder and skeptic of every round and comes back as a finding in every dimension.

   The agents read the author's commits, `<BASE>..loopStart`, themselves. When the user told you what the diff deliberately does, put that note verbatim in `intent`; an `uncommitted` scope has no commits, so the note is its only intent.

   Then discover how the project verifies itself, twice, because the two workflows consume it differently:
   - `checks`, for the review implementers: typecheck, lint and how to run the tests that cover a given file, as commands the implementer can run on the files it touched, never a watch mode. Confirm each script or target exists; if nothing trustworthy is found, omit `checks` and the implementers verify by reading.
   - `checkCmd`, for the simplify phase: a single non-interactive command, preferring typecheck plus tests joined with `&&`, never a watch mode. Run it once via Bash from the project root: failing checks are fine (the simplify workflow baselines them), but if the command itself cannot run (unknown script, missing tooling), discard it. If nothing trustworthy is found, omit `checkCmd`.

   Set `pruneExts` to the comment-carrying source extensions of this repo, e.g. `[".ts", ".js", ".svelte"]`, the set for the repo rather than the extensions that happen to appear in the diff. Optionally set `excludePattern`, an extended regex with no single quote, when the default would let a build output directory, generated code or a vendored tree of this repo into the simplify phase; it filters the simplify file list and both prune candidate lists, and replaces the default rather than adding to it. The default excludes `node_modules`, `vendor`, `third_party`, `dist`, `build`, `target` and `generated` directories, minified files, lockfiles, and data, doc, image, font, archive and binary files (`json`, `md`, `svg`, `png`, `pdf`, `woff`, `zip`, `wasm`, `so` and the like). To override it, start from the `DEFAULT_EXCLUDE` constant in the `simplify.mjs` located in step 2.

4. **Launch the workflow.** Substitute the resolved paths:

   ```
   Workflow({
     scriptPath: "<absolute path to merge-ready.mjs>",
     args: { scope: "<scope>", root: "<absolute project root>", base: "<commit, omitted for codebase>", reviewScript: "<absolute path to review.mjs>", simplifyScript: "<absolute path to simplify.mjs>", context: "<project description>", files: [<paths>], untracked: [<paths>], dirtyAtLaunch: [<paths>], loopStart: "<HEAD at launch, or the start of a dead earlier run; omitted for codebase>", intent: "<the author's note, omitted when none>", checks: "<check commands, omitted when none found>", checkCmd: "<single check command, omitted when none found>", pruneExts: [<extensions>], excludePattern: "<regex, omitted to keep the default>", model: "<model argument, omitted when not given>" }
   })
   ```

   Pass `files`, `untracked` and `dirtyAtLaunch` all three or none: omit them when step 1 listed nothing, and pass `[]` for an empty list otherwise. Pass them and `pruneExts` as real JSON arrays. The script validates the args and throws on a missing one.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests; relaunch it by [RELAUNCH.md](RELAUNCH.md) in this skill's folder.

   What the result means. A round continues the loop when its `decision.reasons` is non-empty; only a `converged` loop goes on to simplify. `stopReason` is `converged`, `max-rounds`, `possibly-dirty`, `scope-empty` (nothing to review), `prepare-failed` (the launch state could not be read), `review-failed` or `agent-failed`, with `stopDetail` saying which round and agent. Each round's `review` carries only `finderFailures` and `findings` from the review.mjs result; the other fields REPORT.md reads are reported once, by the loop-wide notes below.

5. **Report.** Open with one table over the rounds: round, finders, findings registered and confirmed, fixed and covered (with the medium-or-higher count and how many finders reported them), fixes that changed production behaviour (with their ids), and the decision with its reasons. Then state the stop reason in a sentence; for `scope-empty` say there was nothing to review; for `max-rounds`, `possibly-dirty`, `prepare-failed`, `review-failed` and `agent-failed` state prominently that the review never became quiet, quoting `stopDetail`, and that simplify did not run.

   Then report each round's review the way the single-run skill does: read `REPORT.md` next to the `review.mjs` located in step 2 and apply it to that round's `review`, taking `excludedKinds` from the top level and leaving the notes on checks, uncommitted fixes, dirty paths and the implementer model to the loop-wide notes, with the finding numbers prefixed by the round (`2.5` is finding 5 of round 2) so numbering stays unique across the report, and each refuted finding on one line: its title, the skeptic and its `refuteReason`. Add the round's `unassignedFiles` when present, saying the scout left them out and a catch-all finder reviewed them. When a round's triage `failed`, say its medium-or-higher fixes were assumed to have changed production behaviour. A round whose `review` is null gets its `error` instead.

   Then, when `simplify.ran`, report `simplify.result` the way the simplify skill does: read `REPORT.md` next to the `simplify.mjs` located in step 2 and apply it, except that the loop commits simplify's changes: state `simplifyCommit.commitSha` and its files, or, when `simplifyCommit.committed` is false, its `reason` and that simplify's changes sit uncommitted in the working tree. List `simplifyCommit.keptOut` when non-empty: simplify changes left uncommitted because they share a file with the user's uncommitted work or an uncommitted review fix. When simplify did not run, say why from `simplify.skipped` and `simplify.error`.

   Close with the loop-wide notes:
   - `checksConfigured` false: state that no check command was found for the review rounds, so every fix was verified only by reading.
   - `uncommittedFixFiles` non-empty: list them and say those fixes sit in the working tree next to the user's uncommitted work.
   - `possiblyDirty` non-empty: state prominently that an implementer died and the cleanup could not restore these paths because they were protected, so they may hold partial hunks the user must inspect.
   - When `model` is not null, say which model ran the scout, the review implementers and the simplify appliers.
