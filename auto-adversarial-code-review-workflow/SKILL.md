---
name: auto-adversarial-code-review-workflow
description: Launches an adversarial code review workflow on the branch, auto-fixing findings when the fix is cheap.
disable-model-invocation: true
---

Scout only the shape of the branch diff against the merge-base with main, including uncommitted changes: `git diff --stat` plus the changed file paths. Pick the review dimensions from those paths and sizes; the finders read the hunks. Then launch an adversarial code review dynamic workflow over that diff with the following phases:
- Find (Opus): specialized finders, one per dimension you picked while scouting.
- Verify (Opus): each finding goes to two adversarial skeptics, one attacking technical truth, one attacking materiality, each refuting by default when uncertain. A finding is confirmed only if neither skeptic can kill it.
  - The technical skeptic's verdict is three-way: refute, confirm as corrected, or confirm as-is. A wrong detail in the finding (bad arithmetic, a misattributed cause, an overstated scenario) is only a kill ground when the failure mechanism collapses with it; when the skeptic's own verification shows the underlying defect is real in a corrected form at the same location, it confirms the finding with the corrected description, and downstream phases (materiality, classifier, implementer) work from that corrected description. Uncertainty about whether the mechanism is real at all still defaults to refute, and a correction must be something the skeptic actually verified, not a charitable reinterpretation of the finder's claim.
  - The materiality skeptic's verdict is three-way: refute, confirm at a downgraded severity, or confirm as-is. Severity inflation alone is never a kill ground: when the mechanism is real but its impact is overstated, downgrade the severity and confirm rather than refute. Refuting on materiality is reserved for findings whose substance fails: cosmetic-only consequences, pre-existing conditions the branch didn't introduce or worsen, or documented tradeoffs — and a documented tradeoff only counts if it covers the specific regression found, not a related fallback (e.g. an ADR accepting graceful degradation for components that don't implement a mechanism does not excuse new gaps in a component that does implement it).
  - Materiality carve-out: a demonstrably false statement shipped to users (UI copy, translations, user-facing docs, error messages) is material by definition, however small its audience or consequence. The materiality skeptic may downgrade such a finding's severity (e.g. to low) but must not refute it; "nothing consumes it" or "no decision depends on it" are not valid kill grounds for factual incorrectness.
- Work classifier (Opus): each confirmed finding is judged on whether the fix is relatively cheap and unlikely to cause other edge cases.
- Implementer (Fable): one implementer per cheap finding, leaving its changes uncommitted for the implementation verifier.
- Implementation verifier (Opus): adversarial code review focused on the implementer's changes. If the fix causes more bugs than it solves, send the finding back to a fresh implementer once; if the second attempt also fails, revert it. Otherwise commit it.

Workflow rules:
- Each finding verifies as soon as its finder completes, and confirmed findings go to the work classifier as soon as verification finishes, no barriers.
- No implementer starts until every finder and every verification has completed. Implementers mutate the working tree, and any finder or skeptic still running would read that half-finished code and report phantom findings against it.
- Implementers run strictly one at a time; each implementation must be verified (committed or reverted) before the next implementer starts.

Once the workflow has finished, report every finding in four categories: fixed and committed, confirmed but not auto-fixed, fix attempted but reverted, and refuted. Number the findings continuously across the whole report (so each one can be quoted by its number), ordered by severity within each category.
