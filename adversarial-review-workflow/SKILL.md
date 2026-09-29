---
name: adversarial-review-workflow
description: Launches an adversarial code review workflow over a scope (uncommitted | branch | unpushed | codebase), auto-fixing findings when the smallest fix fits the finding's severity.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model]"
disable-model-invocation: true
---

A Workflow reviews the scoped code: one finder per dimension, two skeptics per finding, one implementer per root-cause cluster that commits the smallest fix unless it is an excluded kind. You resolve the scope, scout the dimensions, describe the project, launch and report; the mechanics live in [review.mjs](review.mjs), and running it needs nothing from inside it.

## Steps

1. **Resolve the arguments.** The first must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use and stop without launching anything. An optional second argument is a model for the implementers, the only agents that run on it; without it they inherit the session's model. It is a plausible model name such as `opus`, `sonnet` or `haiku`. If the token after the scope is not a model name, ask the user what they meant and stop. Any further argument: ask the user what it means and stop.

   Resolve `base`, the commit bounding the diff:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `codebase`: none; the review covers every tracked file and is omitted from the args.

   Every diff-bounded scope is the working tree against the base, `git diff <BASE>`, plus untracked files.

2. **Record `root`**, the absolute project root. The workflow lists the untracked and dirty paths itself.

3. **Scout the shape of the scope**, not its content: `git diff --stat <BASE>` plus the untracked paths (`git -c core.quotePath=false ls-files -o --exclude-standard`), or for `codebase` the tracked file list with line counts. If the scope is empty, report that there is nothing to review and stop without launching.

   From those paths and sizes, design the `dimensions`: one finder per dimension, each `{key, title, focus, files}`. A dimension is a slice a single reviewer can hold in context and attack from one angle (a subsystem, a layer, a cross-cutting concern such as authorization or i18n and docs, tests and CI). Every changed or untracked file belongs to at least one dimension; a file may appear in several when two angles both need it. `focus` is a paragraph naming the specific things to attack in those files: the mechanisms the diff introduced, the invariants it could break, the callers that depend on it. Write it from the file names and stat sizes plus what you know of the repository; the finders read the hunks themselves. Past runs used five to nine dimensions for branches of forty to a hundred changed files; a small diff may need two.

4. **Describe the project** in `context`, a string every agent reads: the stack, where the agent docs live (CLAUDE.md, AGENTS.md, docs the skeptics must quote before invoking a convention), where ADRs or domain docs live (the materiality skeptic checks documented tradeoffs there), and the commit-message convention implementers follow (name the doc, or state it). `context` describes the project; the diff's risks are the finders' to discover. A hypothesis written there ("the key risk is guidance lost in the move") is read by every finder and skeptic and comes back as a finding in every dimension.

   Record the author's intent. For a diff-bounded scope, set `authorEnd` to `git rev-parse HEAD`: the agents read the author's commits, `<BASE>..authorEnd`, themselves. When the user said what the diff deliberately does, put that note verbatim in `intent`; omit it otherwise.

   Then discover the project's check commands and put them in `checks`: typecheck, lint and how to run the tests that cover a given file, from `package.json` scripts, a Makefile, the agent docs, or the language's convention. Name them as commands the implementer can run on the files it touched, never a watch mode. Confirm each script or target exists; if nothing trustworthy is found, omit `checks` and the implementers verify by reading.

5. **Launch the workflow.** Resolve the absolute path of [review.mjs](review.mjs); it sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. Substitute the resolved path below:

   ```
   Workflow({
     scriptPath: "<absolute path to review.mjs>",
     args: { scope: "<scope>", root: "<absolute project root>", base: "<commit, omitted for codebase>", dimensions: [{ key, title, focus, files: [<paths>] }, ...], context: "<project description>", authorEnd: "<HEAD at launch, omitted for codebase>", intent: "<the user's note, omitted when none>", checks: "<check commands, omitted when none found>", implementerModel: "<model argument, omitted when not given>" }
   })
   ```

   Pass `dimensions` and each `files` as real JSON arrays, not JSON-encoded strings. The script validates the args and throws on a missing one.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests; relaunch it by [RELAUNCH.md](RELAUNCH.md) in this skill's folder.

6. **Report** the result by [REPORT.md](REPORT.md) in this skill's folder.
