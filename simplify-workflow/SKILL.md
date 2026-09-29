---
name: simplify-workflow
description: Loop simplification rounds (find, judge, apply) over a scope (uncommitted | branch | unpushed | codebase) via a Workflow until fresh finders come up empty, then prune non-useful comments.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model effort]"
disable-model-invocation: true
---

A Workflow converges the scoped code to a stable simplified form. Each round runs find, judge, apply over batches of files: fresh finders propose, independent judges strike what is not a genuine improvement, and appliers implement only what survives. Rounds repeat until a confirmation sweep applies nothing and the tree hash lands on an already-seen state. A comment-pruning phase follows convergence. You orchestrate from outside the loop: resolve the inputs, launch the workflow, relay its result. The loop mechanics, embedded prompts, and comment-classification rules live in [simplify.mjs](simplify.mjs) in this skill's folder; running it needs nothing from inside it.

## Steps

1. **Resolve the arguments.** Parse them in this exact order; every "ask the user" below means ask and stop, without launching anything.
   - The first argument is the scope and must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use.
   - After the scope, what remains must be nothing, `[model]`, or `[model] [effort]`, in that order and nothing else.
   - The model must be a plausible model name (e.g. `opus`, `sonnet`, `haiku`). If the token after the scope is not a model name, ask the user what they meant. An effort is one of `low`, `medium`, `high`, `xhigh`, `max`. If a model is given without a following effort, ask the user which effort to use; the model/effort pairing is the user's call, never defaulted. The override drives the find, apply and prune agents; the judge and the verify agents keep their fixed models (Opus for the judge and the fix-up, Sonnet for the check runs).
   - Any further leftover argument: ask the user what it means.

2. **Build the hash command** for the scope. This exact string is the single source of truth for change detection: you run it once for the baseline, and the workflow reruns it verbatim as the convergence gate every iteration.
   - `uncommitted`:

     ```sh
     { git diff HEAD; git status --porcelain -z; git ls-files -o --exclude-standard -z | sort -z | xargs -0 -r sha256sum; } | sha256sum
     ```

   - `branch`: resolve the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`, and substitute the resulting commit hash for `<BASE>` in:

     ```sh
     { git diff <BASE>...HEAD; git diff HEAD; git status --porcelain -z; git ls-files -o --exclude-standard -z | sort -z | xargs -0 -r sha256sum; } | sha256sum
     ```

   - `unpushed`: resolve the merge-base with the branch's upstream, `git merge-base HEAD @{upstream}`, and substitute the resulting commit hash for `<BASE>` in the same command as `branch`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop without launching anything.

   - `codebase`:

     ```sh
     { git ls-files -z; git ls-files -o --exclude-standard -z; } | sort -zu | xargs -0 -r sha256sum | sha256sum
     ```

3. **Compute the file list** for the scope, via Bash from the project root. Every entry becomes a file some agent is told to simplify, so the list must contain only source files that still exist. Filter it through a `while IFS= read -r f` loop with a `-f` test to drop deleted paths (git quotes paths containing backslash, double-quote, newline or control bytes, so those drop here too and stay out of scope), and exclude anything that is not hand-written source: lockfiles, binaries, vendored or generated code, pure-data files, markdown. The `grep -vE` patterns below are a starting point; adjust them with judgment about the repo at hand (its build output directory, its generated-code conventions, its vendored trees).
   - `uncommitted`:

     ```sh
     { git -c core.quotePath=false diff --name-only HEAD; git -c core.quotePath=false ls-files -o --exclude-standard; } | sort -u \
       | grep -vE '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\.min\.|(^|/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|poetry\.lock|go\.sum)$|\.(json|jsonl|csv|tsv|md|mdx|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm|so|dylib|dll|exe|bin)$' \
       | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done || :
     ```

   - `branch` / `unpushed` (each with its own `<BASE>` from step 2): identical, with `git -c core.quotePath=false diff --name-only <BASE>` in place of `git -c core.quotePath=false diff --name-only HEAD`.

   - `codebase`: identical, with `git -c core.quotePath=false ls-files` in place of `git -c core.quotePath=false diff --name-only HEAD`. This scope sweeps every tracked file, so scan the surviving list before launching and drop any remaining generated or vendored trees the patterns missed.

   If the list is empty, report that there is nothing to simplify and stop without launching the workflow; it rejects an empty `files` array.

4. **Resolve the base ref** bounding the diff: `HEAD` for `uncommitted`, the step-2 merge-base for `branch` and `unpushed` (each its own), none for `codebase`. It is required for every non-`codebase` scope.

   **Build the prune candidate lists**, holding only code files that can contain comments (e.g. `.ts`, `.svelte`, `.js`). Neither list may ever name a path step 3's exclusions would have dropped for this scope: a vendored, generated, built or minified file the workflow was told not to simplify must not be reachable by a prune agent either. The workflow audits tracked candidates diff-bounded and untracked ones whole-file, hence two lists:
   - `pruneFiles`, the tracked candidates:
     - `uncommitted` / `branch` / `unpushed`: files changed vs the base whose diff adds a comment, e.g.

       ```sh
       { git -c core.quotePath=false diff --name-only <BASE>; } | sort -u \
         | grep -vE '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\.min\.' \
         | grep -E '\.(ts|js|svelte)$' \
         | while IFS= read -r f; do [ -f "$f" ] && git -c core.quotePath=false diff <BASE> -- "$f" | grep -qE '^\+.*(//|/\*|<!--)' && echo "$f"; done || :
       ```

     - `codebase`: all tracked code files containing a comment, after the same exclusions step 3 applies.

   - `pruneUntrackedFiles`, the untracked candidates, in every scope:

     ```sh
     git -c core.quotePath=false ls-files -o --exclude-standard \
       | grep -vE '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\.min\.' \
       | grep -E '\.(ts|js|svelte)$' \
       | while IFS= read -r f; do [ -f "$f" ] && grep -qE '(//|/\*|<!--)' "$f" && echo "$f"; done || :
     ```

   An empty list is still passed, as `[]`; even with both lists empty, the workflow audits the comments the simplify phase itself introduces.

   Also pass `pruneExts`, the extensions you filtered these lists on, e.g. `[".ts", ".js", ".svelte"]`. It is the set of comment-carrying source extensions for this repo, not narrowed to the extensions that happen to occur in the lists; the workflow judges files that appear mid-run by it.

5. **Discover the project's check command.** Look for how this project verifies itself: `package.json` scripts (`typecheck`, `test`, `lint`, `check`), a `Makefile` or `justfile` target, instructions in CLAUDE.md/AGENTS.md, or the language's convention (`cargo check && cargo test`, `go vet ./... && go test ./...`, `pytest`, etc.). Compose a single non-interactive command, preferring typecheck plus tests joined with `&&`; never a watch mode. Sanity-check it by running it once via Bash from the project root. Failing checks are fine (the workflow baselines them so pre-existing failures are never attributed to the run), but if the command itself cannot run (unknown script, missing tooling), discard it. If nothing trustworthy is found, omit `checkCmd`; the workflow then skips both the baseline and the fix-up.

6. **Capture the baselines**, both via Bash from the project root, immediately before launching:
   - the step-2 hash command, keeping the 64-character hex hash;
   - `git -c core.quotePath=false ls-files -o --exclude-standard`, keeping every path as `untrackedBaseline`. The workflow subtracts this set from a later listing to find files that appeared during the run, including any an apply agent created without declaring. Pass it **raw**: unlike `files` and the prune lists, do not filter it; a path filtered out here looks like a file the run created.

7. **Launch the workflow.** First resolve the absolute path of [simplify.mjs](simplify.mjs); it sits next to this SKILL.md, in the directory named by the `Base directory for this skill:` line of this skill's invocation. Substitute the resolved path below:

   ```
   Workflow({
     scriptPath: "<absolute path to simplify.mjs>",
     args: { scope: "<scope>", hashCmd: "<hash command>", baselineHash: "<baseline>", untrackedBaseline: [<raw untracked listing>], files: [<file list>], checkCmd: "<check command, omit when not found>", model: "<model, omit when not given>", effort: "<effort, required with model, omit otherwise>", pruneFiles: [<tracked prune candidates>], pruneUntrackedFiles: [<untracked prune candidates>], pruneExts: [<comment-carrying source extensions>], base: "<step-4 base ref, required for every scope except codebase, where it is omitted>", root: "<absolute project root>" }
   })
   ```

   Pass `files`, `untrackedBaseline`, `pruneFiles`, `pruneUntrackedFiles`, and `pruneExts` as real JSON arrays, not JSON-encoded strings. Every array is required: pass `[]` when the working tree has no untracked files or a prune list has no candidates. The script also accepts an optional `applyModel`, a model for the appliers only, which otherwise inherit the session's model; the appliers run at medium effort either way; the merge-ready workflow passes it, this skill never does.

   **If the run dies** (a session limit, a killed task), never resume it with `resumeFromRunId`, whatever the harness suggests: the judges and appliers start in the order the finders finish, so the cache misses partway through and the rest re-run live against a tree that already holds the edits. Relaunch from step 1 instead; every input is recomputed from the current tree.

8. **Report** the result by [REPORT.md](REPORT.md) in this skill's folder. Leave the changes uncommitted.
