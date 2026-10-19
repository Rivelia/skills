---
name: simplify-workflow
description: Strip comments with the no-comments workflow and apply its MUST KILL flags and constraints through a judge, loop simplification rounds (find, judge, apply) over a scope (uncommitted | branch | unpushed | codebase | a commit to start from) via a Workflow until fresh finders come up empty, commit, then strip the comments the appliers wrote.
argument-hint: "<uncommitted|branch|unpushed|codebase|commit> [model effort]"
disable-model-invocation: true
---

A Workflow strips the scope's comments with the no-comments workflow, judges and applies the refactors and constraint encodings it flags, runs find, judge, apply rounds over batches of the scoped files until a confirmation sweep applies nothing, commits, then strips the comments the appliers wrote. You resolve the scope, commit the user's work, say what is source, launch and relay the result; the workflow lists the files itself, and the mechanics live in [simplify.mjs](simplify.mjs), which running it needs nothing from inside.

## Steps

1. **Resolve the arguments.** Parse them in this exact order; every "ask the user" below means ask and stop, without launching anything.
   - The first argument is the scope: exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`, or a commit-ish (a sha, a tag, `HEAD~3`) naming where the work to simplify starts, which is the `since` scope. A token that is not a scope name is a commit-ish when `git rev-parse --verify --quiet '<arg>^{commit}'` prints a sha; if it is missing, or neither, ask the user which scope to use.
   - After the scope, what remains must be nothing, `[model]`, or `[model] [effort]`, in that order and nothing else.
   - The model must be a plausible model name (e.g. `opus`, `sonnet`, `haiku`). If the token after the scope is not a model name, ask the user what they meant. An effort is one of `low`, `medium`, `high`, `xhigh`, `max`. If a model is given without a following effort, ask the user which effort to use; the model/effort pairing is the user's call, never defaulted. The override drives the find and apply agents and the seed appliers' model; the judge, the verify agents and the comment passes keep their fixed models (Sonnet at high effort for the judge, Opus for the fix-up and the comment passes, Haiku for the check runs).
   - Any further leftover argument: ask the user what it means.

2. **Resolve `base`**, the commit bounding the diff:
   - `uncommitted`: `git rev-parse HEAD`.
   - `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
   - `unpushed`: `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop.
   - `since`: the sha the commit-ish resolves to. It must be an ancestor of HEAD (`git merge-base --is-ancestor <sha> HEAD`); if it is not, say so, ask the user which commit they meant, and stop.
   - `codebase`: none; omitted from the args.

3. **Discover the project's check command.** Look for how this project verifies itself: `package.json` scripts (`typecheck`, `test`, `lint`, `check`), a `Makefile` or `justfile` target, instructions in CLAUDE.md/AGENTS.md, or the language's convention (`cargo check && cargo test`, `go vet ./... && go test ./...`, `pytest`, etc.). Compose a single non-interactive command, preferring typecheck plus tests joined with `&&`; never a watch mode. Sanity-check it by running it once via Bash from the project root. Failing checks are fine (the workflow baselines them), but if the command itself cannot run (unknown script, missing tooling), discard it. If nothing trustworthy is found, omit `checkCmd`; the workflow then skips both the baseline and the fix-up.

4. **Say what is source**; the workflow lists the files itself. Set `pruneExts` to the comment-carrying source extensions of this repo, e.g. `[".ts", ".js", ".svelte"]`, the set for the repo rather than the extensions that happen to appear in the diff; files that appear mid-run are judged by it too. Optionally set `excludePattern`, an extended regex with no single quote and no POSIX bracket expression such as `[:alnum:]` (spell the class out, e.g. `[A-Za-z0-9]`), when the default would let a build output directory, generated code or a vendored tree of this repo into the scope; it replaces the default rather than adding to it. For `codebase`, check the top-level directories and any `linguist-generated` or `linguist-vendored` entries in `.gitattributes` before trusting the default. The default excludes `node_modules`, `vendor`, `third_party`, `dist`, `build`, `target` and `generated` directories, minified files, lockfiles, and data, doc, image, font, archive and binary files (`json`, `md`, `svg`, `png`, `pdf`, `woff`, `zip`, `wasm`, `so` and the like). To override it, start from the `DEFAULT_EXCLUDE` constant in [simplify.mjs](simplify.mjs).

5. **Commit the user's work** so the workflow starts on a clean tree, after resolving `base`: the comment passes revert a rejected batch with `git checkout`, and the workflow commits everything it changes. When `git status --porcelain` prints nothing, skip this step. Otherwise list the untracked files (`git -c core.quotePath=false ls-files -o --exclude-standard`); if any looks like a secret or a scratch file (`.env*`, `*.pem`, `*.key`, `id_*`, credentials, or a `tmp`, `temp` or `scratch` name) or an output of the check run in step 3 (test results, coverage, build output), list them, ask the user what to do, and stop. For check outputs, ask the user to add them to `.gitignore` rather than delete them: the workflow runs the check again, so deleted outputs come back on every run. When they answer, put each file they want kept out of `W` in `.gitignore` or `.git/info/exclude`, or out of the tree, as they choose. Then `git add -A` and `git commit -m "wip: work in progress before simplify"`, with no attribution lines or trailers. Call that commit `W`; the report names it, so the user can reword or squash it. Launch only once `git status --porcelain` prints nothing: every stage takes an uncommitted path for its own, and commits or deletes it.

6. **Locate `no-comments.mjs`.** It sits in the `no-comments` skill folder: look for it as a sibling of this skill's folder first, then in the skills directory that holds this skill (e.g. `~/.claude/skills/no-comments/`), and resolve it to an absolute path, following symlinks (`readlink -f`). If it is missing, tell the user to install the `no-comments` skill and stop.

7. **Launch the workflow.** First resolve the absolute path of [simplify.mjs](simplify.mjs); it sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. Substitute the resolved paths below:

   ```
   Workflow({
     scriptPath: "<absolute path to simplify.mjs>",
     args: { scope: "<scope, since for a commit-ish>", root: "<absolute project root>", base: "<commit, omitted for codebase>", pruneExts: [<extensions>], noCommentsScript: "<absolute path to no-comments.mjs>", excludePattern: "<regex, omitted to keep the default>", checkCmd: "<check command, omitted when not found>", model: "<model, omitted when not given>", effort: "<effort, required with model, omitted otherwise>" }
   })
   ```

   Pass `pruneExts` as a real JSON array, not a JSON-encoded string.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests; relaunch with the same scope, model and effort, but take `base` from the dead run's launch args in its `journal.jsonl` rather than resolving it again in step 2: against the current HEAD, `uncommitted` would resolve to the dead run's own last commit and leave the user's work out of scope, and a relative commit-ish such as `HEAD~3` would name a different commit. Then redo steps 3 to 8, and the workflow recomputes every list from the current tree. For `codebase`, which has no `base`, relaunch from step 1. When `git status` shows the dead run left changes uncommitted, show them to the user before step 5 commits them.

8. **Report** the result by [REPORT.md](REPORT.md) in this skill's folder. Name `W` when step 5 made one. End with the final HEAD (`git rev-parse HEAD`) and the command that simplifies only what comes after it: `/simplify-workflow <sha>`.
