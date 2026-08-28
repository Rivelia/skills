---
name: glab-upload
description: Upload screenshots/images to a GitLab project and embed them in MR descriptions or notes via the uploads API. Use when an MR needs screenshots, when embedding an image in a GitLab description or note, or when `glab api ... uploads` returns "file is invalid".
---

# glab uploads

`glab api -F "file=@shot.png"` sends the literal string, never the file — GitLab answers `{"error":"file is invalid"}`. Upload with curl using glab's token instead.

Run from inside the repo (glab resolves `:id` and the token from there):

```bash
TOKEN=$(glab auth status -t 2>&1 | grep -oP 'glpat-\S+')
API=$(glab api projects/:id | python3 -c "import sys,json; print(json.load(sys.stdin)['_links']['self'])")
curl -s -H "PRIVATE-TOKEN: $TOKEN" -F "file=@shot.png" "$API/uploads" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['markdown'])"
```

Prints `![shot](/uploads/<hash>/shot.png)` — paste verbatim into the MR description or a note. The path is project-relative: it only renders inside the same project. One curl per file; upload before `glab mr create`, then place each line under the template's Screenshots section with a bold one-line caption above it.

If the grep finds no `glpat-` token (keyring/OAuth auth), take the token from `$GITLAB_TOKEN`.
