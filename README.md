# skills

Skills for Claude Code.

## Skills

| Skill | What it does |
| --- | --- |
| `merge-ready-workflow` | Takes a scope (uncommitted, branch, unpushed, codebase, or the work since a commit) to a mergeable state: adversarial review rounds, each opened by a no-comments pass that strips comments and fixes the code they excused, until a round fixes too little to justify another; then the simplify workflow, a comment pass over what it wrote, one review round over every refactor and constraint encoding landed since the last round, and a last pass stripping the comments that review's fixes wrote. Every stage commits. Needs `adversarial-review-workflow`, `simplify-workflow` and `no-comments`. |
| `adversarial-review-workflow` | One adversarial review over a scope: finders per dimension, two skeptics per finding, auto-fixes each confirmed finding with its smallest fix unless that fix is an excluded kind. |
| `simplify-workflow` | A no-comments pass whose refactors and constraint encodings go through a judge, simplification rounds (find, judge, apply) over a scope until fresh finders come up empty, a commit, then a pass stripping the comments the appliers wrote. Needs `no-comments`. |
| `mr-rebase-review` | Rebases a GitLab MR or branch onto its target when behind, audits the rebase for dropped upstream changes, reviews the MR for over-engineering, debt and spec conflicts, then lists decisions and, on approval, pushes and posts the critique as MR threads. |
| `no-comments` | Strips comments from a diff or files with a fresh comment-hating subagent, then fixes the code the deleted comments excused and offers to encode claimed constraints. pstack's `/no-comments`, without the rest of pstack. Its `no-comments.mjs` runs the same steps as a workflow for the simplify and merge-ready workflows. Its `full` mode encodes constraints without asking and lists every encoding in its report. Its `flags` and `delete-only` modes stop after the review step and leave correctness or safety suppressions in place as `MUST KILL` flags. |
| `prune-agent-docs` | Tests every statement in a repo's agent docs with blind headless `claude -p` probes run in a copy without the docs, deletes what the probes already get right from the code (keeping what they only found in human docs), rewrites the survivors with `writing-for-agents`, re-probes with the new docs, and commits on a branch. |
| `changelogs-to-patch-notes` | Turns the git log since a version or commit, plus CHANGELOG.md, into user-facing patch notes. |
| `glab-diffnote` | Posts GitLab MR discussion threads anchored to diff lines via `glab api`. |
| `glab-upload` | Uploads images to a GitLab project and embeds them in MR descriptions or notes. |

## Install

Everything, globally:

```bash
bunx skills@latest add Rivelia/skills --all --global
```

Pick skills, with prompts:

```bash
bunx skills@latest add Rivelia/skills --skill glab-diffnote glab-upload
```

### Let the workflows read their scripts

The workflow skills run scripts that sit in the skill folders (`merge-ready.mjs`, `review.mjs`, `simplify.mjs`, `no-comments.mjs`). Claude Code only reads a workflow script from the working directory or from a script it wrote itself, so a global install needs the skill directories allowed in `~/.claude/settings.json`. The CLI installs into `~/.agents/skills` and symlinks that into `~/.claude/skills`, and the skills resolve their script paths through the symlink, so both are needed:

```json
{
  "permissions": {
    "additionalDirectories": [
      "~/.claude/skills",
      "~/.agents/skills"
    ]
  }
}
```

A project-level install lands in the working directory and needs nothing.

## Update

Remove the installed skills, then add them again. `skills update` keeps whatever name a skill was installed under, so it misses renamed skills; a remove and add does not. The list includes retired names so an older install is cleaned too.

```bash
bunx skills@latest remove adversarial-review-workflow auto-adversarial-code-review-workflow auto-adversarial-code-review-loop-workflow changelogs-to-patch-notes glab-diffnote glab-upload merge-ready-workflow mr-rebase-review no-comments prune-agent-docs simplify-workflow --global -y
```

```bash
bunx skills@latest add Rivelia/skills --all --global
```

Drop `--global` from both commands for a project-level install.
