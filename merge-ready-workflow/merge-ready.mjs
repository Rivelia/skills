export const meta = {
  name: 'merge-ready',
  description: 'Repeat the adversarial code review over a scope, each round opened by a comment pass and its finders re-scouted over the files not yet clean for two rounds, until a round fixes nothing medium or higher that changes production behaviour and fewer than half its finders reported a medium-or-higher fix, confirmed by a round over the full scope; then simplify the same scope with the comment flags as seeds, strip what simplify wrote, and review the reshapes once',
  phases: [
    { title: 'Prepare', detail: 'Haiku runs the command listing the files in scope, unless args carry them', model: 'haiku' },
    { title: 'Comments', detail: 'the no-comments workflow (no-comments.mjs): full before every round and after simplify, flags before simplify, delete-only after the closing review' },
    { title: 'Scout', detail: 'the session model (or args.model) at medium effort designs the finder dimensions afresh for the round' },
    { title: 'Review', detail: 'the adversarial-review workflow (review.mjs) over the round\'s dimensions' },
    { title: 'Triage', detail: 'Opus classifies each fixed medium-or-higher finding by the kinds of change in its hunks; a production kind means another round; runs beside the next round when the finders already justify one; otherwise the loop waits for it before deciding whether to stop', model: 'opus' },
    { title: 'Simplify', detail: 'the simplify-converge workflow (simplify.mjs) over the same scope, which computes its own file lists and commits its changes' },
  ],
}

const SCOPES = ['uncommitted', 'branch', 'unpushed', 'since', 'codebase']
const canJustifyAnotherRound = (f) => ['medium', 'high', 'critical'].includes(f.severity)
const MAX_ROUNDS = 25
const QUIET_ROUNDS = 2

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('args.root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('args.base: the commit bounding the diff is required for every scope except codebase')
}
if (input.base && (typeof input.base !== 'string' || !/^[0-9a-f]{7,64}$/.test(input.base))) {
  throw new Error('args.base: the hex sha the commit bounding the diff resolves to, not a ref or commit-ish')
}
for (const key of ['reviewScript', 'simplifyScript', 'noCommentsScript']) {
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
const listGiven = input.files !== undefined
if (listGiven && (!Array.isArray(input.files) || input.files.some((p) => typeof p !== 'string'))) {
  throw new Error('args.files: pass it as string[] or omit it to have the workflow list the files')
}
if (input.scope === 'codebase'
  ? input.loopStart !== undefined
  : typeof input.loopStart !== 'string' || !/^[0-9a-f]{7,64}$/.test(input.loopStart)) {
  throw new Error('args.loopStart: the hex commit the loop starts from (HEAD at launch, or the start of a dead earlier run) is required for a scope with a base; omit it for codebase')
}
if (input.excludePattern && input.excludePattern.includes("'")) {
  throw new Error('args.excludePattern: the pattern is embedded in single quotes in a shell command and may not contain one')
}
if (input.excludePattern && /\[[^\]]*\[[:=.]|\[:[^\]]*:\]/.test(input.excludePattern)) {
  throw new Error('args.excludePattern: grep -E and the JavaScript RegExp the comment passes use read a POSIX bracket expression such as [:alnum:] differently; spell the class out, e.g. [A-Za-z0-9]')
}

const ROOT = input.root
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
const REPO = `Repository: ${ROOT}.`
const BASE = input.base || null
const SCOPE = input.scope
const CHECKS = input.checks ? input.checks.trim() : null
const CHECK_CMD = input.checkCmd ? input.checkCmd.trim() : null
const INTENT_NOTE = input.intent ? input.intent.trim() : null
const MODEL = input.model ? input.model.trim() : undefined

const DEFAULT_EXCLUDE = '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\\.min\\.|(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|go\\.sum)$|\\.(json|jsonl|csv|tsv|md|mdx|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm|so|dylib|dll|exe|bin|jar|war|class|o|a|obj|lib|pyc|tar|tgz|bz2|xz|zst|7z|rar|mp3|mp4|wav|ogg|webm|mov|avi|bmp|tiff?|avif|heic|svgz|docx|xlsx|pptx|db|sqlite|parquet|pkl|npy|flac|mkv|ttc|whl|apk|dmg|iso|rst)$'
const COMMENT_TOKEN = '//|/\\*|\\(\\*|<!--|#|--|"""|[[:space:]];'
const EXCLUDE_PATTERN =input.excludePattern ? input.excludePattern.trim() : DEFAULT_EXCLUDE
const EXCLUDE_RE = new RegExp(EXCLUDE_PATTERN, input.excludePattern ? '' : 'i')
const COMMENT_EXTS = input.pruneExts.map((e) => (e.startsWith('.') ? e : `.${e}`))
const commentCandidates = (files) => [...new Set(files)].filter((f) => COMMENT_EXTS.some((e) => f.endsWith(e)) && !EXCLUDE_RE.test(f)).sort()

const SCOUT_OPTS = { ...(MODEL ? { model: MODEL } : {}), effort: 'medium' }
const TRIAGE_OPTS = { model: 'opus', effort: 'medium' }

const SCOPE_LABEL = {
  uncommitted: 'the work uncommitted at launch',
  branch: 'the branch diff',
  unpushed: 'the unpushed work',
  since: `the work since ${BASE}`,
  codebase: 'the entire codebase',
}

const SCOPE_TEXT = SCOPE === 'codebase'
  ? `Review scope: ${SCOPE_LABEL.codebase}, every tracked file. There is no base commit.`
  : `Review scope: ${SCOPE_LABEL[SCOPE]}, i.e. the tree against base commit ${BASE}.`

const CONTEXT = `${REPO}
${input.context.trim()}
${SCOPE_TEXT}`

const READ_ONLY = `You are READ-ONLY with respect to the repository: do not edit, create or delete files under ${ROOT}, and run no git command that changes state (no checkout, restore, stash, commit, reset, clean). Scratch files go in /tmp.`

const LOOP_START = input.loopStart || null

const LOADED_INSTRUCTIONS = 'a prompt, tool description, skill or agent instructions the product loads'

const RUNTIME_RESOLVED = 'adding, restoring, removing or renaming a translation key, asset or config entry that shipped code references, since what the code resolves at runtime changes'

const CHANGE_KINDS = {
  logic: { production: true, text: `a change to what shipped code does: application logic, data handling, queries, API handlers, UI behaviour; a helper local to the file it fixes is part of it; also ${RUNTIME_RESOLVED}` },
  config: { production: true, text: 'configuration the running product reads' },
  robustness: { production: true, text: 'a small guard or fallback with no user-visible effect today' },
  instructions: { production: true, text: LOADED_INSTRUCTIONS },
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

const DIMENSIONS_SCHEMA = {
  type: 'object',
  properties: {
    dimensions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short slug.' },
          title: { type: 'string' },
          focus: { type: 'string', description: 'A paragraph naming the specific things to attack in these files: the mechanisms the diff introduced, the invariants it could break, the callers that depend on it.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Paths exactly as the scope names them, or a directory ending in / for every file in scope under it.' },
          production: { type: 'boolean', description: `True when any of its files holds code or configuration the running product executes or reads; false only when every one is docs, comments, rewordings of user-facing copy and translations, tests and fixtures, or CI and build configuration. Also production: ${LOADED_INSTRUCTIONS}, and a file whose change is ${RUNTIME_RESOLVED}.` },
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

function scoutIntentText() {
  const parts = []
  if (INTENT_NOTE) parts.push(`The author's note on what the diff deliberately does, verbatim:\n<<<\n${INTENT_NOTE}\n>>>`)
  if (LOOP_START) {
    const end = LOOP_START.slice(0, 9)
    if (!LOOP_START.startsWith(BASE) && !BASE.startsWith(LOOP_START)) {
      parts.push(`The author's commits are ${BASE.slice(0, 9)}..${end}; their messages state what the diff deliberately does. Read the subjects with \`git log --format='%h %s' ${BASE}..${end}\` piped through \`head -n 100\`, and a path's messages with \`git --literal-pathspecs log --format='--- %h%n%B' ${BASE}..${end} -- <paths>\`, never the whole range at once: it can hold hundreds of commits.`)
    }
    parts.push(`Every commit after ${end} was made by this review loop, not by the author; never list those.`)
  }
  if (!parts.length) return ''
  return `\nAuthor's intent for this diff:\n${parts.join('\n')}\nThe intent is the baseline the finders test the diff against: a removal it states is a decision they check for breakage, not a loss to audit.\n`
}

const SCOUT_PATHS_MAX = 200

function directoryCounts(inScope) {
  const keys = new Set(
    inScope.map((f) => {
      const parts = f.split('/')
      return parts.length > 2 ? `${parts[0]}/${parts[1]}/` : parts.length > 1 ? `${parts[0]}/` : f
    }),
  )
  return [...keys]
    .map((k) => {
      if (!k.endsWith('/')) return `- ${k}`
      const n = inScope.filter((f) => f.startsWith(k)).length
      return `- ${k} (${n} file${n === 1 ? '' : 's'})`
    })
    .join('\n')
}

function scoutPrompt(inScope, { base, context, intent }) {
  const byDir = inScope.length > SCOUT_PATHS_MAX
  const list = byDir ? directoryCounts(inScope) : inScope.map((f) => `- ${f}`).join('\n')
  const listing = base ? `\`git --literal-pathspecs diff --name-only ${base} -- <dir>\`` : '`git --literal-pathspecs ls-files -- <dir>`'
  return `${context}

${READ_ONLY}
${intent}
You are the SCOUT of an adversarial code review. Design the finder dimensions from the SHAPE of the scope, not its content: which files are in it, how large their change is, which subsystems and layers they belong to. The finders read the hunks themselves.

${byDir ? `Files in scope (${inScope.length}), counted per directory; list a directory's files with ${listing} when you need to split it:` : `Files in scope (${inScope.length}):`}
${list}

A dimension is a slice a single reviewer can hold in context and attack from one angle: a subsystem, a layer, or a cross-cutting concern such as authorization, i18n and docs, or tests and CI. Every file in scope belongs to at least one dimension; a file may appear in several when two angles both need it. \`production\` picks the finder's model: a dimension holding no production code gets a cheaper one, so keep docs, tests and CI in dimensions of their own when the scope has enough of them, and mark a dimension production whenever in doubt. Past runs used five to nine dimensions for branches of forty to a hundred changed files; a small diff may need two.`
}

function roundScoutPrompt(inScope) {
  return scoutPrompt(inScope, { base: BASE, context: CONTEXT, intent: scoutIntentText() })
}

function closingScoutPrompt(reshapeFiles, base) {
  const scopeLine = base ? `Review scope: the reshapes since ${base}, i.e. the tree against base commit ${base}.` : 'Review scope: these files, whole; there is no base commit.'
  return scoutPrompt(reshapeFiles, { base, context: `${REPO}\n${input.context.trim()}\n${scopeLine}`, intent: '' })
}

function fixLocation(f) {
  if (f.commitSha) return `committed as ${f.commitSha}${f.notes ? `\nImplementer notes: ${f.notes}` : ''}`
  return 'none: the implementer found the defect already closed in the tree'
}

function triagePrompt(round, candidates, findings) {
  const kindList = Object.keys(CHANGE_KINDS).map((k) => `- ${k}${CHANGE_KINDS[k].production ? ' (production)' : ''}: ${CHANGE_KINDS[k].text}`).join('\n')
  const blocks = candidates.map((c) => {
    const fixer = c.outcome === 'covered' && c.coveredBy != null ? findings.find((f) => f.id === c.coveredBy) : null
    const fix = fixer || c
    const via = fixer ? `\nFixed by the change for finding #${fixer.id} "${fixer.title}", which covers it.` : ''
    return `Finding #${c.id} [${c.severity}] ${c.title}\nLocation: ${c.file}:${c.line}${via}\nFix: ${fixLocation(fix)}`
  }).join('\n\n')
  return `${REPO}
${input.context.trim()}

${READ_ONLY}

You are the TRIAGE agent of a looping adversarial code review. Round ${round} just fixed the findings below. For each one, classify its fix by the kinds of change its hunks contain, from this list:
${kindList}

Judge a hunk by what it changes at runtime, not by the file type it sits in: when the finding describes a defect a user of the running product sees or hits, and the fix removes it, the fix carries a production kind whatever its hunks look like. List a production kind only when a hunk changes what shipped code does.

${blocks}`
}

const GIT = 'git -c core.quotePath=false'
const PREPARE_OPTS = { model: 'haiku', effort: 'low' }

const PREPARE_SECTIONS = [
  { name: 'files', cmd: SCOPE === 'codebase' ? `${GIT} ls-files` : `${GIT} diff --name-only ${BASE}` },
]

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string', description: 'The command\'s output, verbatim.' },
    declined: { type: 'string', description: 'Only when you did not run the command: why, in one sentence. Leave output empty then.' },
  },
  required: ['output'],
}

const MARKER = '::section::'
const CHUNK_BYTES = 6000

function copyBody(sections) {
  const body = sections.map((sec) => `echo '${MARKER} ${sec.name}'\n${sec.cmd}`).join('\n')
  return `cd ${shellQuote(ROOT)} && (
${body}
echo '${MARKER} end'
)`
}

function copyIntro(what) {
  return `You are a helper of the merge-ready workflow the user launched on the repository ${ROOT}. The workflow's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state; it changes nothing.`
}

const COPY_RULE = 'Return its entire output verbatim as `output`: every line, in order, nothing added, removed or reworded. The script checks the copy against a checksum. There is nothing to review in it, so you need not open any file.'

function copyPrompt(sections, what) {
  const ranges = `LC_ALL=C awk -v max=${CHUNK_BYTES} '{ l = length($0) + 1; if (n && b + l > max) { print s, NR - 1; n = 0; b = 0 } if (!n) s = NR; n++; b += l } END { if (n) print s, NR }' "$f"`
  return `${copyIntro(what)} A long output comes back cut or miscopied, so the command numbers the output's lines into parts of at most ${CHUNK_BYTES} bytes, prints one \`::part::\` line per part (first line, last line, cksum), then the first part itself; other helpers fetch the remaining parts.

Run exactly this shell command via Bash, unmodified, as a single call:

f=$(mktemp) && ${copyBody(sections)} > "$f" && r=$(${ranges}) && echo "$r" | while read -r s e; do echo "::part:: $s $e $(sed -n "$s,\${e}p" "$f" | cksum)"; done && sed -n "$(echo "$r" | head -n 1 | tr ' ' ',')p" "$f"; rm -f "$f"

${COPY_RULE}`
}

function chunkPrompt(sections, what, chunk, index, count) {
  return `${copyIntro(what)} A long output comes back cut or miscopied, so it is fetched in ${count} parts; this is part ${index}, lines ${chunk.start} to ${chunk.end}, which the \`sed\` at the end keeps.

Run exactly this shell command via Bash, unmodified, as a single call:

${copyBody(sections)} | sed -n '${chunk.start},${chunk.end}p'

${COPY_RULE}`
}

function copiedLines(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
}

function parseHead(output) {
  const lines = copiedLines(output)
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

const isCodeFence = (l) => /^\s*```\S*\s*$/.test(l)

function unfenced(lines) {
  const bare = lines.slice(isCodeFence(lines[0] || '') ? 1 : 0)
  while (bare.length && bare[bare.length - 1] === '') bare.pop()
  if (bare.length && isCodeFence(bare[bare.length - 1])) bare.pop()
  return bare
}

function fittedToLineCount(lines, count) {
  const fitted = lines.slice()
  while (fitted.length > count && fitted[fitted.length - 1] === '') fitted.pop()
  while (fitted.length < count) fitted.push('')
  return fitted.length === count ? fitted : null
}

function matchesChecksum(lines, chunk) {
  const bytes = utf8(lines.map((l) => `${l}\n`).join(''))
  return bytes.length === chunk.bytes && cksum(bytes) === chunk.crc
}

function verifyChunk(text, chunk) {
  const asCopied = copiedLines(text)
  const count = chunk.end - chunk.start + 1
  for (const reading of [asCopied, unfenced(asCopied)]) {
    const fitted = fittedToLineCount(reading, count)
    if (fitted && matchesChecksum(fitted, chunk)) return fitted
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

const AGENT_LIMIT_ERRORS = ['WorkflowAgentCapError', 'WorkflowBudgetExceededError']
let agentLimit = null

function noteAgentLimit(err) {
  if (err && AGENT_LIMIT_ERRORS.includes(err.name)) agentLimit ??= err.message || err.name
}

async function run(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch (err) {
    noteAgentLimit(err)
    return null
  }
}

async function runChild(scriptPath, childArgs, what) {
  try {
    const result = await workflow({ scriptPath }, childArgs)
    if (!result) return { result: null, error: `the ${what} returned nothing` }
    return { result, error: null }
  } catch (err) {
    noteAgentLimit(err)
    return { result: null, error: `the ${what} threw: ${err && err.message ? err.message : String(err)}` }
  }
}

function normalizeDimensions(raw, inScope, { expandDirs = false, diff }) {
  const scope = new Set(inScope)
  const expand = (entry) => (entry.endsWith('/') ? inScope.filter((f) => f.startsWith(entry)) : scope.has(entry) ? [entry] : [])
  const keys = new Set()
  const dimensions = []
  for (const d of raw || []) {
    if (!d || !d.title || !d.focus || !Array.isArray(d.files)) continue
    const named = d.files.filter((f) => typeof f === 'string' && expand(f).length)
    const files = [...new Set(expandDirs ? named.flatMap(expand) : named)]
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
      focus: `These files are in the review scope but the scout left them out of every dimension. ${diff
        ? 'Read their hunks, work out what each change introduces, and attack it from the angle the change itself suggests'
        : 'Read these files in full and attack them from the angle their code suggests'}: the invariants it could break, the callers that depend on it, the contradictions with docs or copy.`,
      files: missing,
      production: true,
    })
  }
  return { dimensions, missing }
}

const rounds = []
const allFixes = []
const allPossiblyDirty = new Set()
const commentTouched = new Set()
const cleanStreak = new Map()
let stopReason = null
let stopDetail = null
const excludedKindsTable = {}

log(`scope ${SCOPE}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, up to ${MAX_ROUNDS} review round(s), each opened by a comment pass, scout and implementers on ${MODEL || 'the session model'}, simplify afterwards`)

phase('Prepare')
const sortedPaths = (paths) => [...new Set(paths.map((p) => p.trim()).filter(Boolean))].sort()
const { value: launch, error: prepareError } = listGiven
  ? { value: { files: sortedPaths(input.files) }, error: null }
  : await runCopy(PREPARE_SECTIONS, 'the files in scope the review loop starts from', 'prepare', 'Prepare', PREPARE_OPTS)
if (!launch) {
  stopReason = 'prepare-failed'
  stopDetail = prepareError
  log(`the launch state could not be read: ${prepareError}`)
}

function commentScanSections(files, base) {
  const hasComment = base
    ? `${GIT} --literal-pathspecs diff ${base} -- "$f" | grep -qE '^\\+(.*(${COMMENT_TOKEN})|[[:space:]]*[*;])'`
    : `grep -qE '(${COMMENT_TOKEN}|^;)' -- "$f"`
  return [{
    name: 'scan',
    cmd: `printf '%s\\n' ${files.map(shellQuote).join(' ')} | while IFS= read -r f; do if [ -f "$f" ] && ${hasComment}; then echo "$(($(wc -l < "$f"))) $f"; else echo "none $f"; fi; done`,
  }]
}

async function commentPass(mode, files, base, tag) {
  let candidates = commentCandidates(files)
  if (!candidates.length) return { result: null, error: null, skipped: 'no comment-carrying file to audit' }
  const lines = {}
  const { value: scan, error: scanError } = await runCopy(commentScanSections(candidates, base), 'which files carry a comment in scope, and their line counts', `scan ${tag}`, 'Comments', PREPARE_OPTS)
  if (scan) {
    const none = new Set()
    for (const l of scan.scan) {
      const m = /^(none|\d+) (.+)$/.exec(l)
      if (m && m[1] === 'none') none.add(m[2])
      else if (m) lines[m[2]] = +m[1]
    }
    candidates = candidates.filter((f) => !none.has(f))
    if (!candidates.length) return { result: null, error: null, skipped: 'no file with a comment in scope' }
  } else {
    log(`${tag} comment pass: the comment scan failed (${scanError}); every candidate goes to Comment Sicko`)
  }
  const commentArgs = { mode, root: ROOT, files: candidates, lines, context: input.context, tag }
  if (base) commentArgs.base = base
  if (CHECKS) commentArgs.checks = CHECKS
  if (CHECK_CMD && mode === 'full') commentArgs.checkCmd = CHECK_CMD
  if (MODEL) commentArgs.model = MODEL
  const { result, error } = await runChild(input.noCommentsScript, commentArgs, `${tag} comment pass`)
  if (result) {
    for (const f of [...(result.commit?.files || []), ...(result.fixFiles || [])]) {
      commentTouched.add(f)
      cleanStreak.delete(f)
    }
  }
  return { result, error, skipped: null }
}

function commentFailure(pass) {
  if (pass.error) return pass.error
  if (pass.result?.commit?.reason === 'the commit agent died') return 'its commit agent died, so the tree may be dirty'
  if (pass.result && pass.result.commit?.clean !== true) return 'its commit agent did not report a clean tree, so the tree may be dirty'
  if (pass.result && !pass.result.head) return 'its commit agent reported no valid HEAD sha'
  return null
}

let passBase = BASE

async function scoutRound(round, inScope) {
  const scout = await run(roundScoutPrompt(inScope), { label: `scout @${round}`, phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
  if (!scout) return { stop: 'agent-failed', detail: `the scout of round ${round} died` }
  return { stop: null, ...normalizeDimensions(scout.dimensions, inScope, { diff: SCOPE !== 'codebase' }) }
}

function updateStreaks(inScope, dimensions, review, fixed) {
  const failed = new Set(review.finderFailures || [])
  const expand = (entry) => (entry.endsWith('/') ? inScope.filter((f) => f.startsWith(entry)) : [entry])
  const reviewed = new Set(dimensions.filter((d) => !failed.has(d.key)).flatMap((d) => d.files.flatMap(expand)))
  const flagged = new Set((review.findings || []).filter((f) => f.status === 'confirmed').map((f) => f.file))
  for (const f of reviewed) cleanStreak.set(f, flagged.has(f) ? 0 : (cleanStreak.get(f) || 0) + 1)
  for (const f of fixed.flatMap((x) => x.files || [])) cleanStreak.delete(f)
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
    triage.productionIds = candidates
      .filter((f) => {
        const verdicts = t.verdicts.filter((v) => v.id === f.id)
        return !verdicts.length || verdicts.some(isProduction)
      })
      .map((f) => f.id)
  }
  return triage
}

function trimmedReview(review) {
  return {
    finderFailures: review.finderFailures,
    findings: (review.findings || []).map(({ dimension, ...f }) => {
      if (f.commitSha) delete f.files
      return f
    }),
  }
}

const backgroundTriages = []
let confirmNext = false

for (let round = 1; launch && round <= MAX_ROUNDS; round++) {
  phase('Comments')
  const passFiles = round === 1 ? launch.files : allFixes.filter((f) => f.round === round - 1).flatMap((f) => f.files || [])
  const pass = await commentPass('full', passFiles, passBase, `r${round}`)
  const passFailure = commentFailure(pass)
  if (passFailure) {
    rounds.push({ round, comments: pass.result, review: null, triage: null, decision: null, error: `the comment pass: ${passFailure}` })
    stopReason = 'comments-failed'
    stopDetail = `round ${round}: the comment pass failed: ${passFailure}`
    log(`round ${round}: stopping, the comment pass failed: ${passFailure}`)
    break
  }
  if (pass.result) passBase = pass.result.head

  phase('Scout')
  const fullScope = [...new Set([...launch.files, ...allFixes.flatMap((f) => f.files || []), ...commentTouched])].sort()
  const active = fullScope.filter((f) => (cleanStreak.get(f) || 0) < QUIET_ROUNDS)
  const confirmation = confirmNext || (fullScope.length > 0 && active.length === 0)
  confirmNext = false
  const inScope = confirmation ? fullScope : active
  const setAside = fullScope.length - inScope.length
  if (confirmation) log(`round ${round}: confirmation round over the full scope of ${fullScope.length} file(s)`)
  else if (setAside) log(`round ${round}: ${setAside} file(s) set aside after ${QUIET_ROUNDS} clean rounds untouched`)
  const scouted = fullScope.length
    ? await scoutRound(round, inScope)
    : { stop: 'scope-empty', detail: `round ${round} found nothing in scope` }
  if (scouted.stop) {
    const entry = { round, comments: pass.result, review: null, triage: null, decision: null, error: scouted.detail }
    if (pass.skipped) entry.commentsSkipped = pass.skipped
    rounds.push(entry)
    stopReason = scouted.stop
    stopDetail = scouted.detail
    break
  }
  const { dimensions, missing } = scouted
  if (missing.length) log(`round ${round}: the scout left ${missing.length} file(s) out of every dimension; a catch-all finder takes them`)

  phase('Review')
  log(`round ${round}: ${dimensions.length} finder(s): ${dimensions.map((d) => d.key).join(', ')}`)
  const reviewArgs = { scope: SCOPE, root: ROOT, dimensions, context: input.context, loopFields: true }
  if (BASE) reviewArgs.base = BASE
  if (CHECKS) reviewArgs.checks = CHECKS
  if (MODEL) reviewArgs.implementerModel = MODEL
  if (LOOP_START) reviewArgs.authorEnd = LOOP_START
  if (INTENT_NOTE) reviewArgs.intent = INTENT_NOTE
  const { result: review, error } = await runChild(input.reviewScript, reviewArgs, 'review workflow')

  const entry = { round, comments: pass.result, review, triage: null, decision: null }
  if (confirmation) entry.confirmation = true
  if (setAside) entry.setAside = setAside
  if (pass.skipped) entry.commentsSkipped = pass.skipped
  if (missing.length) entry.unassignedFiles = missing
  if (error) entry.error = error
  rounds.push(entry)
  if (!review) {
    stopReason = 'review-failed'
    stopDetail = `round ${round}: ${error}`
    break
  }

  for (const p of review.possiblyDirty || []) allPossiblyDirty.add(p)

  const findings = review.findings || []
  const fixed = findings.filter((f) => f.outcome === 'fixed')
  for (const f of fixed) allFixes.push({ round, id: f.id, files: f.files || [] })
  updateStreaks(inScope, dimensions, review, fixed)
  const covered = findings.filter((f) => f.outcome === 'covered')
  const resolved = fixed.length + covered.length
  const candidates = [...fixed, ...covered].filter(canJustifyAnotherRound)
  const unhandled = findings.filter((f) => canJustifyAnotherRound(f) && (f.status === 'agent_failed' || f.outcome === 'agent_failed') && f.failedAt !== 'cleanup')
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
    agentFailedMediumOrHigher: unhandled.length,
  }

  const reasons = []
  if (productiveFinders.size * 2 >= dimensions.length) {
    reasons.push(`${productiveFinders.size} of ${dimensions.length} finder(s) reported a medium-or-higher issue that was fixed or covered (${[...productiveFinders].join(', ')})`)
  }
  if (counts.finderFailures) {
    reasons.push(`finder(s) ${review.finderFailures.join(', ')} failed, so their dimension was never reviewed`)
  }
  if (unhandled.length) {
    reasons.push(`medium-or-higher finding(s) #${unhandled.map((f) => f.id).join(', #')} lost their skeptic or implementer, so they were never verified or fixed`)
  }
  entry.decision = { counts, reasons }
  const triaged = runTriage(round, candidates, findings).then((triage) => {
    entry.triage = triage
    if (triage.productionIds.length) {
      reasons.unshift(`${triage.productionIds.length} medium-or-higher fix(es) changed production behaviour (#${triage.productionIds.join(', #')})`)
    }
  })
  Object.assign(excludedKindsTable, review.excludedKinds)
  entry.review = trimmedReview(review)

  if ((review.possiblyDirty || []).length > 0) {
    await triaged
    stopReason = 'possibly-dirty'
    stopDetail = `round ${round}: a cleanup after an implementer could not restore ${review.possiblyDirty.join(', ')}`
    log(`round ${round}: stopping, the tree may hold partial hunks`)
    break
  }
  if (reasons.length) {
    backgroundTriages.push(triaged)
    log(`round ${round}: ${resolved} issue(s) resolved by ${counts.finders} finder(s); another round because ${reasons.join('; ')}${candidates.length ? '; the triage runs beside it' : ''}`)
    continue
  }
  await triaged
  if (reasons.length === 0 && setAside) {
    confirmNext = true
    log(`round ${round}: quiet over the ${inScope.length} active file(s); a confirmation round reviews the full scope before the loop ends`)
    continue
  }
  if (reasons.length === 0) {
    stopReason = 'converged'
    log(`round ${round}: ${resolved} issue(s) resolved, ${counts.resolvedMediumOrHigher} of them medium or higher from ${counts.productiveFinders} of ${counts.finders} finder(s), none of those in production code; the review loop is done`)
    break
  }
  log(`round ${round}: ${resolved} issue(s) resolved by ${counts.finders} finder(s); another round because ${reasons.join('; ')}`)
}
if (!stopReason) {
  stopReason = 'max-rounds'
  stopDetail = confirmNext
    ? `round ${MAX_ROUNDS} was quiet over its active files but the ${MAX_ROUNDS}-round backstop left no round to confirm it over the full scope`
    : `the last round still justified another and the ${MAX_ROUNDS}-round backstop ended the loop`
}
if (agentLimit && stopReason !== 'converged') {
  stopDetail = `${agentLimit}; ${stopDetail}`
  stopReason = 'agent-limit'
}

let seedsComments = null
let simplify
let afterSimplifyComments = null
let closingReview = { ran: false, skipped: null, error: null, files: [], review: null }
let finalComments = null
let closingSkipped = null

if (stopReason !== 'converged') {
  simplify = { ran: false, skipped: `review-loop-${stopReason}`, error: null, result: null }
  log(`simplify skipped: the review loop ended on ${stopReason}`)
} else {
  phase('Comments')
  const lastRound = rounds[rounds.length - 1].round
  const lastFixFiles = allFixes.filter((f) => f.round === lastRound).flatMap((f) => f.files || [])
  const sp = await commentPass('flags', lastFixFiles, passBase, 'seeds')
  seedsComments = sp.result
  const spFailure = commentFailure(sp)
  if (spFailure) {
    simplify = { ran: false, skipped: 'comments-failed', error: `the seeds comment pass failed: ${spFailure}`, result: null }
    log(`simplify skipped: ${simplify.error}`)
  } else {
    if (sp.result) passBase = sp.result.head
    phase('Simplify')
    const simplifyArgs = { scope: SCOPE, root: ROOT, pruneExts: input.pruneExts, excludePattern: EXCLUDE_PATTERN, skipComments: true, seeds: sp.result ? sp.result.seeds : [] }
    if (BASE) simplifyArgs.base = BASE
    if (CHECK_CMD) simplifyArgs.checkCmd = CHECK_CMD
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
}

const preSimplify = passBase
if (simplify.ran && !simplify.result.head) {
  closingSkipped = simplify.result.commit?.reason === 'the commit agent died' ? 'simplify\'s commit agent died, so the tree may be dirty' : 'simplify\'s commit agent reported no valid HEAD sha, so the tree may be dirty'
} else if (simplify.ran && simplify.result.commit?.clean !== true) {
  closingSkipped = 'simplify\'s commit agent did not report a clean tree'
} else if (simplify.ran) {
  phase('Comments')
  const ap = await commentPass('full', simplify.result.touchedFiles || [], preSimplify, 'after simplify')
  afterSimplifyComments = ap.result
  const apFailure = commentFailure(ap)
  if (apFailure) {
    closingSkipped = `the comment pass after simplify failed: ${apFailure}`
  } else {
    const afterHead = ap.result ? ap.result.head : simplify.result.head
    const reshapeFiles = [...new Set([
      ...(simplify.result.seeds?.applied || []).flatMap((c) => c.files || []),
      ...(ap.result?.fixFiles || []),
    ])].sort()
    if (!reshapeFiles.length) {
      closingReview.skipped = 'no MUST KILL reshape or encoding landed since the last review round'
    } else {
      closingReview = { ran: true, skipped: null, error: null, files: reshapeFiles, review: null }
      phase('Scout')
      const scout = await run(closingScoutPrompt(reshapeFiles, preSimplify), { label: 'scout @closing', phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
      if (!scout) {
        closingReview.error = 'the scout of the closing review died'
      } else {
        const { dimensions, missing } = normalizeDimensions(scout.dimensions, reshapeFiles, { expandDirs: true, diff: Boolean(preSimplify) })
        if (missing.length) closingReview.unassignedFiles = missing
        phase('Review')
        log(`closing review over ${reshapeFiles.length} reshaped file(s): ${dimensions.length} finder(s)`)
        const reviewArgs = { scope: preSimplify ? 'since' : 'codebase', root: ROOT, dimensions, context: input.context, loopFields: true }
        if (preSimplify) reviewArgs.base = preSimplify
        if (CHECKS) reviewArgs.checks = CHECKS
        if (MODEL) reviewArgs.implementerModel = MODEL
        const { result: review, error } = await runChild(input.reviewScript, reviewArgs, 'closing review workflow')
        if (!review) {
          closingReview.error = error
        } else {
          for (const p of review.possiblyDirty || []) allPossiblyDirty.add(p)
          const fixed = (review.findings || []).filter((f) => f.outcome === 'fixed')
          closingReview.mediumOrHigherFixes = fixed.filter(canJustifyAnotherRound).map((f) => f.id)
          Object.assign(excludedKindsTable, review.excludedKinds)
          closingReview.review = trimmedReview(review)
          if ((review.possiblyDirty || []).length) {
            closingSkipped = `a cleanup after an implementer of the closing review could not restore ${review.possiblyDirty.join(', ')}`
          } else {
            phase('Comments')
            const fp = await commentPass('delete-only', fixed.flatMap((f) => f.files || []), afterHead, 'final')
            finalComments = fp.result
            const fpFailure = commentFailure(fp)
            if (fpFailure) closingSkipped = `the final comment pass failed: ${fpFailure}`
          }
        }
      }
    }
  }
}

await Promise.all(backgroundTriages)

if (!closingReview.ran && !closingReview.skipped) {
  closingReview.skipped = closingSkipped || `simplify did not run (${simplify.skipped})`
}

log(`done: ${rounds.length} review round(s), stop reason ${stopReason}, ${allFixes.length} fix(es) in the loop, simplify ${simplify.ran ? 'ran' : `skipped (${simplify.skipped})`}, closing review ${closingReview.ran ? 'ran' : `skipped (${closingReview.skipped})`}`)

return {
  model: MODEL || null,
  checksConfigured: CHECKS !== null,
  excludedKinds: excludedKindsTable,
  stopReason,
  stopDetail,
  agentLimit,
  rounds,
  possiblyDirty: [...allPossiblyDirty],
  seedsComments,
  simplify,
  afterSimplifyComments,
  closingReview,
  finalComments,
  closingSkipped,
}
