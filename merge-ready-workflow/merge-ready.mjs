export const meta = {
  name: 'merge-ready',
  description: 'Repeat the adversarial code review over a scope, re-scouting the finders each round, until a round fixes nothing medium or higher that changes production behaviour and fewer than half its finders reported a medium-or-higher fix; then simplify the same scope',
  phases: [
    { title: 'Scout', detail: 'Sonnet records the tree state and, in round 1, the author\'s commit log, then the session model (or args.model) at medium effort designs the finder dimensions afresh for the round' },
    { title: 'Review', detail: 'the adversarial-review workflow (review.mjs) over the round\'s dimensions' },
    { title: 'Triage', detail: 'Opus classifies each fixed medium-or-higher finding by the kinds of change in its hunks; a production kind means another round', model: 'opus' },
    { title: 'Prepare', detail: 'Sonnet computes the simplify inputs: file list, prune candidates, untracked baseline, tree hash', model: 'sonnet' },
    { title: 'Simplify', detail: 'the simplify-converge workflow (simplify.mjs) over the same scope' },
  ],
}

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
const DEFAULT_EXCLUDE = '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\\.min\\.|(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|go\\.sum)$|\\.(json|jsonl|csv|tsv|md|mdx|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm|so|dylib|dll|exe|bin)$'

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
if (input.loopStart !== undefined && (typeof input.loopStart !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.loopStart) || input.scope === 'codebase')) {
  throw new Error('args.loopStart: the hex commit a dead earlier run of this loop started from, only for a scope with a base; omit it otherwise')
}
if (input.excludePattern && input.excludePattern.includes("'")) {
  throw new Error('args.excludePattern: the pattern is embedded in single quotes in a shell command and may not contain one')
}

const ROOT = input.root
const BASE = input.base || null
const SCOPE = input.scope
const CHECKS = input.checks ? input.checks.trim() : null
const CHECK_CMD = input.checkCmd ? input.checkCmd.trim() : null
const EXCLUDE = input.excludePattern ? input.excludePattern.trim() : DEFAULT_EXCLUDE
// The author's note on what the diff deliberately does, when the user gave one;
// the branch's commit messages are collected by the first round's state agent.
const INTENT_NOTE = input.intent ? input.intent.trim() : null
// The model argument replaces the session model wherever that is the default: the scout
// here, the review implementers, the simplify appliers. Every other agent keeps its model.
const MODEL = input.model ? input.model.trim() : undefined
const PRUNE_EXTS = input.pruneExts.map((e) => (e.startsWith('.') ? e : `.${e}`))

const STATE_OPTS = { model: 'sonnet', effort: 'low' }
const SCOUT_OPTS = { ...(MODEL ? { model: MODEL } : {}), effort: 'medium' }
const TRIAGE_OPTS = { model: 'opus', effort: 'medium' }
const PREPARE_OPTS = { model: 'sonnet', effort: 'low' }
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

const GIT = 'git -c core.quotePath=false'
const LIST_TRACKED_CMD = SCOPE === 'codebase' ? `${GIT} ls-files` : `${GIT} diff --name-only ${BASE}`
// A relaunch after a dead run passes the commit that run started from, so the
// fixes it committed are set apart from the author's commits like this run's own.
const LOOP_START = input.loopStart || null

// ---------- schemas ----------

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string', description: 'The command\'s output, verbatim.' },
    declined: { type: 'string', description: 'Only when you did not run the command: why, in one sentence. Leave output empty then.' },
  },
  required: ['output'],
}

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
          files: { type: 'array', items: { type: 'string' }, description: 'Paths exactly as listed in the prompt.' },
        },
        required: ['key', 'title', 'focus', 'files'],
      },
    },
  },
  required: ['dimensions'],
}

// The triage answers in the change kinds the review script's result carries,
// the vocabulary its implementer reported in; the script reads production off
// the same table.
function triageSchema(changeKinds) {
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'integer' },
            kinds: { type: 'array', items: { type: 'string', enum: Object.keys(changeKinds) }, description: 'Every kind of change the fix\'s hunks contain, by key from the list in the prompt.' },
            reason: { type: 'string', description: 'The hunk each production kind rests on, quoted; for a fix with no production kind, what its hunks are instead.' },
          },
          required: ['id', 'kinds', 'reason'],
        },
      },
    },
    required: ['verdicts'],
  }
}

// ---------- prompts ----------

// The status is read NUL-separated because the plain porcelain format quotes
// any path with a space whatever core.quotePath says. The status columns are
// stripped in the shell, and a rename or copy entry is followed by its source
// path, so the section is a plain path list like the others.
const STATUS_PATHS_CMD = `${GIT} status --porcelain -z | while IFS= read -r -d '' e; do echo "\${e:3}"; case "\${e:0:2}" in *R*|*C*) IFS= read -r -d '' e; echo "$e";; esac; done`

// The author's commits end where the loop's begin: at loopStart on a relaunch,
// else at HEAD when round 1 reads the state. Round 1 copies their messages
// once, since no round changes them; every later round lists only the shas of
// the commits the loop added since, whose messages the intent never quotes.
const STATE_WHAT = BASE
  ? `the files dirty, untracked and changed against ${BASE.slice(0, 9)}, and the branch's commits, which the review round reads`
  : 'the files dirty, untracked and tracked, which the review round reads'
const PREPARE_WHAT = 'the file lists and tree hash the simplify pass starts from'

function stateSections(round, authorEnd) {
  const sections = [
    { name: 'dirtyAtLaunch', kind: 'list', cmd: STATUS_PATHS_CMD },
    { name: 'untracked', kind: 'list', cmd: `${GIT} ls-files -o --exclude-standard` },
    { name: 'tracked', kind: 'list', cmd: LIST_TRACKED_CMD },
  ]
  if (!BASE) return sections
  if (round === 1) {
    if (!authorEnd) sections.push({ name: 'head', kind: 'commit', cmd: `${GIT} rev-parse HEAD` })
    sections.push({ name: 'log', kind: 'text', cmd: `${GIT} log --format='--- %H%n%B' ${BASE}..${authorEnd || 'HEAD'}` })
  }
  if (authorEnd) sections.push({ name: 'loopCommits', kind: 'list', cmd: `${GIT} rev-list ${authorEnd}..HEAD` })
  return sections
}

// The state's log is a sequence of "--- <sha>" markers, each followed by
// that commit's message.
function parseLog(log) {
  const commits = []
  let current = null
  for (const line of String(log || '').split('\n')) {
    const m = /^--- ([0-9a-f]{40})\s*$/.exec(line)
    if (m) {
      current = { sha: m[1], lines: [] }
      commits.push(current)
      continue
    }
    if (current) current.lines.push(line)
  }
  return commits.map((c) => ({ sha: c.sha, message: c.lines.join('\n').trim() })).filter((c) => c.message)
}

// The intent every agent of the round reads: the user's note, then the
// author's commit messages verbatim, then the commits earlier rounds of this
// loop (or of the dead run it relaunches) made, set apart so a restore the
// review itself committed never reads as the author's decision.
function buildIntent(authorLog, loopCommits) {
  const authored = parseLog(authorLog)
  const parts = []
  if (INTENT_NOTE) parts.push(INTENT_NOTE)
  if (authored.length) parts.push(authored.map((c) => `--- ${c.sha.slice(0, 9)}\n${c.message}`).join('\n'))
  if (loopCommits && loopCommits.length) parts.push(`Commits ${loopCommits.map((sha) => sha.slice(0, 9)).join(', ')} were made by an earlier round of this review loop, not by the author; they carry none of the author's decisions.`)
  return parts.length ? parts.join('\n\n') : null
}

// The scout is told nothing about earlier rounds: no round number, no earlier
// split, no list of what the fixes touched. Each round's cut is designed from
// the scope alone, the way a cleared conversation would design it.
function scoutPrompt(state, inScope, intent) {
  const untracked = new Set(state.untracked)
  const list = inScope.map((f) => `- ${f}${untracked.has(f) ? ' (untracked: no diff against the base, read whole)' : ''}`).join('\n')
  const sizes = SCOPE === 'codebase'
    ? 'See sizes with `wc -l` on the paths.'
    : `See sizes with \`git diff --stat ${BASE}\`.`
  const intentText = intent
    ? `\nAuthor's intent for this diff, verbatim (commit messages, the author's note, or both):\n<<<\n${intent}\n>>>\nThe intent is the baseline the finders test the diff against: a removal it states is a decision they check for breakage, not a loss to audit. Cut the dimensions around what the diff introduced or changed and what that could break.\n`
    : ''
  return `${CONTEXT}

${READ_ONLY}
${intentText}
You are the SCOUT of an adversarial code review. Design the finder dimensions from the SHAPE of the scope, not its content: which files are in it and how large their change is, which subsystems and layers they belong to, and what you know of the repository (read its agent docs and directory layout as needed; the finders read the hunks themselves).

Files in scope (${inScope.length}):
${list}
${sizes}

One finder runs per dimension. A dimension is a slice a single reviewer can hold in context and attack from one angle: a subsystem, a layer, or a cross-cutting concern such as authorization, i18n and docs, or tests and CI. Every file listed above belongs to at least one dimension; a file may appear in several when two angles both need it. \`focus\` is a paragraph naming the specific things to attack in those files: the mechanisms the diff introduced, the invariants it could break, the callers that depend on it. Past runs used five to nine dimensions for branches of forty to a hundred changed files; a small diff may need two. Use the paths exactly as listed above.`
}

function fixLocation(f) {
  if (f.commitSha) return `committed as ${f.commitSha} (inspect with \`git show ${f.commitSha}\`)`
  return `left uncommitted in the working tree, files ${(f.files || []).join(', ') || '(unreported)'}`
}

function triagePrompt(round, candidates, findings, changeKinds) {
  const kindList = Object.keys(changeKinds).map((k) => `- ${k}${changeKinds[k].production ? ' (production)' : ''}: ${changeKinds[k].text}`).join('\n')
  const blocks = candidates.map((c) => {
    const fixer = c.outcome === 'covered' && c.coveredBy != null ? findings.find((f) => f.id === c.coveredBy) : null
    const fix = fixer || c
    const via = fixer ? `\nFixed by the change for finding #${fixer.id} "${fixer.title}", which covers it.` : ''
    const hunks = fix.hunks && fix.hunks.trim() ? `\nHunks:\n${fix.hunks.trim()}` : '\nHunks: not reported; read the fix from git.'
    return `Finding #${c.id} [${c.severity}] ${c.title}\nLocation: ${c.file}:${c.line}\nDescription: ${c.description}${via}\nFix: ${fixLocation(fix)}\nKinds reported by the implementer: ${(fix.kinds || []).join(', ') || '(none)'}${hunks}`
  }).join('\n\n')
  return `${CONTEXT}

${READ_ONLY}

You are the TRIAGE agent of a looping adversarial code review. Round ${round} just fixed the medium, high and critical findings below. For each one, classify its fix by the kinds of change its hunks contain, from this list. The kinds marked production change what shipped code does at runtime; the others do not:
${kindList}

A fix carries every kind its hunks contain: one that changed a comment and a query is comment and logic. The implementer's own kinds are shown for reference; judge from the hunks. Read each fix's hunks (pasted below when the implementer reported them, otherwise from git as indicated), list a production kind only when a hunk changes what shipped code does, and quote that hunk in the reason. One verdict per finding id.

${blocks}`
}

function prepareSections() {
  const extRe = `\\.(${PRUNE_EXTS.map((e) => e.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
  return [
    { name: 'files', kind: 'list', cmd: `{ ${LIST_TRACKED_CMD}; ${GIT} ls-files -o --exclude-standard; } | sort -u | grep -vE '${EXCLUDE}' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done || :` },
    {
      name: 'pruneFiles',
      kind: 'list',
      cmd: SCOPE === 'codebase'
        ? `${GIT} ls-files | sort -u | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && grep -qE '(//|/\\*|<!--)' "$f" && echo "$f"; done || :`
        : `${GIT} diff --name-only ${BASE} | sort -u | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ${GIT} diff ${BASE} -- "$f" | grep -qE '^\\+.*(//|/\\*|<!--)' && echo "$f"; done || :`,
    },
    { name: 'pruneUntrackedFiles', kind: 'list', cmd: `${GIT} ls-files -o --exclude-standard | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && grep -qE '(//|/\\*|<!--)' "$f" && echo "$f"; done || :` },
    { name: 'untrackedBaseline', kind: 'list', cmd: `${GIT} ls-files -o --exclude-standard` },
    { name: 'baselineHash', kind: 'hash', cmd: hashCommand() },
  ]
}

// ---------- copied command output ----------

// A cheap agent sorting several outputs into several fields once returned an
// empty pruneFiles its own command had just printed two paths for. So the
// agent copies one block of output and the script splits it on marker lines.
const MARKER = '::section::'
// The harness swaps a Bash result over about 30 KB for a pointer to a file,
// which the agent then pages through and reassembles by hand; a 90 KB log
// copied that way came back with 34 commits missing and passed every marker
// check. So the output is copied in parts that each fit one Bash result, each
// checked against its cksum. Every part re-runs the same read-only commands in
// the repository and keeps its own line range: agents asked to relay an opaque
// temp file refused it as a smuggled signal.
const CHUNK_BYTES = 20000

function copyBody(sections) {
  const body = sections.map((sec) => `echo '${MARKER} ${sec.name}'\n${sec.cmd}`).join('\n')
  return `cd ${shellQuote(ROOT)} && (
${body}
echo '${MARKER} end'
)`
}

function copyIntro(what) {
  return `You are a helper of the merge-ready code review loop the user launched on the repository ${ROOT}. The loop's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state and files; it changes nothing. The \`${MARKER}\` lines are headers the script splits the output on.`
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
// without the code fence lines an agent may wrap it in; the check decides
// which reading is right, since a commit message can hold a fence of its own.
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

// Returns null when the output is not one complete run of the command: a
// missing section or end marker, or a hash section without a hash, means lines
// were lost.
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
    if (current) raw[current].push(line.replace(/\r$/, ''))
  }
  if (!raw.end) return null
  const value = {}
  for (const sec of sections) {
    const lines = raw[sec.name]
    if (!lines) return null
    if (sec.kind === 'text') {
      value[sec.name] = lines.map((l) => l.trimEnd()).join('\n').trim()
    } else if (sec.kind === 'hash' || sec.kind === 'commit') {
      const hash = (sec.kind === 'hash' ? /^\s*([0-9a-f]{64})\b/ : /^\s*([0-9a-f]{40})\b/).exec(lines.find((l) => l.trim()) || '')
      if (!hash) return null
      value[sec.name] = hash[1]
    } else {
      value[sec.name] = [...new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('```')))].sort()
    }
  }
  return value
}

// The first copy runs the command and lays out the parts; the parts past the
// first are copied in parallel. A copy that fails its check is retried once;
// the second failure, or any refusal, ends the step.
async function runCopy(sections, what, label, phase, opts) {
  const head = await copyAttempts(copyPrompt(sections, what), label, phase, opts, parseHead)
  if (!head.value) return head
  const { chunks, first } = head.value
  const rest = await parallel(chunks.slice(1).map((chunk, k) => () =>
    copyAttempts(chunkPrompt(sections, what, chunk, k + 2, chunks.length), `${label} part ${k + 2}`, phase, opts, (out) => verifyChunk(out, chunk))))
  const failed = rest.findIndex((r) => !r || !r.value)
  if (failed >= 0) return { value: null, error: rest[failed] ? rest[failed].error : `the ${label} part ${failed + 2} copy threw` }
  const value = parseCopy([...first, ...rest.flatMap((r) => r.value)], sections)
  return value ? { value, error: null } : { value: null, error: `the ${label} output lacks a section marker` }
}

async function copyAttempts(prompt, label, phase, opts, parse) {
  let dead = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run(prompt, { label: `${label}.${attempt}`, phase, schema: COPY_SCHEMA, ...opts })
    if (!r) dead++
    else if (r.declined && r.declined.trim()) return { value: null, error: `the ${label} agent declined to run the command: ${r.declined.trim()}` }
    const value = r ? parse(r.output) : null
    if (value) return { value, error: null }
  }
  return {
    value: null,
    error: dead === 2
      ? `the ${label} agent died twice`
      : `the ${label} agent returned an output that failed its check ${dead === 0 ? 'twice' : 'once and died once'}`,
  }
}

function shellQuote(s) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function hashCommand() {
  if (SCOPE === 'codebase') {
    return '{ git ls-files -z; git ls-files -o --exclude-standard -z; } | sort -zu | xargs -0 -r sha256sum | sha256sum'
  }
  return `{ git diff ${BASE}...HEAD; git diff HEAD; git status --porcelain -z; git ls-files -o --exclude-standard -z | sort -z | xargs -0 -r sha256sum; } | sha256sum`
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
// catch-all finder rather than silently leaving the round's scope.
function normalizeDimensions(raw, inScope) {
  const scope = new Set(inScope)
  const keys = new Set()
  const dimensions = []
  for (const d of raw || []) {
    if (!d || !d.title || !d.focus || !Array.isArray(d.files)) continue
    const files = [...new Set(d.files.filter((f) => scope.has(f)))]
    if (files.length === 0) continue
    let key = String(d.key || '').trim().replace(/\s+/g, '-') || `dim-${dimensions.length + 1}`
    const stem = key
    for (let n = 2; keys.has(key); n++) key = `${stem}-${n}`
    keys.add(key)
    dimensions.push({ key, title: d.title, focus: d.focus, files })
  }
  const covered = new Set(dimensions.flatMap((d) => d.files))
  const missing = inScope.filter((f) => !covered.has(f))
  if (missing.length) {
    let key = 'unassigned'
    for (let n = 2; keys.has(key); n++) key = `unassigned-${n}`
    dimensions.push({
      key,
      title: 'Files the scout assigned to no dimension',
      focus: 'These files are in the review scope but the scout left them out of every dimension. Read their hunks (untracked files whole), work out what each change introduces, and attack it from the angle the change itself suggests: the invariants it could break, the callers that depend on it, the contradictions with docs or copy.',
      files: missing,
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
let authorEnd = LOOP_START
let authorLog = null

log(`scope ${SCOPE}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, up to ${MAX_ROUNDS} review round(s), scout and implementers on ${MODEL || 'the session model'}, simplify afterwards`)

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Scout')
  const { value: state, error: stateError } = await runCopy(stateSections(round, authorEnd), STATE_WHAT, `state @${round}`, 'Scout', STATE_OPTS)
  if (!state) {
    stopReason = 'agent-failed'
    stopDetail = `round ${round}: ${stateError}`
    break
  }
  if (round === 1) {
    authorEnd = authorEnd || state.head || null
    authorLog = state.log || null
  }
  const inScope = [...new Set([...state.tracked, ...state.untracked])]
  if (inScope.length === 0) {
    stopReason = 'scope-empty'
    stopDetail = `round ${round} found nothing in scope`
    break
  }
  const intent = buildIntent(authorLog, state.loopCommits)
  const scout = await run(scoutPrompt(state, inScope, intent), { label: `scout @${round}`, phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
  if (!scout) {
    stopReason = 'agent-failed'
    stopDetail = `the scout of round ${round} died`
    break
  }
  const { dimensions, missing } = normalizeDimensions(scout.dimensions, inScope)
  if (missing.length) log(`round ${round}: the scout left ${missing.length} file(s) out of every dimension; a catch-all finder takes them`)

  phase('Review')
  log(`round ${round}: ${dimensions.length} finder(s): ${dimensions.map((d) => d.key).join(', ')}${state.dirtyAtLaunch.length ? `; ${state.dirtyAtLaunch.length} path(s) dirty` : '; tree clean'}`)
  const reviewArgs = {
    scope: SCOPE,
    root: ROOT,
    dirtyAtLaunch: state.dirtyAtLaunch,
    untracked: state.untracked,
    dimensions,
    context: input.context,
  }
  if (BASE) reviewArgs.base = BASE
  if (CHECKS) reviewArgs.checks = CHECKS
  if (MODEL) reviewArgs.implementerModel = MODEL
  if (intent) reviewArgs.intent = intent
  const { result: review, error } = await runChild(input.reviewScript, reviewArgs, 'review workflow')

  const entry = {
    round,
    dimensions: dimensions.map(({ key, title, files }) => ({ key, title, files })),
    unassignedFiles: missing,
    dirtyAtLaunch: state.dirtyAtLaunch,
    review,
    error,
    triage: null,
    decision: null,
  }
  rounds.push(entry)
  if (!review) {
    stopReason = 'review-failed'
    stopDetail = `round ${round}: ${error}`
    break
  }

  for (const f of review.uncommittedFixFiles || []) allUncommittedFixFiles.add(f)
  for (const p of review.possiblyDirty || []) allPossiblyDirty.add(p)
  for (const fx of review.fixes || []) allFixes.push({ round, ...fx })
  const changeKinds = review.changeKinds
  if (!changeKinds || typeof changeKinds !== 'object' || Object.keys(changeKinds).length === 0) {
    stopReason = 'review-failed'
    stopDetail = `round ${round}: the review workflow returned no changeKinds table; the adversarial-review-workflow skill is older than this one`
    break
  }

  const findings = review.findings || []
  const fixed = findings.filter((f) => f.outcome === 'fixed')
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
      .flatMap((f) => [f.dimension, ...(f.alsoReportedBy || []).map((r) => r.dimension)])
      .filter((k) => finderKeys.has(k)),
  )
  const counts = {
    finders: dimensions.length,
    finderFailures: (review.finderFailures || []).length,
    registered: findings.length,
    confirmed: findings.filter((f) => f.status === 'confirmed').length,
    fixed: fixed.length,
    covered: covered.length,
    resolved,
    resolvedMediumOrHigher: candidates.length,
    productiveFinders: productiveFinders.size,
  }

  const triage = { candidates: candidates.map((f) => f.id), verdicts: [], failed: false, productionIds: [] }
  if (candidates.length) {
    phase('Triage')
    const t = await run(triagePrompt(round, candidates, findings, changeKinds), { label: `triage @${round}`, phase: 'Triage', schema: triageSchema(changeKinds), ...TRIAGE_OPTS })
    if (!t) {
      triage.failed = true
      triage.productionIds = candidates.map((f) => f.id)
      log(`round ${round}: the triage agent died; every medium-or-higher fix is assumed to have changed production behaviour`)
    } else {
      const isProduction = (v) => v.kinds.some((k) => changeKinds[k] && changeKinds[k].production)
      triage.verdicts = t.verdicts
        .filter((v) => candidates.some((f) => f.id === v.id))
        .map((v) => ({ id: v.id, kinds: v.kinds, production: isProduction(v), reason: v.reason }))
      triage.productionIds = triage.verdicts.filter((v) => v.production).map((v) => v.id)
    }
  }
  entry.triage = triage

  const reasons = []
  if (triage.productionIds.length) {
    reasons.push(`${triage.productionIds.length} medium-or-higher fix(es) changed production behaviour (#${triage.productionIds.join(', #')})`)
  }
  if (productiveFinders.size * 2 >= dimensions.length) {
    reasons.push(`${productiveFinders.size} of ${dimensions.length} finder(s) reported a medium-or-higher issue that was fixed or covered (${[...productiveFinders].join(', ')})`)
  }
  if (counts.finderFailures) {
    reasons.push(`finder(s) ${review.finderFailures.join(', ')} failed, so their dimension was never reviewed`)
  }
  const blocked = (review.possiblyDirty || []).length > 0
  entry.decision = { counts, reasons, continue: reasons.length > 0 && !blocked }

  if (blocked) {
    stopReason = 'possibly-dirty'
    stopDetail = `round ${round}: an implementer died and the cleanup could not restore ${review.possiblyDirty.join(', ')}`
    log(`round ${round}: stopping, the tree may hold partial hunks in protected paths`)
    break
  }
  if (reasons.length === 0) {
    stopReason = 'converged'
    log(`round ${round}: ${counts.resolved} issue(s) resolved, ${counts.resolvedMediumOrHigher} of them medium or higher from ${counts.productiveFinders} of ${counts.finders} finder(s), none of those in production code; the review loop is done`)
    break
  }
  log(`round ${round}: ${counts.resolved} issue(s) resolved by ${counts.finders} finder(s); another round because ${reasons.join('; ')}`)
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
  phase('Prepare')
  const hashCmd = hashCommand()
  const { value: prep, error: prepError } = await runCopy(prepareSections(), PREPARE_WHAT, 'prepare simplify', 'Prepare', PREPARE_OPTS)
  if (!prep) {
    simplify = { ran: false, skipped: 'prepare-failed', error: prepError, result: null }
    log(`simplify skipped: ${prepError}`)
  } else if (prep.files.length === 0) {
    simplify = { ran: false, skipped: 'nothing-to-simplify', error: null, result: null }
    log('simplify skipped: no source file in scope after the exclusions')
  } else {
    phase('Simplify')
    log(`simplify: ${prep.files.length} file(s), ${prep.pruneFiles.length + prep.pruneUntrackedFiles.length} prune candidate(s)`)
    const simplifyArgs = {
      scope: SCOPE,
      root: ROOT,
      hashCmd,
      baselineHash: prep.baselineHash,
      untrackedBaseline: prep.untrackedBaseline,
      files: prep.files,
      pruneFiles: prep.pruneFiles,
      pruneUntrackedFiles: prep.pruneUntrackedFiles,
      pruneExts: PRUNE_EXTS,
    }
    if (BASE) simplifyArgs.base = BASE
    if (CHECK_CMD) simplifyArgs.checkCmd = CHECK_CMD
    if (MODEL) simplifyArgs.applyModel = MODEL
    const { result, error } = await runChild(input.simplifyScript, simplifyArgs, 'simplify workflow')
    simplify = result
      ? { ran: true, skipped: null, error: null, result }
      : { ran: false, skipped: 'simplify-failed', error, result: null }
    if (!result) log(`simplify failed: ${error}`)
  }
}

log(`done: ${rounds.length} review round(s), stop reason ${stopReason}, ${allFixes.length} fix(es) in total, simplify ${simplify.ran ? 'ran' : `skipped (${simplify.skipped})`}`)

return {
  scope: SCOPE,
  base: BASE,
  model: MODEL || null,
  checksConfigured: CHECKS !== null,
  checkCmdConfigured: CHECK_CMD !== null,
  maxRounds: MAX_ROUNDS,
  stopReason,
  stopDetail,
  rounds,
  fixes: allFixes,
  uncommittedFixFiles: [...allUncommittedFixFiles],
  possiblyDirty: [...allPossiblyDirty],
  simplify,
}
