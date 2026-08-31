---
name: auto-adversarial-code-review-workflow
description: Launches an adversarial code review workflow on the branch, auto-fixing findings when the fix is cheap.
disable-model-invocation: true
---

First scout the full branch diff against the merge-base with main, including uncommitted changes, yourself: read it and pick the review dimensions the diff plausibly touches. Then launch an adversarial code review dynamic workflow over that diff with the following phases:
- Find (Opus): specialized finders, one per dimension you picked while scouting.
- Verify (Opus): each finding goes to two adversarial skeptics, one attacking technical truth, one attacking materiality, each refuting by default when uncertain. A finding is confirmed only if neither skeptic can kill it.
- Work classifier (Opus): each confirmed finding is judged on whether the fix is relatively cheap and unlikely to cause other edge cases.
- Implementer (Fable): one implementer per cheap finding, leaving its changes uncommitted for the implementation verifier.
- Implementation verifier (Opus): adversarial code review focused on the implementer's changes. If the fix causes more bugs than it solves, send the finding back to a fresh implementer once; if the second attempt also fails, revert it. Otherwise commit it.

Workflow rules:
- Each finding verifies as soon as its finder completes, and confirmed findings go to the work classifier as soon as verification finishes, no barriers.
- Implementers run strictly one at a time; each implementation must be verified (committed or reverted) before the next implementer starts.

Once the workflow has finished, report every finding in four categories: fixed and committed, confirmed but not auto-fixed, fix attempted but reverted, and refuted. Number the findings continuously across the whole report (so each one can be quoted by its number), ordered by severity within each category.
