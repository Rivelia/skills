---
name: glab-upload
description: Upload screenshots/images to a GitLab project and embed them in MR descriptions or notes via the uploads API. Use when embedding a screenshot or image in an MR description or note, or when `glab api ... uploads` returns "file is invalid".
---

# glab uploads

`glab api -F "file=@shot.png"` reads the file but sends its contents as a JSON string, so GitLab answers `{"error":"file is invalid"}`. The uploads endpoint needs multipart/form-data, which `--form` sends.

Run from inside the repo (glab resolves `:id` and auth from there):

```bash
glab api --method POST projects/:id/uploads --form "file=@shot.png" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['markdown'])"
```

Prints `![shot](/uploads/<hash>/shot.png)`; paste it verbatim into the MR description or a note. The path is project-relative and only renders inside the same project. One upload per file; upload before `glab mr create`, then place each line under the template's Screenshots section with a bold one-line caption above it.
