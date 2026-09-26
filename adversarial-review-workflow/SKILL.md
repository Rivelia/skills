---
name: adversarial-review-workflow
description: Launches an adversarial code review workflow over a scope (uncommitted | branch | unpushed | codebase), auto-fixing findings when the smallest fix fits the finding's severity.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model]"
disable-model-invocation: true
---

A Workflow reviews the scoped code: one finder per review dimension proposes defects, a dedup check attaches duplicates at intake, two skeptics attack each finding (materiality, then technical truth), a clustering agent groups the confirmed ones by root cause, and one implementer per cluster applies the smallest fix that closes the finding, unless it is an excluded kind, and commits it. You orchestrate from outside: resolve the scope, scout the dimensions, describe the project, launch, report. The phase mechanics, models, efforts, prompts, change kinds and excluded kinds live in [review.mjs](review.mjs) in this skill's folder.

## Steps

1. **Resolve the arguments.** The first must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use and stop without launching anything. An optional second argument is a model for the implementers, the only agents that run on it; without it they inherit the session's model. It is a plausible model name such as `opus`, `sonnet` or `haiku`. If the token after the scope is not a model name, ask the user what they meant and stop. The effort is not an argument: it stays tied to the finding's severity. Any further argument: ask the user what it means and stop.

   Resolve `base`, the commit bounding the diff:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `codebase`: none; the review covers every tracked file and is omitted from the args.

   Every diff-bounded scope is the working tree against the base, `git diff <BASE>`, plus untracked files.

2. **Record the launch state**, via Bash from the project root:
   - `root`: the absolute project root.
   - `dirtyAtLaunch`: every path `git status --porcelain` lists, modified and untracked alike, as plain paths. Implementers treat these as the user's work: they never stage or restore them, and a fix that touches one stays uncommitted. Pass `[]` for a clean tree.
   - `untracked`: `git ls-files -o --exclude-standard`. Finders read these whole, since they have no diff against the base. Pass `[]` when there are none.

3. **Scout the shape of the scope**, not its content: `git diff --stat <BASE>` plus the untracked paths, or for `codebase` the tracked file list with line counts. If the scope is empty, report that there is nothing to review and stop without launching.

   From those paths and sizes, design the `dimensions`: one finder per dimension, each `{key, title, focus, files}`. A dimension is a slice a single reviewer can hold in context and attack from one angle (a subsystem, a layer, a cross-cutting concern such as authorization or i18n and docs, tests and CI). Every changed or untracked file belongs to at least one dimension; a file may appear in several when two angles both need it. `focus` is a paragraph naming the specific things to attack in those files: the mechanisms the diff introduced, the invariants it could break, the callers that depend on it. Write it from the file names and stat sizes plus what you know of the repository; the finders read the hunks themselves. Past runs used five to nine dimensions for branches of forty to a hundred changed files; a small diff may need two.

4. **Describe the project** in `context`, a string every agent reads: the stack, where the agent docs live (CLAUDE.md, AGENTS.md, docs the skeptics must quote before invoking a convention), where ADRs or domain docs live (the materiality skeptic checks documented tradeoffs there), and the commit-message convention implementers follow (name the doc, or state it). `context` describes the project; the diff's risks are the finders' to discover. A hypothesis written there ("the key risk is guidance lost in the move") is read by every finder and skeptic and comes back as a finding in every dimension.

   Record the author's intent in `intent`: for a diff-bounded scope, the output of `git log --format='--- %H%n%B' <BASE>..HEAD` verbatim, preceded by any note the user gave on what the diff deliberately does. The finders and the materiality skeptic treat a removal the intent states as a decision to test for breakage rather than a loss to restore. Omit `intent` when the log is empty and there is no note.

   Then discover the project's check commands and put them in `checks`: typecheck, lint and how to run the tests that cover a given file, from `package.json` scripts, a Makefile, the agent docs, or the language's convention. Name them as commands the implementer can run on the files it touched, never a watch mode. Confirm each script or target exists; if nothing trustworthy is found, omit `checks` and the implementers verify by reading.

5. **Launch the workflow.** Resolve the absolute path of [review.mjs](review.mjs); it sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. Substitute the resolved path below:

   ```
   Workflow({
     scriptPath: "<absolute path to review.mjs>",
     args: { scope: "<scope>", root: "<absolute project root>", base: "<commit, omitted for codebase>", dirtyAtLaunch: [<paths>], untracked: [<paths>], dimensions: [{ key, title, focus, files: [<paths>] }, ...], context: "<project description>", intent: "<commit messages and note, omitted when empty>", checks: "<check commands, omitted when none found>", implementerModel: "<model argument, omitted when not given>" }
   })
   ```

   Pass `dirtyAtLaunch`, `untracked`, `dimensions` and each `files` as real JSON arrays, not JSON-encoded strings. The script validates the args and throws on a missing one.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests. The cache key of each agent call chains every call issued before it, and the finders and skeptics issue theirs in the order earlier calls finish, so a resume misses partway through, re-runs the rest live against a tree that already holds the fixes, and the skeptics refute every finding as already fixed. Relaunch from step 1 against the current tree instead. In `intent`, after the log, name the commits the dead run made (the `commitSha` of its `implement #N` results in its `journal.jsonl`) as made by an earlier run of this review, not by the author.

   What the result means: a duplicate the dedup attached at intake appears under its primary as `alsoReportedBy` and shares its verdicts and outcome. Implementers run one at a time in descending severity, each committing its fix unless one of its files is in `dirtyAtLaunch` or holds an earlier uncommitted fix; nobody reviews their change afterwards. A cleanup agent runs only after an implementer dies.

   The workflow returns `{scope, implementerModel, base, checksConfigured, changeKinds, excludedKinds, finderFailures, clusters, fixes, uncommittedFixFiles, possiblyDirty, findings}`. `changeKinds` is the table of change kinds the implementers report in, each key with its description and whether it changes production behaviour; `excludedKinds` maps each exclusion key to its description; `clusters` lists each root-cause group with its `leadId`, `memberIds` and `rootCause`. Each finding carries `status` (`confirmed`, `refuted`, `agent_failed`), `refutedBy` and `refuteReason`, `failedAt`, `outcome` (`fixed`, `covered`, `not_fixed`, `reverted`, `agent_failed`, or null when never implemented), the settled `severity`, the final `description` with `corrected` set when the technical skeptic rewrote it, `alsoReportedBy`, `coveredBy` (the cluster lead whose fix closed it, null when an implementer found it already closed), and the implementer's `plan`, `reason`, `excludedKind` (the key of the exclusion that applied, null for every outcome but `not_fixed`), `notes`, `files`, `kinds` (keys of `changeKinds`), `hunks`, `checks`, `committed` and `commitSha`.

6. **Report** every finding in six categories, ordered by severity within each:
   - fixed: whether committed (with the sha) or left uncommitted in the working tree, naming the files, plus the implementer's notes on what a fuller fix would need;
   - covered: by its cluster lead's fix, naming it (`coveredBy`), or already closed in the tree when an implementer reached it;
   - confirmed but not auto-fixed, saying which excluded kind it was, in the words of `excludedKinds`, with the implementer's plan;
   - fix attempted but reverted, with the check that could not pass and the plan;
   - never attempted because an agent failed, naming the agent (`failedAt`);
   - refuted, with the skeptic (`refutedBy`) and its reason.

   Number the findings continuously across the whole report so each can be quoted by its number. When `implementerModel` is not null, say which model applied the fixes. A finding attached at intake appears under its primary as "also reported by" with the finder that reported it, without a number of its own. Then:
   - `finderFailures` non-empty: state prominently that those dimensions were never reviewed, naming them, and make no claim that the scope was covered.
   - `checksConfigured` false: state that no check command was found, so every fix was verified only by reading, and the user should run the project's checks before relying on the tree.
   - `uncommittedFixFiles` non-empty: list them and say those fixes sit in the working tree next to the user's uncommitted work.
   - `possiblyDirty` non-empty: state prominently that an implementer died and the cleanup could not restore these paths because they were protected, so they may hold partial hunks the user must inspect.
