export const meta = {
  name: 'merge-ready',
  description: 'Repeat the adversarial code review over a scope, re-scouting the finders each round, until a round fixes nothing medium or higher that changes production behaviour and fewer than half its finders reported a medium-or-higher fix; then simplify the same scope',
  phases: [
    { title: 'Prepare', detail: 'Sonnet runs the commands listing the files in scope, the untracked files and the dirty paths at launch, unless args carry them', model: 'sonnet' },
    { title: 'Scout', detail: 'the session model (or args.model) at medium effort designs the finder dimensions afresh for the round' },
    { title: 'Review', detail: 'the adversarial-review workflow (review.mjs) over the round\'s dimensions' },
    { title: 'Triage', detail: 'Opus classifies each fixed medium-or-higher finding by the kinds of change in its hunks; a production kind means another round; runs beside the next round when the finders already justify one, beside the next scout otherwise', model: 'opus' },
    { title: 'Simplify', detail: 'the simplify-converge workflow (simplify.mjs) over the same scope, which computes its own file lists' },
    { title: 'Commit', detail: 'Sonnet commits what simplify left in the tree, leaving the user\'s uncommitted work, uncommitted review fixes and any simplify change sharing a file with them', model: 'sonnet' },
  ],
}

// Never resume a dead run with resumeFromRunId: each round's review.mjs call
// misses the cache partway through (see there) and re-runs live against a tree
// that already holds the fixes, so the loop reports `converged` on a round
// that fixed nothing. Relaunch instead.
const SCOPES = ['uncommitted', 'branch', 'unpushed', 'codebase']
// Fixes that can justify another round, two ways. A medium-or-higher fix whose
// hunks change what shipped code does gives fresh finders new behaviour to
// attack. And when at least half the finders reported a medium-or-higher fix,
// production or not, their attention went to the issues they found, so what
// they did not reach is still there. A low or nit fix (copy, a comment, dead
// code, a typo) counts for neither.
const COUNTED = ['medium', 'high', 'critical']
// Backstop only: the loop ends on its own once a round fixes too little to
// justify another. Each round spends a few dozen agents and the simplify
// phase spends more, all against the harness's 1000-agent lifetime cap.
const MAX_ROUNDS = 25

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('args.root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('args.base: the commit bounding the diff is required for every scope except codebase')
}
for (const key of ['reviewScript', 'simplifyScript']) {
  if (typeof input[key] !== 'string' || !input[key].startsWith('/')) {
    throw new Error(`args.${key}: absolute path to the script is required`)
  }
}
if (typeof input.context !== 'string' || !input.context.trim()) {
  throw new Error('args.context: a string describing the project (stack, agent docs to quote, commit convention) is required')
}
if (!Array.isArray(input.pruneExts) || input.pruneExts.length === 0) {
  throw new Error('args.pruneExts: non-empty string[] of comment-carrying source extensions is required, e.g. [".ts", ".js", ".svelte"]')
}
for (const key of ['checks', 'checkCmd', 'excludePattern', 'model', 'intent']) {
  if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
    throw new Error(`args.${key}: a non-empty string when given; omit it otherwise`)
  }
}
// A short diff-bounded scope's session passes the three lists, which cost it
// less than the copy agents; a codebase or long scope omits them.
const LIST_KEYS = ['files', 'untracked', 'dirtyAtLaunch']
const listsGiven = LIST_KEYS.filter((key) => input[key] !== undefined)
if (listsGiven.length && (listsGiven.length < LIST_KEYS.length
  || LIST_KEYS.some((key) => !Array.isArray(input[key]) || input[key].some((p) => typeof p !== 'string')))) {
  throw new Error('args.files, args.untracked and args.dirtyAtLaunch: pass all three as string[] or omit all three to have the workflow list them')
}
if (input.scope === 'codebase'
  ? input.loopStart !== undefined
  : typeof input.loopStart !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.loopStart)) {
  throw new Error('args.loopStart: the hex commit the loop starts from (HEAD at launch, or the start of a dead earlier run) is required for a scope with a base; omit it for codebase')
}
if (input.excludePattern && input.excludePattern.includes("'")) {
  throw new Error('args.excludePattern: the pattern is embedded in single quotes in a shell command and may not contain one')
}

const ROOT = input.root
const BASE = input.base || null
const SCOPE = input.scope
const CHECKS = input.checks ? input.checks.trim() : null
const CHECK_CMD = input.checkCmd ? input.checkCmd.trim() : null
// The author's note on what the diff deliberately does, when the user gave one;
// the agents read the author's commit messages themselves, up to loopStart.
const INTENT_NOTE = input.intent ? input.intent.trim() : null
// The model argument replaces the session model wherever that is the default: the scout
// here, the review implementers, the simplify appliers. Every other agent keeps its model.
const MODEL = input.model ? input.model.trim() : undefined

const SCOUT_OPTS = { ...(MODEL ? { model: MODEL } : {}), effort: 'medium' }
const TRIAGE_OPTS = { model: 'opus', effort: 'medium' }

// ---------- shared prompt fragments ----------

const SCOPE_LABEL = {
  uncommitted: 'the uncommitted changes',
  branch: 'the branch diff',
  unpushed: 'the unpushed work (unpushed commits plus uncommitted changes)',
  codebase: 'the entire codebase',
}

const SCOPE_TEXT = SCOPE === 'codebase'
  ? `Review scope: ${SCOPE_LABEL.codebase}, every tracked file plus untracked files. There is no base commit.`
  : `Review scope: ${SCOPE_LABEL[SCOPE]}, i.e. the working tree against base commit ${BASE}, plus untracked files.`

const CONTEXT = `Repository: ${ROOT}.
${input.context.trim()}
${SCOPE_TEXT}`

const READ_ONLY = `You are READ-ONLY with respect to the repository: do not edit, create or delete files under ${ROOT}, and run no git command that changes state (no checkout, restore, stash, commit, reset, clean). Scratch files go in /tmp.`

// Where the author's commits end and the loop's begin: HEAD at launch, or the
// commit a dead earlier run started from, so its fixes read as the loop's too.
const LOOP_START = input.loopStart || null

// The vocabulary the triage judges each fix's hunks in. `production` marks the
// kinds that change what shipped code does at runtime.
const CHANGE_KINDS = {
  logic: { production: true, text: 'a change to what shipped code does: application logic, data handling, queries, API handlers, UI behaviour; a helper local to the file it fixes is part of it; also adding, restoring, removing or renaming a translation key, asset or config entry that shipped code references, since what the code resolves at runtime changes' },
  config: { production: true, text: 'configuration the running product reads' },
  robustness: { production: true, text: 'a small guard or fallback with no user-visible effect today' },
  instructions: { production: true, text: 'a prompt, tool description, skill or agent instructions the product loads' },
  rename: { production: false, text: 'a symbol renamed with every consumer updated and nothing else changed' },
  'dead-code': { production: false, text: 'unreachable or unused code removed' },
  types: { production: false, text: 'type annotations with no runtime effect' },
  format: { production: false, text: 'formatting only' },
  comment: { production: false, text: 'comments and docstrings' },
  docs: { production: false, text: 'docs and agent docs' },
  copy: { production: false, text: 'rewording user-facing copy, error message text or translations whose keys already exist and are already referenced' },
  'log-text': { production: false, text: 'log message text' },
  test: { production: false, text: 'tests, fixtures and test helpers, added or updated' },
  'ci-build': { production: false, text: 'existing CI or build configuration' },
}

// ---------- schemas ----------

const DIMENSIONS_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short slug, unique among the dimensions.' },
          title: { type: 'string', description: 'One line naming the slice.' },
          focus: { type: 'string', description: 'A paragraph naming the specific things to attack in these files.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths exactly as listed in the prompt, or a directory ending in / for every file in scope under it.' },
          production: { type: 'boolean', description: 'True when any of its files holds code or configuration the running product executes or reads; false only when every one is docs, comments, rewordings of user-facing copy and translations, tests and fixtures, or CI and build configuration. A doc the product loads as instructions (a prompt, a skill, agent instructions) is production, and so is a translation or config file whose keys the diff adds, removes or renames, since shipped code resolves them at runtime.' },
        },
        required: ['key', 'title', 'focus', 'files', 'production'],
      },
    },
  },
  required: ['dimensions'],
}

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          kinds: { type: 'array', items: { type: 'string', enum: Object.keys(CHANGE_KINDS) }, description: 'Every kind of change the fix\'s hunks contain, by key from the list in the prompt.' },
          reason: { type: 'string', description: 'The hunk each production kind rests on, quoted; for a fix with no production kind, what its hunks are instead.' },
        },
        required: ['id', 'kinds', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    files: { type: 'array', items: { type: 'string' }, description: 'Exactly the paths the commit holds; empty when nothing was committed.' },
    reason: { type: 'string', description: 'When nothing was committed, why in one sentence; empty otherwise.' },
  },
  required: ['committed', 'commitSha', 'files', 'reason'],
}

// ---------- prompts ----------

// The scout reads the author's commit messages the way the review's agents
// do: per path, never the whole range, since a branch or the commits earlier
// rounds added can run to hundreds and would exhaust its context.
function scoutIntentText() {
  const parts = []
  if (INTENT_NOTE) parts.push(`The author's note on what the diff deliberately does, verbatim:\n<<<\n${INTENT_NOTE}\n>>>`)
  if (LOOP_START) {
    const end = LOOP_START.slice(0, 9)
    if (!LOOP_START.startsWith(BASE) && !BASE.startsWith(LOOP_START)) {
      parts.push(`The author's commits are ${BASE.slice(0, 9)}..${end}; their messages state what the diff deliberately does. Read the subjects with \`git log --format='%h %s' ${BASE}..${end}\` piped through \`head -n 100\`, and a path's messages with \`git log --format='--- %h%n%B' ${BASE}..${end} -- <paths>\`, never the whole range at once: it can hold hundreds of commits.`)
    }
    parts.push(`Every commit after ${end} was made by this review loop, not by the author; never list those.`)
  }
  if (!parts.length) return ''
  return `\nAuthor's intent for this diff:\n${parts.join('\n')}\nThe intent is the baseline the finders test the diff against: a removal it states is a decision they check for breakage, not a loss to audit. Cut the dimensions around what the diff introduced or changed and what that could break.\n`
}

// Past this many paths the scout reads file counts per directory instead of
// the paths, and cuts the dimensions by directory.
const SCOUT_PATHS_MAX = 200

// The files in scope per directory, two levels deep; a file at the root is
// listed by itself.
function directoryCounts(inScope) {
  const counts = new Map()
  for (const f of inScope) {
    const parts = f.split('/')
    const key = parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length > 1 ? `${parts[0]}/` : f
    counts.set(key, (counts.get(key) || 0) + 1)
  }
  return [...counts].map(([k, n]) => (k.endsWith('/') ? `- ${k} (${n} file${n === 1 ? '' : 's'})` : `- ${k}`)).join('\n')
}

// The scout is told nothing about earlier rounds: no round number, no earlier
// split, no list of what the fixes touched. Each round's cut is designed from
// the scope alone, the way a cleared conversation would design it.
function scoutPrompt(inScope, untracked) {
  const byDir = inScope.length > SCOUT_PATHS_MAX
  const list = byDir
    ? directoryCounts(inScope)
    : inScope.map((f) => `- ${f}${untracked.has(f) ? ' (untracked: no diff against the base, read whole)' : ''}`).join('\n')
  const listing = SCOPE === 'codebase'
    ? '`git ls-files -co --exclude-standard -- <dir>`'
    : `\`git diff --name-only ${BASE} -- <dir>\` plus \`git ls-files -o --exclude-standard -- <dir>\``
  const sizes = SCOPE === 'codebase'
    ? 'See sizes with `wc -l` on the paths.'
    : `See sizes with \`git diff --stat ${BASE}\`.`
  return `${CONTEXT}

${READ_ONLY}
${scoutIntentText()}
You are the SCOUT of an adversarial code review. Design the finder dimensions from the SHAPE of the scope, not its content: which files are in it and how large their change is, which subsystems and layers they belong to, and what you know of the repository (read its agent docs and directory layout as needed; the finders read the hunks themselves).

${byDir ? `Files in scope (${inScope.length}), counted per directory; list a directory's files with ${listing} when you need to split it:` : `Files in scope (${inScope.length}):`}
${list}
${sizes}

One finder runs per dimension. A dimension is a slice a single reviewer can hold in context and attack from one angle: a subsystem, a layer, or a cross-cutting concern such as authorization, i18n and docs, or tests and CI. Every file in scope belongs to at least one dimension; a file may appear in several when two angles both need it. A \`files\` entry ending in / stands for every file in scope under that directory: use one wherever a dimension takes a whole directory rather than spelling out its paths. \`focus\` is a paragraph naming the specific things to attack in those files: the mechanisms the diff introduced, the invariants it could break, the callers that depend on it. \`production\` picks the finder's model: a dimension holding no production code gets a cheaper one, so keep docs, tests and CI in dimensions of their own when the scope has enough of them, and mark a dimension production whenever in doubt. Past runs used five to nine dimensions for branches of forty to a hundred changed files; a small diff may need two. Use the paths and directories exactly as the scope names them.`
}

function fixLocation(f) {
  if (f.commitSha) return `committed as ${f.commitSha} (inspect with \`git show ${f.commitSha}\`)`
  return `left uncommitted in the working tree, files ${(f.files || []).join(', ') || '(unreported)'}`
}

function triagePrompt(round, candidates, findings) {
  const kindList = Object.keys(CHANGE_KINDS).map((k) => `- ${k}${CHANGE_KINDS[k].production ? ' (production)' : ''}: ${CHANGE_KINDS[k].text}`).join('\n')
  const blocks = candidates.map((c) => {
    const fixer = c.outcome === 'covered' && c.coveredBy != null ? findings.find((f) => f.id === c.coveredBy) : null
    const fix = fixer || c
    const via = fixer ? `\nFixed by the change for finding #${fixer.id} "${fixer.title}", which covers it.` : ''
    const hunks = fix.hunks && fix.hunks.trim() ? `\nHunks:\n${fix.hunks.trim()}` : ''
    return `Finding #${c.id} [${c.severity}] ${c.title}\nLocation: ${c.file}:${c.line}${via}\nFix: ${fixLocation(fix)}${hunks}`
  }).join('\n\n')
  return `Repository: ${ROOT}.

${READ_ONLY}

You are the TRIAGE agent of a looping adversarial code review. Round ${round} just fixed the medium, high and critical findings below. For each one, classify its fix by the kinds of change its hunks contain, from this list. The kinds marked production change what shipped code does at runtime; the others do not:
${kindList}

A fix carries every kind its hunks contain: one that changed a comment and a query is comment and logic. Judge a hunk by what it changes at runtime, not by the file type it sits in: when the finding describes a defect a user of the running product sees or hits, and the fix removes it, the fix carries a production kind whatever its hunks look like. Read each fix's hunks (from its commit, or pasted below for a fix left uncommitted), list a production kind only when a hunk changes what shipped code does, and quote that hunk in the reason. One verdict per finding id.

${blocks}`
}

// ---------- the launch state, computed here ----------

// When the args omit the lists they are read here, so a scope of thousands of
// files never passes through the launching session's context. Nothing but this
// loop's implementers writes to the tree between rounds (a cleanup that cannot
// restore it stops the loop), so every later round's state is this one plus
// what the fixes so far touched.
const GIT = 'git -c core.quotePath=false'
const PREPARE_OPTS = { model: 'sonnet', effort: 'low' }
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`

// --no-renames lists both sides of a rename.
const PREPARE_SECTIONS = [
  { name: 'files', cmd: SCOPE === 'codebase' ? `${GIT} ls-files` : `${GIT} diff --name-only ${BASE}` },
  { name: 'untracked', cmd: `${GIT} ls-files -o --exclude-standard` },
  { name: 'dirty', cmd: `{ ${GIT} diff --name-only --no-renames HEAD; ${GIT} ls-files -o --exclude-standard; } || :` },
]

// Simplify leaves its edits in the tree. Nothing else writes to it after the
// last round, so whatever is dirty there and outside the held paths is
// simplify's own, and goes into one commit like a review fix would.
const COMMIT_OPTS = { model: 'sonnet', effort: 'low' }

function commitPrompt(held, summary) {
  const changes = Object.entries(summary || {})
    .flatMap(([group, list]) => list.map((c) => `- ${group}: ${c.description}`))
  return `${CONTEXT}

The simplify workflow has just edited this repository and left its changes uncommitted. Commit them.

Run \`${GIT} -C ${shellQuote(ROOT)} status --porcelain --untracked-files=all\`. ${held.length
    ? `These paths are HELD: the user's uncommitted work at launch, a review fix that had to stay uncommitted, or a simplify change sharing a file with one of those. Never stage, commit, checkout, restore, stash or otherwise touch them:\n${held.map((p) => `- ${p}`).join('\n')}\n\nEvery other path the status lists`
    : 'Every path it lists'} is simplify's: stage exactly those paths with \`git add -A -- <paths>\` (so a deletion is staged too), and nothing else. Then \`git commit\` with a message in the project's commit convention (from the context above; default \`type(scope): subject\`), with no attribution lines or trailers. The subject says the code was simplified; the body may list the changes:
${changes.length ? changes.join('\n') : '- (no change was recorded; comments may have been pruned or check failures repaired)'}

Report committed=true, the sha and exactly the committed paths. When no path outside the held ones is dirty, commit nothing and report committed=false with the reason. Finish with \`git status --porcelain\` and make sure no path of the commit remains dirty.`
}

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string', description: 'The command\'s output, verbatim.' },
    declined: { type: 'string', description: 'Only when you did not run the command: why, in one sentence. Leave output empty then.' },
  },
  required: ['output'],
}

// A cheap agent sorting several outputs into several fields once returned an
// empty list its own command had just printed paths for, so the agent copies
// one block of output and the script splits it on marker lines. The harness
// swaps a Bash result over about 30 KB for a pointer to a file, which the
// agent pages through and reassembles by hand, losing lines; so the output is
// copied in parts that each fit one Bash result, each checked against its
// cksum. Every part re-runs the same read-only commands in the repository:
// agents asked to relay an opaque temp file refused it as a smuggled signal.
const MARKER = '::section::'
const CHUNK_BYTES = 20000

function copyBody(sections) {
  const body = sections.map((sec) => `echo '${MARKER} ${sec.name}'\n${sec.cmd}`).join('\n')
  return `cd ${shellQuote(ROOT)} && (
${body}
echo '${MARKER} end'
)`
}

function copyIntro(what) {
  return `You are a helper of the merge-ready workflow the user launched on the repository ${ROOT}. The workflow's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state; it changes nothing. The \`${MARKER}\` lines are headers the script splits the output on.`
}

const COPY_RULE = 'Return its entire output verbatim as `output`: every line, in order, nothing added, removed or reworded. The script checks the copy against a checksum. There is nothing to review in it, so you need not open any file.'

function copyPrompt(sections, what) {
  const ranges = `awk -v max=${CHUNK_BYTES} '{ l = length($0) + 1; if (n && b + l > max) { print s, NR - 1; n = 0; b = 0 } if (!n) s = NR; n++; b += l } END { if (n) print s, NR }' "$f"`
  return `${copyIntro(what)} A Bash result over about 30 KB comes back cut, so the command numbers the output's lines into parts of at most ${CHUNK_BYTES} bytes, prints one \`::part::\` line per part (first line, last line, cksum), then the first part itself; other helpers fetch the remaining parts.

Run exactly this shell command via Bash, unmodified, as a single call:

f=$(mktemp) && ${copyBody(sections)} > "$f" && r=$(${ranges}) && echo "$r" | while read -r s e; do echo "::part:: $s $e $(sed -n "$s,\${e}p" "$f" | cksum)"; done && sed -n "$(echo "$r" | head -n 1 | tr ' ' ',')p" "$f"; rm -f "$f"

${COPY_RULE}`
}

function chunkPrompt(sections, what, chunk, index, count) {
  return `${copyIntro(what)} A Bash result over about 30 KB comes back cut, so the output is fetched in ${count} parts; this is part ${index}, lines ${chunk.start} to ${chunk.end}, which the \`sed\` at the end keeps.

Run exactly this shell command via Bash, unmodified, as a single call:

${copyBody(sections)} | sed -n '${chunk.start},${chunk.end}p'

${COPY_RULE}`
}

// The first copy carries one line per part with its line range and cksum,
// then the first part itself.
function parseHead(output) {
  const lines = String(output || '').split('\n').map((l) => l.replace(/\r$/, ''))
  const chunks = []
  let i = 0
  for (; i < lines.length; i++) {
    const c = /^::part:: (\d+) (\d+) (\d+) (\d+)\s*$/.exec(lines[i])
    if (c) chunks.push({ start: +c[1], end: +c[2], crc: +c[3], bytes: +c[4] })
    else if (chunks.length) break
  }
  if (!chunks.length || chunks.some((c, k) => c.start !== (k ? chunks[k - 1].end + 1 : 1) || c.end < c.start)) return null
  const first = verifyChunk(lines.slice(i).join('\n'), chunks[0])
  return first ? { chunks, first } : null
}

// A chunk's lines, or null unless they are byte for byte the ones sed printed.
// A missing trailing blank line is restored, and the copy is tried again
// without the code fence lines an agent may wrap it in.
function verifyChunk(text, chunk) {
  const lines = String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
  const fence = (l) => /^\s*```\S*\s*$/.test(l)
  const bare = lines.slice(fence(lines[0] || '') ? 1 : 0)
  while (bare.length && bare[bare.length - 1] === '') bare.pop()
  if (bare.length && fence(bare[bare.length - 1])) bare.pop()
  const n = chunk.end - chunk.start + 1
  for (const candidate of [lines, bare]) {
    const c = candidate.slice()
    while (c.length > n && c[c.length - 1] === '') c.pop()
    while (c.length < n) c.push('')
    if (c.length !== n) continue
    const bytes = utf8(c.map((l) => `${l}\n`).join(''))
    if (bytes.length === chunk.bytes && cksum(bytes) === chunk.crc) return c
  }
  return null
}

// POSIX cksum: CRC-32 with polynomial 0x04C11DB7, MSB first, over the bytes
// and then the byte count, inverted.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n << 24
  for (let k = 0; k < 8; k++) c = c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1
  return c >>> 0
})

function cksum(bytes) {
  let crc = 0
  const step = (b) => { crc = ((crc << 8) ^ CRC_TABLE[((crc >>> 24) ^ b) & 0xff]) >>> 0 }
  for (const b of bytes) step(b)
  for (let n = bytes.length; n > 0; n = Math.floor(n / 256)) step(n & 0xff)
  return ~crc >>> 0
}

function utf8(s) {
  const out = []
  for (const ch of s) {
    const c = ch.codePointAt(0)
    if (c < 0x80) out.push(c)
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63))
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
    else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63))
  }
  return out
}

// Null when the output is not one complete run of the command: a missing
// section or end marker means lines were lost.
function parseCopy(lines, sections) {
  const raw = {}
  let current = null
  for (const line of lines) {
    const marker = new RegExp(`^\\s*${MARKER} (\\w+)\\s*$`).exec(line)
    if (marker) {
      current = marker[1]
      raw[current] = []
      continue
    }
    if (current) raw[current].push(line)
  }
  if (!raw.end) return null
  const value = {}
  for (const sec of sections) {
    if (!raw[sec.name]) return null
    value[sec.name] = [...new Set(raw[sec.name].map((l) => l.trim()).filter((l) => l && !l.startsWith('```')))].sort()
  }
  return value
}

// The first copy runs the command and lays out the parts; the parts past the
// first are copied in parallel. A copy that fails its check, or an agent that
// declines, is retried once; the second failure ends the step.
async function runCopy(sections, what, label, phaseName, opts) {
  const head = await copyAttempts(copyPrompt(sections, what), label, phaseName, opts, parseHead)
  if (!head.value) return head
  const { chunks, first } = head.value
  const rest = await parallel(chunks.slice(1).map((chunk, k) => () =>
    copyAttempts(chunkPrompt(sections, what, chunk, k + 2, chunks.length), `${label} part ${k + 2}`, phaseName, opts, (out) => verifyChunk(out, chunk))))
  const failed = rest.findIndex((r) => !r || !r.value)
  if (failed >= 0) return { value: null, error: rest[failed] ? rest[failed].error : `the ${label} part ${failed + 2} copy threw` }
  const value = parseCopy([...first, ...rest.flatMap((r) => r.value)], sections)
  return value ? { value, error: null } : { value: null, error: `the ${label} output lacks a section marker` }
}

async function copyAttempts(prompt, label, phaseName, opts, parse) {
  const failures = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run(prompt, { label: `${label}.${attempt}`, phase: phaseName, schema: COPY_SCHEMA, ...opts })
    const declined = r && r.declined && r.declined.trim()
    const value = r && !declined ? parse(r.output) : null
    if (value) return { value, error: null }
    failures.push(!r ? 'died' : declined ? `declined to run the command (${declined})` : 'returned an output that failed its check')
  }
  return { value: null, error: `the ${label} agent ${failures[0] === failures[1] ? `${failures[0]} twice` : `${failures[0]}, then ${failures[1]}`}` }
}

// ---------- helpers ----------

// agent() resolves to null for a skipped or dead agent and throws once a
// user-set token budget is exhausted; both end the step the same way.
async function run(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch {
    return null
  }
}

async function runChild(scriptPath, childArgs, what) {
  try {
    const result = await workflow({ scriptPath }, childArgs)
    if (!result) return { result: null, error: `the ${what} returned nothing` }
    return { result, error: null }
  } catch (err) {
    return { result: null, error: `the ${what} threw: ${err && err.message ? err.message : String(err)}` }
  }
}

// The scout's split is advice; coverage is not. Files it left out get a
// catch-all finder rather than silently leaving the round's scope. A directory
// entry stays one entry for the finder, and counts for every file under it.
function normalizeDimensions(raw, inScope) {
  const scope = new Set(inScope)
  const expand = (entry) => (entry.endsWith('/') ? inScope.filter((f) => f.startsWith(entry)) : scope.has(entry) ? [entry] : [])
  const keys = new Set()
  const dimensions = []
  for (const d of raw || []) {
    if (!d || !d.title || !d.focus || !Array.isArray(d.files)) continue
    const files = [...new Set(d.files.filter((f) => typeof f === 'string' && expand(f).length))]
    if (files.length === 0) continue
    let key = String(d.key || '').trim().replace(/\s+/g, '-') || `dim-${dimensions.length + 1}`
    const stem = key
    for (let n = 2; keys.has(key); n++) key = `${stem}-${n}`
    keys.add(key)
    dimensions.push({ key, title: d.title, focus: d.focus, files, production: d.production !== false })
  }
  const covered = new Set(dimensions.flatMap((d) => d.files.flatMap(expand)))
  const missing = inScope.filter((f) => !covered.has(f))
  if (missing.length) {
    let key = 'unassigned'
    for (let n = 2; keys.has(key); n++) key = `unassigned-${n}`
    dimensions.push({
      key,
      title: 'Files the scout assigned to no dimension',
      focus: 'These files are in the review scope but the scout left them out of every dimension. Read their hunks (untracked files whole), work out what each change introduces, and attack it from the angle the change itself suggests: the invariants it could break, the callers that depend on it, the contradictions with docs or copy.',
      files: missing,
      production: true,
    })
  }
  return { dimensions, missing }
}

// ---------- the loop ----------

const rounds = []
const allFixes = []
const allUncommittedFixFiles = new Set()
const allPossiblyDirty = new Set()
let stopReason = null
let stopDetail = null
const excludedKindsTable = {}

log(`scope ${SCOPE}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, up to ${MAX_ROUNDS} review round(s), scout and implementers on ${MODEL || 'the session model'}, simplify afterwards`)

phase('Prepare')
const sortedPaths = (paths) => [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort()
const { value: launch, error: prepareError } = listsGiven.length
  ? { value: { files: sortedPaths(input.files), untracked: sortedPaths(input.untracked), dirty: sortedPaths(input.dirtyAtLaunch) }, error: null }
  : await runCopy(PREPARE_SECTIONS, 'the file lists the review loop starts from', 'prepare', 'Prepare', PREPARE_OPTS)
if (!launch) {
  stopReason = 'prepare-failed'
  stopDetail = prepareError
  log(`the launch state could not be read: ${prepareError}`)
}

// A round's scout reads the scope as the fixes so far left it, so the next
// round's scout can start as soon as a review returns.
async function scoutRound(round) {
  const untracked = launch.untracked
  const inScope = [...new Set([...launch.files, ...untracked, ...allFixes.flatMap((f) => f.files || [])])].sort()
  if (inScope.length === 0) return { stop: 'scope-empty', detail: `round ${round} found nothing in scope` }
  const scout = await run(scoutPrompt(inScope, new Set(untracked)), { label: `scout @${round}`, phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
  if (!scout) return { stop: 'agent-failed', detail: `the scout of round ${round} died` }
  return { stop: null, ...normalizeDimensions(scout.dimensions, inScope) }
}

async function runTriage(round, candidates, findings) {
  const triage = { failed: false, productionIds: [] }
  if (!candidates.length) return triage
  const t = await run(triagePrompt(round, candidates, findings), { label: `triage @${round}`, phase: 'Triage', schema: TRIAGE_SCHEMA, ...TRIAGE_OPTS })
  if (!t) {
    triage.failed = true
    triage.productionIds = candidates.map((f) => f.id)
    log(`round ${round}: the triage agent died; every medium-or-higher fix is assumed to have changed production behaviour`)
  } else {
    const isProduction = (v) => v.kinds.some((k) => CHANGE_KINDS[k] && CHANGE_KINDS[k].production)
    triage.productionIds = t.verdicts
      .filter((v) => candidates.some((f) => f.id === v.id) && isProduction(v))
      .map((v) => v.id)
  }
  return triage
}

// The triage only reads (a committed fix by its sha, an uncommitted one from
// its pasted hunks), so it never holds up the loop when the finders alone
// already justify another round: it runs beside the next round and fills in
// its entry for the report. When only the triage can decide, the next round's
// scout runs beside it, and is discarded when the loop converges.
const backgroundTriages = []
let nextScout = null

for (let round = 1; launch && round <= MAX_ROUNDS; round++) {
  phase('Scout')
  const scouted = await (nextScout || scoutRound(round))
  nextScout = null
  if (scouted.stop) {
    stopReason = scouted.stop
    stopDetail = scouted.detail
    break
  }
  const { dimensions, missing } = scouted
  const dirtyAtLaunch = [...new Set([...launch.dirty, ...allUncommittedFixFiles])].sort()
  const untracked = launch.untracked
  if (missing.length) log(`round ${round}: the scout left ${missing.length} file(s) out of every dimension; a catch-all finder takes them`)

  phase('Review')
  log(`round ${round}: ${dimensions.length} finder(s): ${dimensions.map((d) => d.key).join(', ')}${dirtyAtLaunch.length ? `; ${dirtyAtLaunch.length} path(s) dirty` : '; tree clean'}`)
  const reviewArgs = {
    scope: SCOPE,
    root: ROOT,
    dirtyAtLaunch,
    untracked,
    dimensions,
    context: input.context,
    loopFields: true,
  }
  if (BASE) reviewArgs.base = BASE
  if (CHECKS) reviewArgs.checks = CHECKS
  if (MODEL) reviewArgs.implementerModel = MODEL
  if (LOOP_START) reviewArgs.authorEnd = LOOP_START
  if (INTENT_NOTE) reviewArgs.intent = INTENT_NOTE
  const { result: review, error } = await runChild(input.reviewScript, reviewArgs, 'review workflow')

  const entry = { round, review, triage: null, decision: null }
  if (missing.length) entry.unassignedFiles = missing
  if (error) entry.error = error
  rounds.push(entry)
  if (!review) {
    stopReason = 'review-failed'
    stopDetail = `round ${round}: ${error}`
    break
  }

  for (const f of review.uncommittedFixFiles || []) allUncommittedFixFiles.add(f)
  for (const p of review.possiblyDirty || []) allPossiblyDirty.add(p)

  const findings = review.findings || []
  const fixed = findings.filter((f) => f.outcome === 'fixed')
  for (const f of fixed) allFixes.push({ round, id: f.id, files: f.files || [] })
  const covered = findings.filter((f) => f.outcome === 'covered')
  const resolved = fixed.length + covered.length
  // A covered finding was closed by its coverer's change, so that change is the
  // one triaged.
  const candidates = [...fixed, ...covered].filter((f) => COUNTED.includes(f.severity))
  // A finder that reported a resolved finding, first or as a duplicate the
  // dedup attached, spent its round on it.
  const finderKeys = new Set(dimensions.map((d) => d.key))
  const productiveFinders = new Set(
    candidates
      .flatMap((f) => [f.dimension, ...(f.alsoReportedBy || [])])
      .filter((k) => finderKeys.has(k)),
  )
  const counts = {
    finders: dimensions.length,
    finderFailures: (review.finderFailures || []).length,
    registered: findings.length,
    confirmed: findings.filter((f) => f.status === 'confirmed').length,
    fixed: fixed.length,
    covered: covered.length,
    resolvedMediumOrHigher: candidates.length,
    productiveFinders: productiveFinders.size,
  }

  const reasons = []
  if (productiveFinders.size * 2 >= dimensions.length) {
    reasons.push(`${productiveFinders.size} of ${dimensions.length} finder(s) reported a medium-or-higher issue that was fixed or covered (${[...productiveFinders].join(', ')})`)
  }
  if (counts.finderFailures) {
    reasons.push(`finder(s) ${review.finderFailures.join(', ')} failed, so their dimension was never reviewed`)
  }
  entry.decision = { counts, reasons }
  // The triage reads the findings as review.mjs returned them; the entry's
  // trimmed copy below is a separate object.
  const triaged = runTriage(round, candidates, findings).then((triage) => {
    entry.triage = triage
    if (triage.productionIds.length) {
      reasons.unshift(`${triage.productionIds.length} medium-or-higher fix(es) changed production behaviour (#${triage.productionIds.join(', #')})`)
    }
  })
  // The result lands in the launching session whole, every round of it, so
  // what the report never reads leaves once the loop and the triage have read
  // it: the hunks, the finder a finding came from, a committed fix's files (its
  // commit carries them), the fields the loop-wide notes report once for every
  // round, and the exclusion table every round repeats.
  Object.assign(excludedKindsTable, review.excludedKinds)
  entry.review = {
    finderFailures: review.finderFailures,
    findings: findings.map(({ hunks, dimension, ...f }) => {
      if (f.commitSha) delete f.files
      return f
    }),
  }

  if ((review.possiblyDirty || []).length > 0) {
    await triaged
    stopReason = 'possibly-dirty'
    stopDetail = `round ${round}: an implementer died and the cleanup could not restore ${review.possiblyDirty.join(', ')}`
    log(`round ${round}: stopping, the tree may hold partial hunks in protected paths`)
    break
  }
  if (reasons.length) {
    backgroundTriages.push(triaged)
    log(`round ${round}: ${resolved} issue(s) resolved by ${counts.finders} finder(s); another round because ${reasons.join('; ')}${candidates.length ? '; the triage runs beside it' : ''}`)
    continue
  }
  if (round < MAX_ROUNDS) nextScout = scoutRound(round + 1)
  await triaged
  if (reasons.length === 0) {
    stopReason = 'converged'
    log(`round ${round}: ${resolved} issue(s) resolved, ${counts.resolvedMediumOrHigher} of them medium or higher from ${counts.productiveFinders} of ${counts.finders} finder(s), none of those in production code; the review loop is done`)
    break
  }
  log(`round ${round}: ${resolved} issue(s) resolved by ${counts.finders} finder(s); another round because ${reasons.join('; ')}`)
}
if (!stopReason) {
  stopReason = 'max-rounds'
  stopDetail = `the last round still justified another and the ${MAX_ROUNDS}-round backstop ended the loop`
}

// ---------- simplify the same scope once the review loop is quiet ----------

let simplify
if (stopReason !== 'converged') {
  simplify = { ran: false, skipped: `review-loop-${stopReason}`, error: null, result: null }
  log(`simplify skipped: the review loop ended on ${stopReason}`)
} else {
  phase('Simplify')
  const simplifyArgs = { scope: SCOPE, root: ROOT, pruneExts: input.pruneExts }
  if (BASE) simplifyArgs.base = BASE
  if (CHECK_CMD) simplifyArgs.checkCmd = CHECK_CMD
  if (input.excludePattern) simplifyArgs.excludePattern = input.excludePattern.trim()
  if (MODEL) simplifyArgs.applyModel = MODEL
  const { result, error } = await runChild(input.simplifyScript, simplifyArgs, 'simplify workflow')
  if (!result) {
    simplify = { ran: false, skipped: 'simplify-failed', error, result: null }
    log(`simplify failed: ${error}`)
  } else if (result.skipped) {
    simplify = { ran: false, skipped: result.skipped, error: result.error, result: null }
    log(`simplify skipped: ${result.error || result.skipped}`)
  } else {
    simplify = { ran: true, skipped: null, error: null, result }
  }
}

// A simplify change touching a held file stays out of the commit, and so does
// every file it touched, since committing one half of a change would break the
// commit; a change sharing a file with it then stays out too, to a fixed point.
let simplifyCommit = null
if (simplify.ran) {
  phase('Commit')
  const protectedPaths = new Set([...launch.dirty, ...allUncommittedFixFiles, ...allPossiblyDirty])
  const held = new Set(protectedPaths)
  const changes = Object.values(simplify.result.summary || {}).flat()
  for (let grew = true; grew;) {
    grew = false
    for (const c of changes) {
      const files = c.files || []
      if (!files.some((f) => held.has(f)) || files.every((f) => held.has(f))) continue
      for (const f of files) held.add(f)
      grew = true
    }
  }
  const heldList = [...held].sort()
  const c = await run(commitPrompt(heldList, simplify.result.summary), { label: 'commit simplify', phase: 'Commit', schema: COMMIT_SCHEMA, ...COMMIT_OPTS })
  const keptOut = heldList.filter((f) => !protectedPaths.has(f))
  simplifyCommit = c
    ? { committed: c.committed === true, commitSha: c.committed ? c.commitSha : null, files: c.files || [], reason: c.reason || null, keptOut }
    : { committed: false, commitSha: null, files: [], reason: 'the commit agent died', keptOut }
  log(simplifyCommit.committed
    ? `simplify committed as ${simplifyCommit.commitSha} (${simplifyCommit.files.length} file(s))`
    : `simplify left uncommitted: ${simplifyCommit.reason}`)
}

// A discarded scout only reads, so it may finish beside the simplify phase.
await Promise.all([...backgroundTriages, nextScout])

log(`done: ${rounds.length} review round(s), stop reason ${stopReason}, ${allFixes.length} fix(es) in total, simplify ${simplify.ran ? 'ran' : `skipped (${simplify.skipped})`}`)

return {
  model: MODEL || null,
  checksConfigured: CHECKS !== null,
  excludedKinds: excludedKindsTable,
  stopReason,
  stopDetail,
  rounds,
  uncommittedFixFiles: [...allUncommittedFixFiles],
  possiblyDirty: [...allPossiblyDirty],
  simplify,
  simplifyCommit,
}
