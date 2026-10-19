---
name: glab-diffnote
description: Post GitLab MR discussion threads anchored to diff lines (DiffNotes) via glab api. Use when commenting on specific lines of an MR diff, or when a posted note came back as DiscussionNote instead of DiffNote.
argument-hint: "[<mr-iid>] [<file>:<line> ...]"
---

# glab DiffNotes

Current glab rejects a bracketed field name such as `-f position[position_type]=text` in a JSON request body; older glab sends it as a flat literal key, which GitLab ignores, silently creating a position-less `DiscussionNote`. Either way, send the position as nested JSON via `--input`.

## Steps

1. Get the MR's `diff_refs` (`base_sha`, `start_sha`, `head_sha`) from `glab api "projects/:id/merge_requests/<iid>"`. Confirm `head_sha` matches the commit your line numbers came from.
2. Anchor each comment to a line that exists in the diff (`git diff <base_sha> <head_sha> -- <file>`):
   - an added (`+`) line takes `new_line` only
   - a removed (`-`) line takes `old_line` only
   - an unchanged context line inside a hunk takes both `old_line` and `new_line`
   - an unchanged line outside every hunk also takes both `old_line` and `new_line`, which differ by the net count of lines the hunks above it add; GitLab unfolds the diff to show it
3. Write the JSON body to a scratch file outside the repo with the Write tool, so the checkout stays clean, then POST it with `--input`. Never assemble the JSON inline in a shell command. Review prose routinely contains apostrophes, and inside a single-quoted shell string an odd count kills the command while an even count silently mangles the note via word-splitting and glob expansion.

   `/tmp/payload.json`:

   ```json
   {
     "body": "…",
     "position": {
       "position_type": "text",
       "base_sha": "…", "start_sha": "…", "head_sha": "…",
       "old_path": "path/to/file", "new_path": "path/to/file",
       "new_line": 42
     }
   }
   ```

   ```bash
   glab api "projects/:id/merge_requests/<iid>/discussions" -X POST -H "Content-Type: application/json" --input /tmp/payload.json
   ```

   `body` must be a valid JSON string: `\n` for line breaks (a raw newline inside the string is invalid JSON), `\"` for double quotes, `\\` for backslashes, especially when quoting code from the diff. `old_path` is required even for new files (same as `new_path` unless renamed).

4. Verify every response: `notes[0].type` must be `"DiffNote"`. `"DiscussionNote"` means GitLab silently dropped the position; delete the note (`DELETE …/discussions/<discussion_id>/notes/<note_id>`) and fix the payload before reposting. A 400 mentioning `line_code` means the anchor line is not in the diff; reclassify it per step 2. A 400 about parsing or invalid JSON means the payload file is malformed, almost always an unescaped newline, quote, or backslash in `body`.
