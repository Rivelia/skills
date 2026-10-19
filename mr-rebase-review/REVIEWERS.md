# Rebase reviewers

Four subagents, dispatched in parallel, each from a different angle. Give every one the old base, the original head, the rebased head, the target branch and the port log as the list of intended differences, and tell it the audit is read-only: it changes no file and never commits or pushes. Each returns findings with `file:line` evidence, plus the hunks it verified as carried over correctly.

1. **Upstream changes.** For every commit in `<old-base>..origin/<target>`, check each hunk that touches a file the MR modifies, or logic the MR moved (search by identifier), and confirm its behaviour survives in the rebased head. Check the files that merged without conflict for semantic clashes: a signature the MR changed and a caller upstream added, an enum upstream extended that the MR switches over.

2. **Original against rebased.** Run `git range-diff <old-base>..<original-head> origin/<target>..<rebased-head>` and compare each MR file's diff before and after. Flag every difference beyond the port log: an MR hunk lost or applied at the wrong spot, duplicated code, an upstream line the rebase reverted, a leftover conflict marker.

3. **Upstream additions.** List what upstream added since the old base: columns and migrations, form and schema fields, enum values, event reasons, feature flags, translations, export formats. Check each against the places the MR enumerates fields explicitly (field lists, exhaustive maps, read models, scopes, fixtures) and against how upstream's own code handled it.

4. **Ported fixes.** Compare each port in the log with upstream's original behaviour: status codes and their order, audit and history rows, feature-flag gating, side effects and their ordering. Name the ports no test pins.
