---
name: glab-diffnote
description: Post GitLab MR discussion threads anchored to diff lines (DiffNotes) via glab api. Use when commenting on specific lines of an MR diff, creating positioned review threads, or when a posted note came back as DiscussionNote instead of DiffNote.
---

# glab DiffNotes

`glab api -f position[position_type]=text` sends a flat literal key; GitLab ignores it and silently creates a position-less `DiscussionNote`. Send the position as nested JSON via `--input -`.

## Steps

1. Get the MR's `diff_refs`: `glab api "projects/:id/merge_requests/<iid>"` → `base_sha`, `start_sha`, `head_sha`. Confirm `head_sha` matches the commit your line numbers came from.
2. Anchor each comment to a line that exists in the diff (`git diff <base_sha> <head_sha> -- <file>`):
   - added (`+`) line → `new_line` only
   - unchanged context line inside a hunk → both `old_line` and `new_line`
   - line outside every hunk → cannot host a DiffNote; anchor on the nearest changed line and note the shift in the body
3. POST a JSON body:

   ```bash
   printf '%s' '{
     "body": "…",
     "position": {
       "position_type": "text",
       "base_sha": "…", "start_sha": "…", "head_sha": "…",
       "old_path": "path/to/file", "new_path": "path/to/file",
       "new_line": 42
     }
   }' | glab api "projects/:id/merge_requests/<iid>/discussions" -X POST -H "Content-Type: application/json" --input -
   ```

   `old_path` is required even for new files (same as `new_path` unless renamed).

4. Verify every response: `notes[0].type` must be `"DiffNote"`. `"DiscussionNote"` means the position was silently dropped — delete the note (`DELETE …/discussions/<discussion_id>/notes/<note_id>`) and fix the payload before reposting. A 400 mentioning `line_code` means the anchor line is not in the diff — reclassify it per step 2.
