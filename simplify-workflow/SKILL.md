---
name: simplify-workflow
description: Loop simplification rounds (find, judge, apply) over a scope (uncommitted | branch | unpushed | codebase) via a Workflow until fresh finders come up empty, then prune non-useful comments.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model effort]"
disable-model-invocation: true
---

A Workflow runs find, judge, apply rounds over batches of the scoped files until a confirmation sweep applies nothing, then prunes non-useful comments. You resolve the scope, say what is source, launch and relay the result; the workflow lists the files itself, and the mechanics live in [simplify.mjs](simplify.mjs), which running it needs nothing from inside.

## Steps

1. **Resolve the arguments.** Parse them in this exact order; every "ask the user" below means ask and stop, without launching anything.
   - The first argument is the scope and must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use.
   - After the scope, what remains must be nothing, `[model]`, or `[model] [effort]`, in that order and nothing else.
   - The model must be a plausible model name (e.g. `opus`, `sonnet`, `haiku`). If the token after the scope is not a model name, ask the user what they meant. An effort is one of `low`, `medium`, `high`, `xhigh`, `max`. If a model is given without a following effort, ask the user which effort to use; the model/effort pairing is the user's call, never defaulted. The override drives the find, apply and prune agents; the judge and the verify agents keep their fixed models (Opus for the judge and the fix-up, Sonnet for the check runs).
   - Any further leftover argument: ask the user what it means.

2. **Resolve `base`**, the commit bounding the diff:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `codebase`: none; omitted from the args.

3. **Say what is source**; the workflow lists the files itself. Set `pruneExts` to the comment-carrying source extensions of this repo, e.g. `[".ts", ".js", ".svelte"]`, the set for the repo rather than the extensions that happen to appear in the diff; files that appear mid-run are judged by it too. Optionally set `excludePattern`, an extended regex with no single quote, when the default would let a build output directory, generated code or a vendored tree of this repo into the scope; it replaces the default rather than adding to it. For `codebase`, check the top-level directories and any `linguist-generated` or `linguist-vendored` entries in `.gitattributes` before trusting the default. The default excludes `node_modules`, `vendor`, `third_party`, `dist`, `build`, `target` and `generated` directories, minified files, lockfiles, and data, doc, image, font, archive and binary files (`json`, `md`, `svg`, `png`, `pdf`, `woff`, `zip`, `wasm`, `so` and the like). To override it, start from the `DEFAULT_EXCLUDE` constant in [simplify.mjs](simplify.mjs).

4. **Discover the project's check command.** Look for how this project verifies itself: `package.json` scripts (`typecheck`, `test`, `lint`, `check`), a `Makefile` or `justfile` target, instructions in CLAUDE.md/AGENTS.md, or the language's convention (`cargo check && cargo test`, `go vet ./... && go test ./...`, `pytest`, etc.). Compose a single non-interactive command, preferring typecheck plus tests joined with `&&`; never a watch mode. Sanity-check it by running it once via Bash from the project root. Failing checks are fine (the workflow baselines them), but if the command itself cannot run (unknown script, missing tooling), discard it. If nothing trustworthy is found, omit `checkCmd`; the workflow then skips both the baseline and the fix-up.

5. **Launch the workflow.** First resolve the absolute path of [simplify.mjs](simplify.mjs); it sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. Substitute the resolved path below:

   ```
   Workflow({
     scriptPath: "<absolute path to simplify.mjs>",
     args: { scope: "<scope>", root: "<absolute project root>", base: "<commit, omitted for codebase>", pruneExts: [<extensions>], excludePattern: "<regex, omitted to keep the default>", checkCmd: "<check command, omitted when not found>", model: "<model, omitted when not given>", effort: "<effort, required with model, omitted otherwise>" }
   })
   ```

   Pass `pruneExts` as a real JSON array, not a JSON-encoded string.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests; relaunch from step 1, and the workflow recomputes every list from the current tree.

6. **Report** the result by [REPORT.md](REPORT.md) in this skill's folder. Leave the changes uncommitted.
