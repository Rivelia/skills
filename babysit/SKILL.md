---
name: babysit
description: Takes GitLab MRs to merged. For each MR it runs merge-ready-workflow branch, pushes, marks it ready, approves it, sets a squash auto-merge with a Changelog trailer, and watches it until merged, fixing failures on the way. With no argument it babysits the current branch's MR.
argument-hint: "[<MR> ...]"
disable-model-invocation: true
---

# Babysit

Every MR ends **merged**, or held on a question for the user. A held MR leaves the others running. The work is done when each MR is merged with a squash commit carrying its `Changelog:` trailer and its source branch deleted, or is waiting on a question you asked.

## 1. Resolve the MRs

An argument is an MR: `!988`, `988` or its URL. With no argument, take the MR whose source branch is the current branch: `glab mr list --source-branch "$(git branch --show-current)"`. If there is none, or an MR is closed or merged, say so and stop for that MR.

## 2. Give each MR a worktree

An MR whose source branch the session's directory has checked out runs there, in place. Any other MR gets its own worktree at `origin/<source_branch>`, on a local branch tracking it, set up with the project's command (AGENTS.md names it). A worktree session can't do that: the desktop app blocks it, and its workflows' agents, from writing to any other worktree, so tell the user to start those MRs from a session without one. Push with `git push origin HEAD:<source_branch>`: another session's worktree may hold the branch itself.

If `detailed_merge_status` is `need_rebase` or `conflict`, rebase onto the target branch first. When resolving a conflict needs a judgement call, ask the user.

## 3. Run merge-ready on each

Invoke the `merge-ready-workflow` skill once to load its steps, with scope `branch`. Then launch one Workflow per MR, all at once. Each gets that MR's worktree as `root` and its own `base` and `loopStart`. Handle each result on its own.

Read each result by the skill's own report rules. **Hold** the MR and ask the user when any of these is true:

- `stopReason` is not `converged`.
- `possiblyDirty` is non-empty.
- A finding left `not_fixed` needs a design choice.
- A `MUST KILL` refactor is reported for the user.
- An encoding is listed as unenforced.

Apply a confirmed `not_fixed` finding yourself when it comes with a concrete plan, then run the checks it names. Frontend changes get the project's browser verification before the push (see AGENTS.md).

## 4. Push

Push with the hooks running; `--no-verify` is off-limits. A pre-push hook that runs the whole suite can time out while the other workflows load the machine. Rerun each failing file on its own. If it passes alone and the diff doesn't touch it, push again, and wait for the load to drop if it fails again. A test that also fails alone is a real failure: fix it in the MR's worktree.

## 5. Ready, approve, merge

Do these after the push, because a push can reset approvals:

```bash
glab mr update <iid> --ready
```

```bash
glab mr approve <iid>
```

```bash
glab mr merge <iid> --squash --remove-source-branch --auto-merge --sha <pushed sha> -y --squash-message "<MR title>

Changelog: <value>"
```

Take the `Changelog:` value from the project's commit doc (AGENTS.md names it). Otherwise map the title's type: `feat` → `added`, `fix` → `fixed`, `refactor` → `changed`, `perf` → `performance`, anything else → `other`.

## 6. Watch until merged

Run one background watch per MR:

```bash
for i in $(seq 1 120); do s=$(glab mr view <iid> -F json | jq -r '"\(.state) \(.head_pipeline.status) \(.detailed_merge_status)"'); case "$s" in merged*|closed*|*failed*|*canceled*|*need_rebase*|*conflict*) echo "$s"; exit 0;; esac; sleep 30; done; echo "timeout: $s"
```

When the watch reports:

- **Failed pipeline**: read the failed jobs' logs (`glab ci view`, or `glab api projects/:id/jobs/<id>/trace`). Rerun a flaky test locally to tell it from a real failure. For a flaky one, retry the job with `glab ci retry <job-id>`. When the job is not retryable, start a new MR pipeline with `glab api --method POST projects/:id/merge_requests/<iid>/pipelines`. A failed pipeline cancels the auto-merge, so run step 5's merge command again. Fix a real failure in the MR's worktree, then go back to step 4.
- **`need_rebase` or `conflict`**: rebase as in step 2, then go back to step 4.
- **`timeout`**: restart the watch.

Once an MR merges, confirm two things: `squash_commit_sha` names a commit whose message ends with the trailer, and `git ls-remote origin <source_branch>` prints nothing. Then remove any worktree and local branch this skill created for it.

## 7. Report

For each MR, give:

- what merge-ready found and fixed, by its report rules;
- what you fixed yourself, and every push retry and its reason;
- the squash commit, or the question the MR is held on.
