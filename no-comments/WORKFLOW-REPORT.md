# Reporting a no-comments.mjs result

A comment pass returns `mode` (`full`, `flags`, `delete-only`). Report it in one short block:

- `deletions` comments deleted over `batches` batches, with each entry of `restored` (the comment, its file and the exception it fits) and `reruns`, the batches the auditor rejected once and Comment Sicko redid.
- `revertedBatches`: rejected twice, or once with a revert that failed; give the files and the `failure`. Their files were reverted and keep every comment, except when `reverted` is false: then say prominently that the revert failed and the batch's rejected edits went into the commit. `deadBatches`: an agent died, naming it (`at`); when `reverted` is false, say prominently that the batch's unaudited edits went into the commit.
- `mustKills.applied`: one line each, the symbol and what changed. `mustKills.reported`: flagged but not applied, one line each with its reason; for a `delete-only` pass these are the refactors left for the user.
- `encodings`, prominently: each constraint, the kind of enforcement (`type`, `lint`, `test`, `runtime-check`) and `where` it lives, saying the user should check each one was done properly. A `runtime-check` changes behaviour; name it as such.
- `unenforced`: each constraint whose comment was deleted with nothing enforcing it, with its `sketch` when present. `open`: everything else the fix stage left open. `shapeSketch`: relay it when the fixes needed a new shape.
- `checkFailures`, prominently, when non-empty; `verification` `baseline-failed` or `fixup-died`: the pass was not verified.
- `commit`: the sha and files, or `reason` when nothing was committed; name any `discarded` check outputs, deleted instead of committed.

A `flags` pass reports its `seeds` count instead of fixes: the seeds go to simplify's judge, whose verdicts the simplify report carries. When the caller says simplify did not run, no judge saw them and their comments are already deleted: list each `must-kill` seed (its file, symbol and description) as a refactor left for the user, and each `constraint` seed (its file and description) as a constraint whose comment was deleted with nothing enforcing it.
