# Reporting a review.mjs result

Each finding carries `status` (`confirmed`, `refuted`, `agent_failed`) and, once an implementer reached it, `outcome` (`fixed`, `covered`, `not_fixed`, `reverted`, `agent_failed`), plus only the fields named below for its category. `excludedKinds` maps each exclusion key a finding was refused under to its description.

Report every finding in seven categories, ordered by severity within each:
- fixed: committed as `commitSha`, or left uncommitted in the working tree when it is null, naming the `files` (a committed fix without them: the files its commit touched), plus the implementer's `notes`, when present, on what a fuller fix would need;
- covered: by its cluster lead's fix, naming it (`coveredBy`), or already closed in the tree when an implementer reached it (`coveredBy` null);
- confirmed but not auto-fixed, saying which excluded kind it was (`excludedKind`), in the words of `excludedKinds`, with the implementer's `plan`;
- fix attempted but reverted, with the check that could not pass (`reason`) and the `plan`;
- never attempted because an agent failed, naming the agent (`failedAt`);
- pre-existing and serious: refuted with `refuteGround` `pre-existing` at high or critical severity. The diff neither caused nor worsened these, and nothing fixed them: give each its location, `description` and `refuteReason`, and say it needs a fix of its own outside this diff;
- refuted, every other refutation, with the skeptic (`refutedBy`), the ground when `refuteGround` is present, and its `refuteReason`, the first sentence of its reason.

Number the findings continuously across the whole report so each can be quoted by its number. When `implementerModel` is not null, say which model applied the fixes. `alsoReportedBy`, present only when non-empty, lists the finders whose duplicate the dedup attached at intake; report them under the primary as "also reported by", without a number of their own. Then:
- `finderFailures` non-empty: state prominently that those dimensions were never reviewed, naming them, and make no claim that the scope was covered.
- `checksConfigured` false: state that no check command was found, so every fix was verified only by reading, and the user should run the project's checks before relying on the tree.
- `uncommittedFixFiles` non-empty: list them and say those fixes sit in the working tree next to the user's uncommitted work.
- `possiblyDirty` non-empty: state prominently that an implementer died and the cleanup could not restore these paths because they were protected, so they may hold partial hunks the user must inspect.
