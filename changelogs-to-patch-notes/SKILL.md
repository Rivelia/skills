---
name: changelogs-to-patch-notes
description: Turn the git log since a version or commit, plus CHANGELOG.md when present, into user-facing patch notes returned as the answer.
argument-hint: "<version|commit> [language] [author]"
disable-model-invocation: true
---

Turn everything that landed after a version or a commit into patch notes for the people who use the product, returned as the answer. The repository is only read.

## Steps

1. **Resolve the arguments.** The first is a version or a commit. After it, in any order: the word `author`, which appends who wrote each change, and a language, which appends a translated copy. A version resolves to its tag (`v1.4.0` or `1.4.0`), else to the commit that added its section to `CHANGELOG.md`; a commit resolves with `git rev-parse`. If nothing resolves, ask the user and stop.

2. **Collect the range**: `git log <start>..HEAD` with subjects, bodies and authors (`%an`, the person who wrote the change, never the committer who merged it), skipping merge commits and release housekeeping (changelog commits, version bumps). When `CHANGELOG.md` exists, its sections newer than the start give the release boundaries and dates. Commits after the last released section belong to the next release, whose number is not decided yet. Done when every commit in the range is either assigned to a release or deliberately dropped.

3. **Write the notes**, in the language of the commit messages.
   - The reader uses the product and never sees its code. Every bullet says what they gain, in their words: no hashes, no commit prefixes or scopes, no identifiers, no settings. A command or a name appears only when the reader types it; UI labels go in plain quotes.
   - A bullet comes from what the change does, which a subject line alone rarely tells.
   - One `##` heading per release, newest first, with its date; commits past the last release come first under `## Next release`. A range inside a single release has no release heading.
   - Under each heading, `### New`, `### Improvements`, `### Fixes`, empty ones omitted, bullets ordered by impact on the reader.
   - One bullet per change, one sentence of at most 35 words, spoken to the reader the way a colleague would tell them: it opens with a past-tense verb (Added, Fixed, Improved), names the symptom as the reader saw it and what it cost them, then says what happens now instead. The mechanism behind a bug stays out. "Fixed an issue where attachments were dropped when a message exceeded the model's context window: an error card now appears and the turn stops instead." "Fixed an issue where a delegated sub-task such as Deep Search or General Subagent would always come back as if it succeeded instead of a clear error, confusing the caller model."
   - A bullet is the headline of a change; the details stay in the product for the reader to discover.
   - A new feature too large for one sentence keeps that sentence and adds at most four sub-bullets, each a headline of what the reader can now do, under the same word cap. Fixes and improvements stay single lines.
   - Commits that are parts of one change (a feature and its migration, a fix and its follow-up, a fix to a feature released in the same range) become one bullet.
   - The reverse holds for a squashed commit that bundles several loosely related or unrelated changes: it splits into one bullet per change, as if each had landed as its own commit, and the folding above then applies among those parts, so its migrations, review fixes and tests join the change they serve.
   - Internal work (CI, tests, refactors, dependency updates, agent docs) appears only through its effect on the reader, phrased as that effect, else dropped.
   - With `author`, every bullet ends with its author's name in parentheses, every author when commits were folded; sub-bullets carry none, their feature's bullet does.

4. **Translate** when a language was given: after the notes, a horizontal rule, then the same notes in that language, headings included, same structure and bullet count.

The answer is the notes alone: it starts at the first heading and ends at the last bullet.
