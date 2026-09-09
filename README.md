# skills

Skills for Claude Code.

## Skills

| Skill | What it does |
| --- | --- |
| `merge-ready-workflow` | Takes a scope (uncommitted, branch, unpushed, codebase) to a mergeable state: adversarial review rounds with fresh finders until a round fixes too little to justify another, then the simplify workflow over the same scope. Needs `adversarial-review-workflow` and `simplify-workflow`. |
| `adversarial-review-workflow` | One adversarial review over a scope: finders per dimension, two skeptics per finding, auto-fixes when the smallest fix fits the severity. |
| `simplify-workflow` | Simplification rounds (find, judge, apply) over a scope until fresh finders come up empty, then prunes non-useful comments. |
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

The three workflow skills run a script that sits in the skill folder (`merge-ready.mjs`, `review.mjs`, `simplify.mjs`). Claude Code only reads a workflow script from the working directory or from a script it wrote itself, so a global install needs the skill directories allowed in `~/.claude/settings.json`. The CLI installs into `~/.agents/skills` and symlinks that into `~/.claude/skills`, and the skills resolve their script paths through the symlink, so both are needed:

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
bunx skills@latest remove adversarial-review-workflow auto-adversarial-code-review-workflow auto-adversarial-code-review-loop-workflow changelogs-to-patch-notes glab-diffnote glab-upload merge-ready-workflow simplify-workflow --global -y
```

```bash
bunx skills@latest add Rivelia/skills --all --global
```

Drop `--global` from both commands for a project-level install.
