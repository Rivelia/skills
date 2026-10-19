# Comment passes in the workflows

The design agreed for replacing simplify's comment pruning with the no-comments skill, and for where its `MUST KILL` flags are applied.

## The pass

`no-comments/no-comments.mjs` runs the no-comments skill as a workflow over a file list:

- Comment Sicko, its prompt verbatim, per batch of up to 15 files and 2000 lines (a file whose line count the caller does not pass counts as 400), with the scope appended. The callers drop the files with no comment in scope first.
- An auditor per batch running the skill's step 2 verbatim, skipped when Sicko deleted, flagged and kept nothing. A rejected batch is reverted with `git checkout HEAD -- <files>`, its files plus the paths outside every batch that Sicko reports touching, and rerun once with the failure named; a second rejection reverts it again and reports it.
- Modes:
  - `full`: a baseline run of the check command before Sicko, when one is configured; a fix stage over every accepted flag (steps 3 and 4 verbatim, step 5 as automatic encoding), split by file into groups of at most 20 items worked one after another when the set is larger, a file with more than 20 items spanning consecutive groups, each later group getting the earlier groups' shape sketches and a group whose agent dies reported open; the project checks on the files each fix agent touched; then one fix-up running the check command, only when the baseline returned and the pass changed something.
  - `flags`: return the accepted `MUST KILL` flags and the deleted constraint comments as seeds for simplify's judge.
  - `delete-only`: report the flags, apply nothing.
  - In `flags` and `delete-only` the fix stage (steps 3 to 5) never runs, so the Sicko and auditor prompts get one appended rule: a correctness or safety suppression stays in place, flagged `MUST KILL`, and is restored if deleted.
- Constraints are encoded without asking, cheapest first: a type, a lint rule, a test, and a runtime check only when none of those can express it. Every encoding is listed in the report for a human to check.
- The pass commits what it changed. It runs only on a clean tree; its callers guarantee that.
- Sicko and the auditor run on Opus; the fix stage on the caller's model override, else Opus.

The interactive `/no-comments` skill stays the source of truth for the prompts; the workflow embeds them verbatim.

## Clean trees

Every workflow commits a dirty tree as `W` (`wip: …`) before launch, after asking about untracked files that look like secrets or scratch files. The base never moves; `W` is the author's last commit (`loopStart`). Every stage commits its own changes, so each comment pass starts on a clean HEAD and a rejected batch reverts with `git checkout`.

## Standalone simplify

`flags` pass, a seed stage (seeds judged by their own criteria, then applied), the find/judge/apply loop, the fix-up, a commit, then a `delete-only` pass over the files the appliers touched, which reports its `MUST KILL` flags.

## Merge-ready

1. Every review round opens with a `full` pass: round 1 over the scope, round N+1 over the files round N's fixes touched, bounded by the diff since the previous pass. Its reshapes are reviewed by the round that follows and never count toward another round.
2. Once the loop converges: a `flags` pass over the last round's fix files, simplify with those seeds (it commits itself), a `full` pass over the files simplify touched.
3. When a `MUST KILL` reshape or an encoding landed since the last review round: one review round scoped to those files, which never extends the loop.
4. A `delete-only` pass over that round's fixes ends the run.

## Starting from a commit

Every workflow skill accepts a commit-ish in place of the scope name (the `since` scope: the work since that commit), which must be an ancestor of HEAD. Reports end with the final HEAD and the command to continue from it.
