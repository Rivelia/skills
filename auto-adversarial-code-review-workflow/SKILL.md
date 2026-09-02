---
name: auto-adversarial-code-review-workflow
description: Launches an adversarial code review workflow over a scope (uncommitted | branch | unpushed | codebase), auto-fixing findings when the fix is cheap.
argument-hint: "<uncommitted|branch|unpushed|codebase>"
disable-model-invocation: true
---

## Resolve the scope

The first argument is the scope and must be exactly one of `uncommitted`, `branch`, `unpushed`, `codebase`; if it is missing or anything else, ask the user which scope to use and stop without launching anything. Any further argument: ask the user what it means and stop.

Resolve the base ref bounding the diff:
- `uncommitted`: `HEAD`.
- `branch`: the merge-base with the default branch, e.g. `git merge-base HEAD "$(git symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null || echo main)"`.
- `unpushed`: the merge-base with the branch's upstream, `git merge-base HEAD @{upstream}`. If the branch has no upstream (`git rev-parse @{upstream}` fails), ask the user which remote ref bounds the unpushed work and stop without launching anything.
- `codebase`: none; the review covers every tracked file.

Every diff-bounded scope includes uncommitted changes and untracked files: the diff under review is `git diff <BASE>` (working tree against the base) plus `git ls-files -o --exclude-standard`.

Record whether the working tree was clean at launch (`git status --porcelain` empty); the implementation verifier needs it.

## Scout

Scout only the shape of the scope: `git diff --stat <BASE>` plus the changed and untracked file paths, or for `codebase` the tracked file list with line counts. Pick the review dimensions from those paths and sizes; the finders read the hunks (the whole files for `codebase`). If the scope is empty, report that there is nothing to review and stop without launching the workflow.

## Launch

Launch an adversarial code review dynamic workflow over that scope with the following phases:
- Find (Opus): specialized finders, one per dimension you picked while scouting. Every finder gets the full dimension list with the files each one owns, and reports a defect once, at its root location, even when several of the files it read expose it.
- Dedup (Sonnet): before a finding enters verification, one check compares it with every finding already registered (title, file, line, description) and says whether it is the same defect as one of them: two findings are the same defect when one change at one location fixes both. A duplicate attaches to the earlier finding as "also reported by" and inherits that finding's verdicts and outcome instead of getting its own skeptics, classifier and implementer. The check runs against whatever is registered at that moment and never waits on other finders.
- Verify (Opus): each finding goes to two adversarial skeptics in sequence, first one attacking materiality, then one attacking technical truth, each refuting by default when uncertain. A finding is confirmed only if neither skeptic can kill it. Most kills come from materiality, so the materiality skeptic runs first and a materiality refutation ends verification without spawning the technical skeptic; the technical skeptic only runs on findings that survived materiality.
  - The technical skeptic's verdict is three-way: refute, confirm as corrected, or confirm as-is. A wrong detail in the finding (bad arithmetic, a misattributed cause, an overstated scenario) is only a kill ground when the failure mechanism collapses with it; when the skeptic's own verification shows the underlying defect is real in a corrected form at the same location, it confirms the finding with the corrected description, and downstream phases (classifier, implementer) work from that corrected description. Uncertainty about whether the mechanism is real at all still defaults to refute, and a correction must be something the skeptic actually verified, not a charitable reinterpretation of the finder's claim. When the correction changes the finding's consequence (not just its mechanics), the finding goes back through the materiality skeptic once with the corrected description, since the earlier materiality verdict judged the finder's version.
  - The materiality skeptic's verdict is three-way: refute, confirm at a downgraded severity, or confirm as-is. Severity inflation alone is never a kill ground: when the mechanism is real but its impact is overstated, downgrade the severity and confirm rather than refute. Refuting on materiality is reserved for findings whose substance fails: cosmetic-only consequences, pre-existing conditions the diff didn't introduce or worsen (a ground that does not exist for `codebase`, which has no base), or documented tradeoffs — and a documented tradeoff only counts if it covers the specific regression found, not a related fallback (e.g. an ADR accepting graceful degradation for components that don't implement a mechanism does not excuse new gaps in a component that does implement it).
  - Materiality carve-out: a demonstrably false statement shipped to users (UI copy, translations, user-facing docs, error messages) is material by definition, however small its audience or consequence. The materiality skeptic may downgrade such a finding's severity (e.g. to low) but must not refute it; "nothing consumes it" or "no decision depends on it" are not valid kill grounds for factual incorrectness.
- Work classifier (Opus): each confirmed finding is judged on whether the fix is relatively cheap and unlikely to cause other edge cases.
- Root-cause clustering (Opus): once every finder and every verification has completed, one agent groups the cheap findings by root cause and names a lead finding per cluster. Findings in different files belong to one cluster when a single change fixes them all (a cap change and the viewers it silently truncates, a missing predicate and the endpoints that rely on it). One implementer handles the whole cluster. Its siblings then go only to the implementation verifier, which checks each one against the cluster's hunks and records it as covered or sends it to its own implementer.
- Implementer (Fable): one implementer per cluster, leaving its changes uncommitted for the implementation verifier and reporting exactly which files and hunks it changed. When a fix accepted earlier in the same run already covers the finding, it changes nothing and reports which finding's fix covers it.
- Implementation verifier (Opus): adversarial code review focused on the implementer's reported hunks. If the fix causes more bugs than it solves, send the finding back to a fresh implementer once; if the second attempt also fails, revert it. Otherwise accept it: commit it when the working tree was clean at launch, else leave it in the working tree so it does not get entangled with the user's uncommitted work. When the implementer changed nothing and the verifier agrees an earlier fix covers the finding, the verdict is covered, naming that finding, and nothing is reverted. Reverting means undoing only the implementer's hunks; never `git checkout` or `git restore` a file that held uncommitted work at launch.

Workflow rules:
- Each finding verifies as soon as its finder completes (materiality skeptic, then technical skeptic if materiality did not refute), and confirmed findings go to the work classifier as soon as verification finishes, no barriers.
- No implementer starts until every finder and every verification has completed. Implementers mutate the working tree, and any finder or skeptic still running would read that half-finished code and report phantom findings against it. Root-cause clustering runs at this barrier, once.
- Implementers run strictly one at a time; each implementation must be verified (committed, kept, covered, or reverted) before the next implementer starts.

## Report

Once the workflow has finished, report every finding in six categories: fixed (saying whether the fixes were committed or left uncommitted in the working tree), covered by another finding's fix (naming it), confirmed but not auto-fixed, fix attempted but reverted, never attempted because an agent failed, and refuted. Number the findings continuously across the whole report (so each one can be quoted by its number), ordered by severity within each category. A finding attached at intake appears under its primary as "also reported by" with the finder that reported it, without a number of its own.
