---
name: mr-rebase-review
description: Rebase a GitLab MR or branch onto its target when behind, audit the rebase for dropped upstream changes, review the MR for over-engineering, debt and spec conflicts, then list decisions and, on approval, push and post the critique as MR threads.
argument-hint: "<mr-number|branch>"
disable-model-invocation: true
---

Bring one MR up to date with its target, prove the rebase lost nothing, judge the MR as a whole, and hand the user a list of decisions. Nothing is pushed or posted until the user answers.

## Steps

1. **Resolve the argument.** A number is an MR: `glab mr view <n> -F json` gives its source branch, target branch, title and author. Anything else is a branch: `glab mr list --source-branch <branch> -F json` finds its open MR; with none, there is nowhere to post and the target is the remote's default branch. If the argument is missing or resolves to nothing, ask the user and stop. When the MR's `source_project_id` differs from its `target_project_id`, its branch lives in a fork, not on `origin`: ask the user and stop. Read the issues the MR links (`glab issue view <n>`) and the follow-up issues they reference: they are the **spec** the review checks against.

2. **Check out.** `git fetch origin`, then `git checkout -B <branch> origin/<branch>` on a clean working tree; if the tree is dirty, the branch is checked out in another worktree, or a local `<branch>` has commits `origin/<branch>` lacks (`git rev-list origin/<branch>..<branch>` is non-empty), ask the user and stop, since `-B` would drop them. Record the **old base** (`git merge-base HEAD origin/<target>`) and the **original head** (`git rev-parse HEAD`). When the old base is already `origin/<target>`'s tip, the branch is current: go to step 5.

3. **Rebase.** `git rebase origin/<target>`. The dangerous conflicts are where the MR moved or rewrote code that upstream also edited: taking the MR's side **silently drops** upstream's edit, and nothing is left to show it.
   - For each conflicted file, read upstream's change since the old base (`git diff <old-base> origin/<target> -- <file>`, and `git log` on it for the why). **Port** that change into wherever the MR now holds the logic, and restore any upstream guard the MR's side omits.
   - A doc upstream rewrote: take upstream's version; MR wording it loses becomes a decision.
   - Generated files (migrations, lockfiles): regenerate them the way the repo's agent docs (`AGENTS.md`, `CLAUDE.md`) say.
   - Pin each ported behaviour with a test, and where practical show it goes red with the port removed.
   - Run the repo's type check, full test suite and lint (named in its agent docs or package scripts) and fix the fallout, such as fixtures missing a field upstream made required. Finish the rebase with the MR's commit messages unchanged.

   Done when every conflict hunk is in the **port log** (file, upstream change, where it went, or why it was dropped) and check, tests and lint pass.

4. **Audit the rebase.** Dispatch the four reviewers in [REVIEWERS.md](REVIEWERS.md) in parallel and in the foreground, all four in one message, so their reports come back to you before your turn ends. Fix every gap they confirm that restores **parity** with upstream, folded into the MR's commits (`git commit --amend` for the last commit, else `git commit --fixup <sha>` then `GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/<target>`), then re-run check, tests and lint. A fix that changes the MR's design or API shape beyond parity goes to the decision list instead. Done when every reviewer finding is fixed or listed as a decision.

5. **Review the MR.** Weigh `git diff origin/<target>...HEAD` against the spec: is it good for the codebase, is it over-engineered, does it leave debt? Hunt for:
   - abstraction with no caller yet, built for a consumer that may never take that shape;
   - two paths for one concern that can **drift** (the port log is evidence: a change that had to land in two places will drift again);
   - patterns the MR applies inconsistently within itself;
   - defensive code for cases no caller can reach;
   - behaviour that contradicts a decision in the spec;
   - what is genuinely good: fixed bugs, tests, rules now held in one place.

   Every point names its file and function. Done when every file the MR adds or rewrites has been weighed.

6. **Report and stop.**
   - **Rebase**: old base to new head (or "already current"), the port log, tests added, check/tests/lint results.
   - **Rebase audit**: what the reviewers confirmed and what you fixed.
   - **Review**: a one-line verdict, then **Good**, **Built ahead of need**, **Tech debt** and one **Spec conflict with #N** section per conflict, empty ones omitted, numbered points with `file:line`.
   - **Decisions**, numbered: each design fix with your recommendation; MR wording a rebase dropped; the push when the branch changed or a decision above would change it, as its own `bash` block (`git push --force-with-lease=<branch>:<original-head> origin <branch>`, leasing against the head recorded in step 2); posting the critique as threads, when there is an MR.

   Then wait for the user.

7. **Carry out what the user chose.** Apply the chosen fixes with tests, re-run check, tests and lint, fold them into the MR's commits, then push with that block's lease against the original head when chosen. To post, write one general discussion thread per negative section (Built ahead of need, Tech debt, each Spec conflict), addressed to the MR's author: bold lead-in per point, file paths in backticks, a suggested direction, and "fixed in the rebased push" where the rebase or a decision already fixed it. Post each from a markdown file written outside the repo, so the checkout stays clean:

   ```bash
   jq -n --rawfile body /tmp/thread.md '{body: $body}' > /tmp/thread.json
   glab api -X POST 'projects/:id/merge_requests/<n>/discussions' -H 'Content-Type: application/json' --input /tmp/thread.json
   ```

   Report the pushed head, the discussion ids and the MR link.
