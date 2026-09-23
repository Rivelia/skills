---
name: simplify-workflow
description: Loop simplification rounds (find, judge, apply) over a scope (uncommitted | branch | unpushed | codebase) via a Workflow until fresh finders come up empty, then prune non-useful comments.
argument-hint: "<uncommitted|branch|unpushed|codebase> [model effort]"
disable-model-invocation: true
---

A Workflow converges the scoped code to a stable simplified form. Each round runs find, judge, apply over batches of files: fresh finders propose, independent judges strike what is not a genuine improvement, and appliers implement only what survives. Rounds repeat until a confirmation sweep applies nothing and the tree hash lands on an already-seen state. A comment-pruning phase follows convergence. You orchestrate from outside the loop: resolve the inputs, launch the workflow, relay its result. The loop mechanics, embedded prompts, and comment-classification rules live in [simplify.mjs](simplify.mjs) in this skill's folder.

## Steps

1. **Resolve the arguments.** Parse them in this exact order; every "ask the user" below means ask and stop, without launching anything.
   - The first argument is the scope and must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use.
   - After the scope, what remains must be nothing, `[model]`, or `[model] [effort]`, in that order and nothing else.
   - The model must be a plausible model name (e.g. `opus`, `sonnet`, `haiku`). If the token after the scope is not a model name, ask the user what they meant. An effort is one of `low`, `medium`, `high`, `xhigh`, `max`. If a model is given without a following effort, ask the user which effort to use; the model/effort pairing is the user's call, never defaulted. The override drives the find, apply, classify and remove agents; the judge and the verify agents keep the fixed models set in [simplify.mjs](simplify.mjs).
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

   **Build the prune candidate lists**, holding only code files that can contain comments (e.g. `.ts`, `.svelte`, `.js`). Neither list may ever name a path step 3's exclusions would have dropped for this scope: a vendored, generated, built or minified file the workflow was told not to simplify must not be reachable by a remove agent either. The workflow classifies tracked candidates diff-bounded and untracked ones whole-file, hence two lists:
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

   An empty list is still passed, as `[]`; even with both lists empty, the workflow classifies the comments the simplify phase itself introduces.

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

   Pass `files`, `untrackedBaseline`, `pruneFiles`, `pruneUntrackedFiles`, and `pruneExts` as real JSON arrays, not JSON-encoded strings. Every array is required: pass `[]` when the working tree has no untracked files or a prune list has no candidates. The script also accepts an optional `applyModel`, a model for the appliers only, which otherwise inherit the session's model; the merge-ready workflow passes it, this skill never does.

   The workflow returns `{scope, iterations, sweeps, stopReason, distinctTreeStates, findingsProposed, findingsApproved, rejectedFindings, changesApplied, undeclaredFiles, unanalyzedFiles, abandonedAfterProgress, discoveryFailed, unresolvedCheckFailures, verificationStatus, checkBaselineFailing, prune, reportFlags, summary}`. Step 8 defines how to read and report every field; semantics beyond what it states live in [simplify.mjs](simplify.mjs).

8. **Report.** Relay `summary` grouped under its three headings (`Performance improvements`, `Code simplifications`, `Bug fixes`), plus the round count (`iterations`), the sweep count (`sweeps`), and the proposed/approved/applied counts (`findingsProposed`, `findingsApproved`, `changesApplied`); the gap between proposed and approved is the judge doing its job. Relay every entry in `rejectedFindings` under its own heading, with its description, its files, and the judge's reason, so the user sees what the judges struck and why. Leave the changes uncommitted. Then obey every row of the table below whose condition holds; a row may impose an action or a prohibition, not only a line of report. The script computes the recurring conditions in `reportFlags`:

   - **Full prune object** is `reportFlags.fullPrune`: `prune` is anything but `{stopReason: "skipped-simplify-unstable"}`. Otherwise no other `prune` field exists, so no row that names one applies.
   - **Edited** is `reportFlags.edited`: an applier or remover changed something, proven by a reported change or by the tree hash moving even when no agent lived to report it.
   - **Edit possible** is `reportFlags.editPossible`: a phase lost track of the tree hash, so an applier or remover may have written before it did.
   - **[UNVERIFIED]** is `reportFlags.unverified` and **[NO CHECK]** is `reportFlags.noCheck`.

   | When | Report |
   | --- | --- |
   | `prune.stopReason` is `skipped-simplify-unstable` | State that pruning was skipped because simplification never converged, naming the top-level `stopReason` as what it stopped on. No other row naming a `prune` field applies. |
   | `prune` is a full prune object | Report `prune.removed`, every `prune.skipped` entry with its reason, `prune.batchesDone`/`prune.batchesTotal`, and `prune.iterations`. |
   | `unanalyzedFiles` is non-empty | List those paths and say they were never analysed because their batch's agents kept dying or were skipped, so the rest of the scope could still converge; drop that last clause when `stopReason` is `all-batches-abandoned`, where there is no rest. |
   | `undeclaredFiles` is non-empty | List those paths and say they were never simplified. An apply agent created them without reporting them, so they missed the simplify loop. |
   | `discoveryFailed` is true | Say, in place of the `undeclaredFiles` line, that the workflow could not list the files created during the run, so any undeclared ones were neither pruned nor verified. |
   | `abandonedAfterProgress` is non-empty | List those paths and say their batch was dropped after repeated agent deaths, so the loop never confirmed they had settled; whatever the stop reason, make no claim that the whole scope converged. |
   | Full prune object and `prune.unauditedFiles` is non-empty | List those paths and say their comments may not be fully audited, whatever the stop reason says. The classify agents for their batch died or were skipped, so it never produced a clean pass; never say the comments were fully audited. |
   | `unresolvedCheckFailures` is non-empty | Before reporting, fix any breakage yourself in files the workflow touched; then list what still remains, prominently, saying the workflow's own fix-up agent already tried and failed to repair these. An entry whose `file` is `(unattributed)` names no path, because the fix-up reported the check still failing without naming any failure; treat it as a failure with no known location and open no file for it. |
   | **[UNVERIFIED]** | State prominently that the project was never verified and that the user should run the check command manually; when `unresolvedCheckFailures` is empty, say that its emptiness proves nothing. |
   | **[UNVERIFIED]** and **edited** | Add that the project was edited without verification. |
   | **[UNVERIFIED]** and not **edited** and **edit possible** | Say instead that an edit cannot be ruled out and was not verified. |
   | `verificationStatus` is `fixup-died` and `prune` is a full prune object whose `verificationStatus` is `ran` | Say the mid-run verification died but the prune fix-up re-ran the same check on the final tree, so the final tree was verified and `unresolvedCheckFailures` is meaningful. |
   | `checkBaselineFailing` is true | Say the project's check was already failing before the run, that those pre-existing failures were left alone and are still there, and that an empty `unresolvedCheckFailures` therefore means only that the run caused no new failure. Do not report the project as green or as passing its check. |
   | **[NO CHECK]** | State prominently that no check command could be found for this project, that an empty `unresolvedCheckFailures` therefore means nothing, and that the user should verify the tree themselves before relying on or committing it. Do not tell them to re-run the check command; there is none. |
   | **[NO CHECK]** and **edited** | Add that the edits were never verified by anything. |
   | **[NO CHECK]** and not **edited** and **edit possible** | Say instead that anything the run may have edited was never verified. |
   | `stopReason` is `all-batches-abandoned` | State prominently that every batch was abandoned because its agents kept dying or were skipped, so the scope was never analysed at all; make no claim that anything converged or that the code was already in good shape. |
   | **[AFTER-PROGRESS]** `stopReason` is `all-batches-abandoned-after-progress` | Relay the summary normally and state that the loop stopped because every remaining batch's agents kept dying or were skipped, so convergence was never confirmed. |
   | **[AFTER-PROGRESS]** and `distinctTreeStates` is non-zero | Say the tree was left edited. This is the only **[AFTER-PROGRESS]** row that says so; it suppresses no other row, and never the verification warnings above. |
   | **[AFTER-PROGRESS]** and `distinctTreeStates` is zero | Say instead that earlier rounds analysed part of the scope without recording any change. |
   | **[UNSETTLED]** `stopReason` is `max-iterations`, or a full prune object's `stopReason` is `max-iterations` | State that that phase did not settle within 100 rounds and that the summary covers the work done so far. |
   | **[UNSETTLED]** `stopReason` is `hash-unavailable`, or a full prune object's `stopReason` is `hash-unavailable` | State that the hash agent could not return a hash, so that phase's convergence could not be confirmed and the summary covers the work done so far. |
   | **[UNSETTLED]** and the triggering phase recorded a change: `changesApplied` or `distinctTreeStates` non-zero at top level, `prune.removed` or `prune.distinctTreeStates` non-zero for prune | Say the tree was edited. |
   | **[UNSETTLED]** via `max-iterations` and the triggering phase recorded no change: `changesApplied` and `distinctTreeStates` both zero at top level, `prune.removed` and `prune.distinctTreeStates` both zero for prune | Say that nothing was recorded as changed and that the final state could not be confirmed. |
   | **[UNSETTLED]** via `hash-unavailable` and the triggering phase recorded no change, the same counters both zero | Say that nothing was recorded as changed, that an edit could not be ruled out, and that the final state could not be confirmed. |
   | Full prune object whose `stopReason` is `incomplete-dead-agent` | State that pruning stopped with `prune.batchesTotal - prune.batchesDone` batches unfinished because its agents kept dying; make no claim about confirmed removal candidates; the deaths may have been classify agents, in which case those batches' comments were never classified at all. |
   | Full prune object whose `stopReason` is `all-batches-clean` | Report it as the expected healthy outcome, every batch audited until it produced no further candidates, and add no caveat of your own. |
   | Full prune object whose `stopReason` is `converged` | Say the tree stopped moving while batches were still active, so the remaining `prune.batchesTotal - prune.batchesDone` batches never produced a clean pass. |

   Four notes on rows that interact. The `all-batches-clean` row licenses no silence: the `prune.unauditedFiles` and `abandonedAfterProgress` rows override it and still fire. `unanalyzedFiles` and `abandonedAfterProgress` are disjoint lists telling two different failure stories; never merge them into one list. The `skipped-simplify-unstable` row is the only place pruning-was-skipped is reported, so the abandonment rows do not repeat it. `scope` and `distinctTreeStates` are not reported to the user directly; `distinctTreeStates` is only ever a condition here.
