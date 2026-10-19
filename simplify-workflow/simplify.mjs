export const meta = {
  name: 'simplify-converge',
  description: 'Strip comments with the no-comments workflow and judge its MUST KILL flags and constraints as seeds, loop simplification rounds (find, judge, apply) over a scope until fresh finders come up empty, commit, then strip the comments the appliers wrote',
  phases: [
    { title: 'Prepare', detail: 'Haiku runs the commands listing the scope, the untracked files and the source files with no comment in scope, and hashes the tree', model: 'haiku' },
    { title: 'Comments', detail: 'standalone only: the no-comments workflow (no-comments.mjs), in flags mode before the loop and delete-only after the commit' },
    { title: 'Seeds', detail: 'judge, then apply, the MUST KILL flags and constraints the opening comment pass returned' },
    { title: 'Find', detail: 'read-only agents propose simplifications per batch', model: 'opus' },
    { title: 'Judge', detail: 'independent gatekeepers strike proposals that are not genuine improvements', model: 'sonnet' },
    { title: 'Apply', detail: 'implement the approved findings per batch' },
    { title: 'Hash', detail: 'deterministic tree hash after the opening comment pass, the seed stage and each round an applier ran in', model: 'haiku' },
    { title: 'Discover', detail: 'list untracked files the appliers did not declare', model: 'haiku' },
    { title: 'Verify', detail: 'project check command: baseline on haiku before the first edit (the opening comment pass, the seed appliers or the first round\'s appliers), then one opus fix-up agent after the loop, over everything the opening comment pass, the seed stage and the rounds edited', model: 'opus' },
    { title: 'Commit', detail: 'Sonnet commits what the run left in the tree', model: 'sonnet' },
  ],
}

const SCOPES = ['uncommitted', 'branch', 'unpushed', 'since', 'codebase']

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('every scope except codebase requires base (the commit bounding the diff)')
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
if (input.model && !EFFORTS.includes(input.effort)) {
  throw new Error(`when model is overridden, effort must also be chosen: one of ${EFFORTS.join(', ')}`)
}

if (!Array.isArray(input.pruneExts) || input.pruneExts.length === 0) {
  throw new Error('pruneExts: string[] is required, the comment-carrying source extensions of this repo, e.g. [".ts", ".js", ".svelte"]')
}
if (input.skipComments !== undefined && typeof input.skipComments !== 'boolean') {
  throw new Error('skipComments: true when the caller runs the comment passes itself; omit it otherwise')
}
if (!input.skipComments && (typeof input.noCommentsScript !== 'string' || !input.noCommentsScript.startsWith('/'))) {
  throw new Error('noCommentsScript: the absolute path to no-comments.mjs is required unless skipComments is set')
}
if (input.seeds !== undefined && (!input.skipComments || !Array.isArray(input.seeds)
  || input.seeds.some((x) => !x || !['must-kill', 'constraint'].includes(x.kind) || typeof x.file !== 'string' || typeof x.description !== 'string'))) {
  throw new Error('seeds: [{kind: "must-kill" | "constraint", file, symbol, description}] from a flags-mode comment pass, only with skipComments')
}
if (input.excludePattern !== undefined && (typeof input.excludePattern !== 'string' || !input.excludePattern.trim() || input.excludePattern.includes("'"))) {
  throw new Error('excludePattern: a non-empty extended regex with no single quote (it is embedded in single quotes in a shell command) when given; omit it to keep the default')
}
if (input.excludePattern && /\[[^\]]*\[[:=.]|\[:[^\]]*:\]/.test(input.excludePattern)) {
  throw new Error('excludePattern: no POSIX bracket expression such as [:alnum:] (grep -E refuses one outside a bracket, and the file list would come out empty); spell the class out, e.g. [A-Za-z0-9]')
}

const shellQuote = s => `'${s.replace(/'/g, `'\\''`)}'`
const QUOTED_ROOT = shellQuote(input.root)
const REPO = `Repository (the project root): ${input.root}. Run every command from there (\`cd ${QUOTED_ROOT}\` first, or \`git -C ${QUOTED_ROOT}\`); every relative path is relative to it.`

// A literal command runs in a subshell after the cd, so an `a || b` inside it
// cannot run b elsewhere when the cd fails, and a trailing comment cannot
// swallow the closing parenthesis.
function rootedCmd(cmd) {
  return `cd ${QUOTED_ROOT} && (\n${cmd}\n)`
}

if (input.applyModel !== undefined && (typeof input.applyModel !== 'string' || !input.applyModel.trim())) {
  throw new Error('applyModel: a model name (e.g. opus, sonnet, haiku) when given; omit it to run the appliers on the session model')
}

const DEFAULT_EXCLUDE = '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\\.min\\.|(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|go\\.sum)$|\\.(json|jsonl|csv|tsv|md|mdx|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm|so|dylib|dll|exe|bin|jar|war|class|o|a|obj|lib|pyc|tar|tgz|bz2|xz|zst|7z|rar|mp3|mp4|wav|ogg|webm|mov|avi|bmp|tiff?|avif|heic|svgz|docx|xlsx|pptx|db|sqlite|parquet|pkl|npy|flac|mkv|ttc|whl|apk|dmg|iso|rst)$'
const COMMENT_TOKEN = '//|/\\*|\\(\\*|<!--|#|--|"""|[[:space:]];'
const SCOPE = input.scope
const ROOT = input.root
const BASE = input.base || null
const EXCLUDE = input.excludePattern ? input.excludePattern.trim() : DEFAULT_EXCLUDE
const EXCLUDE_FLAGS = input.excludePattern ? '' : 'i'
const EXCLUDE_RE = new RegExp(EXCLUDE, EXCLUDE_FLAGS)
const PRUNE_EXTS = input.pruneExts.map((e) => (e.startsWith('.') ? e : `.${e}`))
const GIT = 'git -c core.quotePath=false'
const LIST_TRACKED_CMD = SCOPE === 'codebase' ? `${GIT} ls-files` : `${GIT} diff --name-only ${BASE}`
const LIST_UNTRACKED_CMD = `${GIT} ls-files -o --exclude-standard`
const PREPARE_OPTS = { model: 'haiku', effort: 'low' }

const COPY_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string', description: 'The command\'s output, verbatim.' },
    declined: { type: 'string', description: 'Only when you did not run the command: why, in one sentence. Leave output empty then.' },
  },
  required: ['output'],
}

function prepareSections() {
  const extRe = `\\.(${PRUNE_EXTS.map((e) => e.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
  const commentRe = `(${COMMENT_TOKEN}|^;)`
  const addedCommentRe = `^\\+(.*(${COMMENT_TOKEN})|[[:space:]]*[*;])`
  return [
    { name: 'files', kind: 'list', cmd: `{ ${LIST_TRACKED_CMD}; ${LIST_UNTRACKED_CMD}; } | sort -u | grep -v${EXCLUDE_FLAGS}E '${EXCLUDE}' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done || :` },
    { name: 'untrackedBaseline', kind: 'list', cmd: LIST_UNTRACKED_CMD },
    {
      name: 'noCommentFiles',
      kind: 'list',
      cmd: `{ ${LIST_TRACKED_CMD} | sort -u | grep -v${EXCLUDE_FLAGS}E '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ! ${SCOPE === 'codebase' ? `grep -qE '${commentRe}' -- "$f"` : `${GIT} --literal-pathspecs diff ${BASE} -- "$f" | grep -qE '${addedCommentRe}'`} && echo "$f"; done; ${LIST_UNTRACKED_CMD} | grep -v${EXCLUDE_FLAGS}E '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ! grep -qE '${commentRe}' -- "$f" && echo "$f"; done; } || :`,
    },
    { name: 'baselineHash', kind: 'hash', cmd: hashCommand() },
  ]
}

const MARKER = '::section::'
const CHUNK_BYTES = 6000
const COPY_ATTEMPTS = 3
const SPLIT_DEPTH = 3

function copyBody(sections) {
  const body = sections.map((sec) => `echo '${MARKER} ${sec.name}'\n${sec.cmd}`).join('\n')
  return `cd ${shellQuote(ROOT)} && (
${body}
echo '${MARKER} end'
)`
}

function copyIntro(what) {
  return `You are a helper of the simplify workflow the user launched on the repository ${ROOT}. The workflow's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state and files; it changes nothing. The \`${MARKER}\` lines are headers the script splits the output on.`
}

const COPY_RULE = 'Return its entire output verbatim as `output`: every line, in order, nothing added, removed or reworded. The script checks the copy against a checksum. There is nothing to review in it, so you need not open any file.'

function copyPrompt(sections, what) {
  const ranges = `LC_ALL=C awk -v max=${CHUNK_BYTES} '{ l = length($0) + 1; if (n && b + l > max) { print s, NR - 1; n = 0; b = 0 } if (!n) s = NR; n++; b += l } END { if (n) print s, NR }' "$f"`
  return `${copyIntro(what)} A long output comes back cut or miscopied, so the command saves the output to a file, prints its path on a \`::file::\` line, numbers the output's lines into parts of at most ${CHUNK_BYTES} bytes, prints one \`::part::\` line per part (first line, last line, cksum), then the first part itself; other helpers fetch the remaining parts from the file.

Run exactly this shell command via Bash, unmodified, as a single call:

f=$(mktemp /tmp/simplify-copy.XXXXXX) && ${copyBody(sections)} > "$f" && r=$(${ranges}) && echo "::file:: $f" && echo "$r" | while read -r s e; do echo "::part:: $s $e $(sed -n "$s,\${e}p" "$f" | cksum)"; done && sed -n "$(echo "$r" | head -n 1 | tr ' ' ',')p" "$f"

${COPY_RULE}`
}

function chunkPrompt(file, what, start, end) {
  const slice = `sed -n '${start},${end}p' ${shellQuote(file)}`
  return `${copyIntro(what)} A long output comes back cut or miscopied, so another helper saved it to a file and it is fetched in parts; this part is lines ${start} to ${end}, after a \`::part::\` line carrying their cksum.

Run exactly this shell command via Bash, unmodified, as a single call:

echo "::part:: ${start} ${end} $(${slice} | cksum)"; ${slice}

${COPY_RULE}`
}

function parsePart(output, start, end) {
  const lines = asCopied(output)
  const at = lines.findIndex((l) => l.startsWith('::part:: '))
  const c = at < 0 ? null : /^::part:: (\d+) (\d+) (\d+) (\d+)\s*$/.exec(lines[at])
  if (!c || +c[1] !== start || +c[2] !== end) return null
  return verifyChunk(lines.slice(at + 1).join('\n'), { start, end, crc: +c[3], bytes: +c[4] })
}

function parseHead(output) {
  const lines = String(output || '').split('\n').map((l) => l.replace(/\r$/, ''))
  const at = lines.findIndex((l) => /^::file:: \/tmp\/simplify-copy\.\S+\s*$/.test(l))
  if (at < 0) return null
  const file = lines[at].trim().slice('::file:: '.length)
  const chunks = []
  let i = at + 1
  for (; i < lines.length; i++) {
    const c = /^::part:: (\d+) (\d+) (\d+) (\d+)\s*$/.exec(lines[i])
    if (c) chunks.push({ start: +c[1], end: +c[2], crc: +c[3], bytes: +c[4] })
    else if (chunks.length) break
  }
  if (!chunks.length || chunks.some((c, k) => c.start !== (k ? chunks[k - 1].end + 1 : 1) || c.end < c.start)) return null
  const first = verifyChunk(lines.slice(i).join('\n'), chunks[0])
  return first ? { file, chunks, first } : null
}

function asCopied(text) {
  return String(text || '').split('\n').map((l) => l.replace(/\r$/, ''))
}

function unfenced(lines) {
  const isFence = (l) => /^\s*```\S*\s*$/.test(l)
  const bare = lines.slice(isFence(lines[0] || '') ? 1 : 0)
  while (bare.length && bare[bare.length - 1] === '') bare.pop()
  if (bare.length && isFence(bare[bare.length - 1])) bare.pop()
  return bare
}

function withLineCount(lines, count) {
  const padded = lines.slice()
  while (padded.length > count && padded[padded.length - 1] === '') padded.pop()
  while (padded.length < count) padded.push('')
  return padded.length === count ? padded : null
}

function matchesChunk(lines, chunk) {
  const bytes = utf8(lines.map((l) => `${l}\n`).join(''))
  return bytes.length === chunk.bytes && cksum(bytes) === chunk.crc
}

function verifyChunk(text, chunk) {
  const copied = asCopied(text)
  for (const reading of [copied, unfenced(copied)]) {
    const lines = withLineCount(reading, chunk.end - chunk.start + 1)
    if (lines && matchesChunk(lines, chunk)) return lines
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
    if (current) raw[current].push(line.replace(/\r$/, ''))
  }
  if (!raw.end) return null
  const value = {}
  for (const sec of sections) {
    const lines = raw[sec.name]
    if (!lines) return null
    if (sec.kind === 'hash') {
      const hash = /^\s*([0-9a-f]{64})\b/.exec(lines.find((l) => l.trim()) || '')
      if (!hash) return null
      value[sec.name] = hash[1]
    } else {
      value[sec.name] = [...new Set(lines.map((l) => l.trim()).filter((l) => l && !l.startsWith('```')))].sort()
    }
  }
  return value
}

async function runCopy(sections, what, label, phase, opts) {
  const head = await copyAttempts(copyPrompt(sections, what), label, phase, opts, parseHead)
  if (!head.value) return head
  const { file, chunks, first } = head.value
  const rest = await joinRanges(chunks.slice(1).map((c) => () => fetchRange(file, what, c.start, c.end, label, phase, opts, 0)), label)
  if (!rest.value) return rest
  const value = parseCopy([...first, ...rest.value], sections)
  return value ? { value, error: null } : { value: null, error: `the ${label} output lacks a section marker` }
}

// A copy agent drops or repeats a line of a long list the same way on every
// retry, so a failed range is halved instead of retried, down to SPLIT_DEPTH.
async function fetchRange(file, what, start, end, label, phase, opts, depth) {
  const leaf = depth === SPLIT_DEPTH || start === end
  const r = await copyAttempts(chunkPrompt(file, what, start, end), `${label} lines ${start}-${end}`, phase, opts, (out) => parsePart(out, start, end), leaf ? COPY_ATTEMPTS : 1)
  if (r.value || leaf) return r
  const mid = Math.floor((start + end) / 2)
  return joinRanges([[start, mid], [mid + 1, end]].map(([s, e]) => () => fetchRange(file, what, s, e, label, phase, opts, depth + 1)), label)
}

async function joinRanges(thunks, label) {
  const parts = await parallel(thunks)
  const failed = parts.find((p) => !p || !p.value)
  if (failed !== undefined) return failed || { value: null, error: `a ${label} copy threw` }
  return { value: parts.flatMap((p) => p.value), error: null }
}

async function copyAttempts(prompt, label, phase, opts, parse, attempts = COPY_ATTEMPTS) {
  const failures = []
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const r = await run(prompt, { label: `${label}.${attempt}`, phase, schema: COPY_SCHEMA, ...opts })
    const declined = r && r.declined && r.declined.trim()
    const value = r && !declined ? parse(r.output) : null
    if (value) return { value, error: null }
    failures.push(!r ? 'died' : declined ? `declined to run the command (${declined})` : 'returned an output that failed its check')
  }
  return { value: null, error: `the ${label} agent failed ${attempts === 1 ? 'once' : `${attempts} times`}: ${failures.join('; ')}` }
}

function hashCommand() {
  if (SCOPE === 'codebase') {
    return '{ git ls-files -z; git ls-files -o --exclude-standard -z; } | sort -zu | xargs -0 -r sha256sum -- | sha256sum'
  }
  return `{ git diff ${BASE}...HEAD; git diff HEAD; git status --porcelain -z; git ls-files -o --exclude-standard -z | sort -z | xargs -0 -r sha256sum --; } | sha256sum`
}

const AGENT_LIMIT_ERRORS = ['WorkflowAgentCapError', 'WorkflowBudgetExceededError']

async function run(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch (err) {
    if (err && AGENT_LIMIT_ERRORS.includes(err.name)) throw err
    return null
  }
}

phase('Prepare')
const { value: prep, error: prepError } = await runCopy(prepareSections(), 'the file lists and tree hash the simplify pass starts from', 'prepare', 'Prepare', PREPARE_OPTS)
if (!prep) {
  log(`simplify skipped: ${prepError}`)
  return { skipped: 'prepare-failed', error: prepError }
}
if (prep.files.length === 0) {
  log('simplify skipped: no source file in scope after the exclusions')
  return { skipped: 'nothing-to-simplify', error: null }
}
const HASH_CMD = hashCommand()
const untrackedAtLaunch = new Set(prep.untrackedBaseline)
const noComment = new Set(prep.noCommentFiles)
const pruneable = prep.files.filter((f) => PRUNE_EXTS.some((e) => f.endsWith(e)) && !noComment.has(f))

const BATCH_SIZE = 15
const MAX_ROUNDS = 100

const override = input.model ? { model: input.model, effort: input.effort } : null
const simplifyOpts = override ?? { model: 'opus', effort: 'medium' }
const applyOpts = override ?? { ...(input.applyModel ? { model: input.applyModel.trim() } : {}), effort: 'medium' }
const seedApplyOpts = { ...(override ? { model: override.model } : input.applyModel ? { model: input.applyModel.trim() } : {}), effort: 'high' }
const commitOpts = { model: 'sonnet', effort: 'low' }
const judgeOpts = { model: 'sonnet', effort: 'high' }
const fixOpts = { model: 'opus', effort: 'high' }
const checkOpts = { model: 'haiku', effort: 'low' }

const GROUPS = ['Performance improvements', 'Code simplifications']

function simplifyPrompt(scope) {
  return `You are the FINDER in an automated code-simplification loop. Read the code in scope and return every refinement worth making as a finding. Do not edit any files.

Propose refinements that:

1. **Preserve functionality**: change only how the code does something, never what it does.

2. **Follow project standards**: apply the coding standards from CLAUDE.md/AGENTS.md and the docs they reference.

3. **Improve clarity, not compactness**: less nesting, less duplication, clearer names, related logic in one place. A switch or an if/else chain beats a nested ternary, and a helpful abstraction stays even when inlining it would save lines.

4. **Scope**: ${scope}

A finding may create a new file when extracting shared logic genuinely simplifies the code. ${PATHS_LINE}

The same files are re-examined by fresh agents every round until a round finds nothing; only then can the process finish. Returning zero findings is the expected, successful terminal state for code that is already in good shape, not a failure to contribute. Marginal, cosmetic, or judgment-call refinements never clear the bar: renaming an already-clear identifier, extracting a single-use helper, restructuring code that is already readable. Report only the refinements you are sure of.`
}

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: GROUPS },
          files: { type: 'array', items: { type: 'string' } },
          description: { type: 'string', description: 'concrete enough for another agent to implement without guessing: name the construct, what to change, and how' },
        },
        required: ['group', 'files', 'description'],
      },
    },
  },
  required: ['findings'],
}

function judgeSchema(count) {
  return {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            index: { type: 'integer', minimum: 0, maximum: count - 1, description: 'zero-based position of the item in the JSON array you judge' },
            approved: { type: 'boolean' },
            reason: { type: 'string' },
          },
          required: ['index', 'approved', 'reason'],
        },
      },
    },
    required: ['verdicts'],
  }
}

const APPLY_SCHEMA = {
  type: 'object',
  properties: {
    applied: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          group: { type: 'string', enum: GROUPS },
          description: { type: 'string', description: 'One sentence naming what changed.' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['group', 'description', 'files'],
      },
    },
    createdFiles: { type: 'array', items: { type: 'string' } },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          description: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['description', 'reason'],
      },
    },
  },
  required: ['applied', 'createdFiles'],
}

const HASH_SCHEMA = {
  type: 'object',
  properties: { hash: { type: 'string', pattern: '^[0-9a-f]{64}$' } },
  required: ['hash'],
}

const UNTRACKED_SCHEMA = {
  type: 'object',
  properties: { untracked: { type: 'array', items: { type: 'string' } } },
  required: ['untracked'],
}

const FAILURE_LIST_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      message: { type: 'string' },
    },
    required: ['file', 'message'],
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: FAILURE_LIST_SCHEMA,
  },
  required: ['passed', 'failures'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: FAILURE_LIST_SCHEMA,
  },
  required: ['passed', 'fixed', 'remaining'],
}

const NO_COMMENTS_LINE = 'Write no comments. When code needs one to be understood, reshape the code instead.'

const DELETED_COMMENT_HINT = 'The deleted comment is in the latest commits touching the file (`git --literal-pathspecs log -p -n 3 -- <file>`).'

const FAITHFUL_LINE = 'your job is faithful application, not invention.'

const NO_PROJECT_COMMANDS_LINE = 'Other agents work in this tree concurrently, so do not run project-wide commands (typecheck, build, lint, test suite).'

const PATHS_LINE = "Every path is relative to the project root, with no leading './' and never absolute."

const verdictLine = (item) => `Return one verdict per ${item}, with a one-line reason.`

const SEED_APPLY_SCHEMA = {
  type: 'object',
  properties: {
    applied: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          index: { type: 'integer', description: 'The seed\'s `index` field, as given in the Seeds JSON (not its position).' },
          description: { type: 'string', description: 'One sentence naming what changed.' },
          files: { type: 'array', items: { type: 'string' } },
          kind: { type: 'string', enum: ['reshape', 'type', 'lint', 'test', 'runtime-check'], description: 'reshape for a must-kill seed; for a constraint seed, what now enforces it.' },
          where: { type: 'string', description: 'For a constraint seed: the symbol, rule or test that enforces it. Empty for a reshape.' },
        },
        required: ['index', 'description', 'files', 'kind', 'where'],
      },
    },
    createdFiles: { type: 'array', items: { type: 'string' } },
    failed: {
      type: 'array',
      items: {
        type: 'object',
        properties: { index: { type: 'integer', description: 'The seed\'s `index` field, as given in the Seeds JSON (not its position).' }, reason: { type: 'string' } },
        required: ['index', 'reason'],
      },
    },
  },
  required: ['applied', 'createdFiles', 'failed'],
}

const COMMIT_SCHEMA = {
  type: 'object',
  properties: {
    committed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    files: { type: 'array', items: { type: 'string' } },
    discarded: { type: 'array', items: { type: 'string' }, description: 'Untracked outputs of the check command you deleted instead of committing.' },
    reason: { type: 'string', description: 'When nothing was committed, why in one sentence; empty otherwise.' },
    head: { type: 'string', description: 'The full sha `git rev-parse HEAD` prints once you are done.' },
    clean: { type: 'boolean', description: 'Whether your final `git status --porcelain` printed nothing.' },
  },
  required: ['committed', 'commitSha', 'files', 'discarded', 'reason', 'head', 'clean'],
}

const FIND_SWEEP_NOTE = `\n\nThis is a confirmation sweep: every part of the scope has settled. The expected outcome is zero findings. Report only a refinement earlier rounds clearly missed or a cross-file inconsistency they left, never a preference.`

function fileListBlock(files) {
  return files.map(f => `- ${f}`).join('\n')
}

function touchedBlock(files) {
  const shown = files.slice(0, 100)
  const extra = files.length - shown.length
  return fileListBlock(shown) + (extra > 0 ? `\n…and ${extra} more` : '')
}

function hashAgentPrompt(cmd) {
  return `Run exactly this shell command via Bash, unmodified:

${rootedCmd(cmd)}

Return the hash it prints as \`hash\`. Do not read, review, or edit any project files.`
}

async function runHash(cmd, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    const result = await run(hashAgentPrompt(cmd), {
      label: `${label}.${attempt}`,
      phase: 'Hash',
      schema: HASH_SCHEMA,
      model: 'haiku',
      effort: 'low',
    })
    if (result?.hash) return result.hash
  }
  return null
}

let discoveryFailed = false

async function discoverUntracked() {
  const result = await run(
    `Run exactly this shell command via Bash, unmodified:

${rootedCmd(`${LIST_UNTRACKED_CMD} | grep -v${EXCLUDE_FLAGS}E '${EXCLUDE}' || :`)}

Return every path it prints, verbatim, as \`untracked\`. Do not read, review, or edit any project files.`,
    { label: 'discover:untracked', phase: 'Discover', schema: UNTRACKED_SCHEMA, model: 'haiku', effort: 'low' },
  )
  if (!result) {
    discoveryFailed = true
    log('discovery agent died; undeclared new files, if any, will not be verified or have their comments stripped')
    return []
  }
  const before = new Set([...prep.untrackedBaseline, ...known])
  return result.untracked.filter(f => !before.has(f))
}

function runCheck(label) {
  return run(
    `${REPO}

Run exactly this shell command via Bash, unmodified:

${rootedCmd(input.checkCmd)}

For every failure it reports, return the implicated file path and a concise one-line message. ${PATHS_LINE} Do not edit any project files.`,
    { label, phase: 'Verify', schema: CHECK_SCHEMA, ...checkOpts },
  )
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

let simplifyVerification = input.checkCmd ? 'no-changes' : 'not-configured'
const baselineReady = (async () => {
  if (!input.checkCmd) return null
  for (let attempt = 1; attempt <= 3; attempt++) {
    const baseline = await runCheck(`check:baseline.${attempt}`)
    if (!baseline) continue
    if (!baseline.passed) {
      log(baseline.failures.length
        ? `baseline check already failing: ${baseline.failures.length} pre-existing failure(s) will be ignored`
        : 'baseline check already failing but named no file; no check failure will be attributed to this run')
    }
    return baseline
  }
  simplifyVerification = 'baseline-failed'
  log('verification disabled: baseline check failed 3 times; no check failures will be attributed to this run')
  return null
})()

let openingComments = null
let seeds = input.seeds ?? []
let startHash = prep.baselineHash
if (!input.skipComments) {
  phase('Comments')
  await baselineReady
  const { result, error } = await runChild(input.noCommentsScript, { mode: 'flags', root: ROOT, files: pruneable, ...(BASE ? { base: BASE } : {}), ...(input.checkCmd ? { checks: input.checkCmd } : {}), tag: 'opening' }, 'opening comment pass')
  openingComments = result
  const openingFailure = error
    || (result.commit?.reason === 'the commit agent died' && 'the opening comment pass\'s commit agent died, so its edits may sit uncommitted in the working tree')
    || (result.commit && result.commit.clean !== true && 'the opening comment pass\'s commit agent did not report a clean tree, so its edits may sit uncommitted in the working tree')
    || (result.commit && !result.head && 'the opening comment pass\'s commit agent reported no valid HEAD sha')
  if (openingFailure) {
    log(`simplify skipped: ${openingFailure}`)
    return { skipped: 'comments-failed', error: openingFailure, comments: { opening: result, closing: null } }
  }
  seeds = result.seeds ?? []
  if (result.commit?.committed) {
    const hash = await runHash(HASH_CMD, 'hash:tree@comments')
    if (hash) startHash = hash
    else log('hash agent could not hash the tree after the opening comment pass; the first round may read it as moved')
  }
}

const allChanges = []
const allRejected = []
const globalSeen = new Set([startHash])
let iterations = 0
let sweeps = 0
let stopReason = 'converged'
let outstandingFailures = []
let treeEdited = false
let roundApplierDispatched = false
let lastTreeHash = startHash
const filesCreatedDuringRun = []
const dispatchedTargets = new Set()
let proposedTotal = 0
let approvedTotal = 0

function runFix(label, touched, cause, baseline) {
  let baselineNote = ''
  if (baseline.failures.length) {
    baselineNote = `\n\nThese failures existed BEFORE the run and are NOT yours to fix. Do not list them in \`remaining\`:\n${baseline.failures.map(f => `- ${f.file}: ${f.message}`).join('\n')}\n\nThe command will therefore still exit non-zero at the end: \`passed\` means "no run-caused failures remain", not "the command exits 0".`
  } else if (!baseline.passed) {
    baselineNote = `\n\nThis command ALREADY exited non-zero BEFORE the run, and the baseline could not tie that failure to any file. It is NOT yours to fix and the command will still exit non-zero at the end. Report passed=true unless you can tie a specific failure to the edits this run made; do not list a failure you cannot tie to them in \`remaining\`.`
  }
  const touchedNote = touched.length ? '; the files it touched are listed below' : ''
  const traceNote = touched.length ? ', which will be in or traceable to the touched files' : ''
  const touchedSection = touched.length
    ? `\n\nFiles touched by the run:\n${touchedBlock(touched)}`
    : `\n\nWhich files the run touched could not be recorded, so nothing bounds where the breakage is.`
  return run(
    `${REPO}

Run exactly this shell command via Bash:

${rootedCmd(input.checkCmd)}

An automated ${cause} run has just edited this project${touchedNote}. If the command fails, fix the failures the run caused${traceNote}, then re-run the command, repeating until it passes or you have made three rounds of fixes. Keep every fix minimal and behavior-preserving. ${NO_COMMENTS_LINE}${baselineNote}${touchedSection}

Report \`passed\` for the final state, one line per repair in \`fixed\`, and any run-caused failures still present in \`remaining\`. ${PATHS_LINE}`,
    { label, phase: 'Verify', schema: FIX_SCHEMA, ...fixOpts },
  )
}

function fixFailures(fix, cause) {
  if (fix.passed || fix.remaining.length) return fix.remaining
  log(`${cause} fix-up reports the check still failing but listed no failure`)
  return [{ file: null, message: `check command still failing after the ${cause} fix-up, which named no specific failure` }]
}

function topDir(path) {
  return path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)'
}

function newBatch(name, group, files) {
  return { name, group, files, status: 'active', progress: 'unread', visits: 0 }
}

const isPending = (b) => b.status === 'active' || b.status === 'retrying'

const batches = []
const byDir = new Map()
for (const path of prep.files) {
  const dir = topDir(path)
  if (!byDir.has(dir)) byDir.set(dir, [])
  byDir.get(dir).push(path)
}
for (const [dir, files] of byDir) {
  for (let i = 0; i < files.length; i += BATCH_SIZE) {
    const name = files.length > BATCH_SIZE ? `${dir}#${i / BATCH_SIZE + 1}` : dir
    batches.push(newBatch(name, dir, files.slice(i, i + BATCH_SIZE)))
  }
}
log(`${prep.files.length} files across ${batches.length} batches (scope: ${input.scope})`)

const known = new Set(prep.files)

const unanalyzedFiles = []

const abandonedAfterProgress = []

const scopeNote =
  input.scope === 'codebase'
    ? ''
    : `\n\nFor each file, first run \`git --literal-pathspecs diff ${input.base} -- <file>\`, and propose changes only to the code that diff touched.`

const wholeFile = new Set(untrackedAtLaunch)

function batchScopeNote(files) {
  if (input.scope === 'codebase') return ''
  const fresh = files.filter(f => wholeFile.has(f))
  const freshNote = fresh.length
    ? `\n\nThese files are new and have no diff against ${input.base}, so treat their entire contents as in scope:\n${fileListBlock(fresh)}`
    : ''
  return (fresh.length === files.length ? '' : scopeNote) + freshNote
}

function finderPrompt(batch, isSweep) {
  const focus = `Examine ONLY these files:\n${fileListBlock(batch.files)}${batchScopeNote(batch.files)}\n\nYou may read any other project files for context. ${NO_PROJECT_COMMANDS_LINE}`
  const visitNote = batch.visits > 0 ? `\n\nThis is visit ${batch.visits + 1} to these files; previous rounds already simplified them.` : ''
  return `${REPO}\n\n` + simplifyPrompt(focus) + (isSweep ? FIND_SWEEP_NOTE : visitNote)
}

const SCOPE_TEXT = input.scope === 'codebase' ? 'the entire codebase' : `code changed relative to ${input.base}`

function judgePrompt(findings, isSweep) {
  const sweepNote = isSweep
    ? `\n\nThese proposals come from a confirmation sweep. Earlier rounds already refined this scope and every batch had settled, and an approval reopens it for another round. Judge each proposal on the same standard as any other. The sweep exists to catch what earlier rounds genuinely missed, not to relitigate choices they already made.`
    : ''
  return `${REPO}

You are the independent gatekeeper in an automated code-simplification loop. A finder agent proposed the simplifications below.

Proposals (JSON):
${JSON.stringify(findings)}

Approve a proposal only when it clearly preserves behavior and leaves the code easier to read or maintain by a margin that justifies touching settled code. Reject:
- cosmetic and preference-level changes: renaming an already-clear identifier, reshuffling already-readable code, style churn;
- abstractions or extractions that do not remove real duplication;
- proposals too vague to implement safely exactly as described.
When in doubt, reject.${sweepNote}

The scope of this loop is ${SCOPE_TEXT}; reject proposals reaching beyond it as out of scope.

Do not edit any files. ${NO_PROJECT_COMMANDS_LINE} ${verdictLine('proposal')}`
}

function applyPrompt(approved) {
  return `${REPO}

Implement the following code-simplification findings exactly as described. Each was proposed by a finder agent and validated by an independent judge; ${FAITHFUL_LINE}

Findings (JSON):
${JSON.stringify(approved)}

Preserve behavior exactly. ${NO_COMMENTS_LINE} If a finding proves unsafe or impossible as described once you see the code, skip it and record it in \`failed\` instead of improvising an alternative.

${NO_PROJECT_COMMANDS_LINE} Verify your edits by reading the code.

Report in \`applied\` only the changes you actually made, every file you created in \`createdFiles\`, and every finding you skipped in \`failed\`. ${PATHS_LINE} For files you edited, use exactly the paths as they appear in the findings above.`
}

function seedJudgePrompt(list) {
  return `${REPO}

You are the independent gatekeeper for the refactors a comment pass asked for. It deleted comments that excused surprising code and flagged the code to reshape (must-kill), and deleted comments claiming a constraint, to be enforced in code instead (constraint). ${DELETED_COMMENT_HINT}

Seeds (JSON):
${JSON.stringify(list.map(({ kind, file, symbol, description }) => ({ kind, file, symbol, description })))}

Approve a must-kill seed when a rename, an extraction, a type or a rearchitecture within scope makes the behaviour obvious without the deleted comment. Approve a constraint seed when a type, a lint rule, a test or a runtime check within scope can enforce the constraint as stated. Reject a seed that reaches beyond the scope (${SCOPE_TEXT}), that cannot be implemented as stated, or that rests on a claim the code contradicts.

Do not edit any files. ${NO_PROJECT_COMMANDS_LINE} ${verdictLine('seed')}`
}

function seedApplyPrompt(approved) {
  return `${REPO}

Implement the seeds below, in order. A comment pass flagged each one and an independent judge approved it; ${FAITHFUL_LINE}
- must-kill: reshape the named symbol (rename, extract, type or rearchitect) so the behaviour the deleted comment explained is obvious without prose. Implement the smallest root-cause fix in scope, remove every named workaround, and never bolt on symptom guards.
- constraint: encode the cheapest enforcement: a type; else a lint rule; else a test; and a runtime check only when none of those can express the constraint.

${DELETED_COMMENT_HINT} ${NO_COMMENTS_LINE} If a seed proves unsafe or impossible once you see the code, skip it and record it in \`failed\` instead of improvising an alternative. ${NO_PROJECT_COMMANDS_LINE} Verify your edits by reading the code.

Seeds (JSON, each with its index):
${JSON.stringify(approved)}

Report in \`applied\` only the seeds you actually applied, every file you created in \`createdFiles\`, and every seed you skipped in \`failed\`. ${PATHS_LINE}`
}

function commitPrompt(summary) {
  const checkOutputs = input.checkCmd
    ? `, except outputs of this check command, which the workflow ran:\n\n${input.checkCmd}\n\nDelete every untracked path that command wrote, such as build output, a coverage report, test results or a cache, before staging. ${PATHS_LINE} Stage everything else`
    : '. Stage them all'
  return `${REPO}

The simplify workflow has just edited this repository, which was clean when it started, so every path \`git status --porcelain --untracked-files=all\` lists is its own${checkOutputs} with \`git add -A\` and \`git commit\` with a message in the project's commit convention (read \`git log --format=%s -n 20\` and the agent docs, CLAUDE.md or AGENTS.md), with no attribution lines or trailers. The subject says the code was simplified; the body may list the changes:
${summary || '- (no change was recorded; check failures may have been repaired)'}

Finish with \`git status --porcelain\` and make sure nothing remains dirty.`
}

function assignNewFile(path) {
  const dir = topDir(path)
  const target = batches.find(b => b.group === dir && b.status !== 'abandoned' && b.files.length < BATCH_SIZE)
  if (target) {
    target.files.push(path)
    if (target.status === 'settled') target.status = 'active'
    log(`new file ${path} joins batch ${target.name}`)
  } else {
    const existing = batches.filter(b => b.group === dir).length
    const name = existing ? `${dir}#${existing + 1}` : dir
    batches.push(newBatch(name, dir, [path]))
    log(`new file ${path} opens new batch ${name}`)
  }
}

function serialQueue() {
  let tail = Promise.resolve()
  return (task) => {
    const done = tail.then(task)
    tail = done.catch(() => undefined)
    return done
  }
}

function fileQueue() {
  const tails = new Map()
  return (files, task) => {
    const keys = [...new Set(files)]
    const done = Promise.all(keys.map(f => tails.get(f))).then(task)
    const settled = done.catch(() => undefined)
    for (const f of keys) tails.set(f, settled)
    return done
  }
}

const seedChanges = []
const seedRejected = []
const seedFailed = []
let seedsApproved = 0
if (seeds.length) {
  phase('Seeds')
  const groups = new Map()
  for (const [index, seed] of seeds.entries()) {
    const owner = batches.find(b => b.files.includes(seed.file))
    const key = owner ? owner.name : '(outside the scope)'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push({ index, ...seed })
  }
  log(`seed stage: ${seeds.length} seed(s) in ${groups.size} group(s)`)
  const applySerially = serialQueue()
  let seedDispatched = false
  await pipeline(
    [...groups.entries()],
    ([name, list]) => run(seedJudgePrompt(list), { label: `judge:seeds ${name}`, phase: 'Seeds', schema: judgeSchema(list.length), ...judgeOpts })
      .then(j => ({ name, list, verdicts: j })),
    (prev) => {
      if (!prev.verdicts) {
        for (const seed of prev.list) seedFailed.push({ ...seed, reason: 'the judge died' })
        return null
      }
      const approved = []
      prev.list.forEach((seed, i) => {
        const v = prev.verdicts.verdicts.find(x => x.index === i)
        if (v?.approved) approved.push(seed)
        else seedRejected.push({ ...seed, reason: v?.reason ?? 'no verdict returned' })
      })
      if (!approved.length) return null
      seedsApproved += approved.length
      treeEdited = true
      seedDispatched = true
      for (const seed of approved) dispatchedTargets.add(seed.file)
      return applySerially(() => baselineReady.then(() => run(seedApplyPrompt(approved), { label: `apply:seeds ${prev.name}`, phase: 'Seeds', schema: SEED_APPLY_SCHEMA, ...seedApplyOpts }))).then((r) => {
        if (!r) {
          for (const seed of approved) seedFailed.push({ ...seed, reason: 'the applier died' })
          return
        }
        for (const a of r.applied) {
          const seed = approved.find(x => x.index === a.index)
          if (!seed) continue
          seedChanges.push({ kind: seed.kind, symbol: seed.symbol, seed: seed.description, description: a.description, files: a.files, enforcedBy: seed.kind === 'constraint' ? { kind: a.kind, where: a.where } : null })
        }
        for (const f of r.failed) {
          const seed = approved.find(x => x.index === f.index)
          if (seed) seedFailed.push({ ...seed, reason: f.reason })
        }
        const reported = new Set([...r.applied, ...r.failed].map(x => x.index))
        for (const seed of approved) {
          if (!reported.has(seed.index)) seedFailed.push({ ...seed, reason: 'the applier did not report it' })
        }
        const created = (r.createdFiles ?? []).filter(f => !known.has(f))
        for (const f of created.filter(f => !EXCLUDE_RE.test(f))) {
          known.add(f)
          wholeFile.add(f)
          assignNewFile(f)
        }
        filesCreatedDuringRun.push(...created)
      })
    },
  )
  if (seedDispatched) {
    const hash = await runHash(HASH_CMD, 'hash:tree@seeds')
    if (hash) {
      globalSeen.add(hash)
      lastTreeHash = hash
    } else {
      lastTreeHash = null
      log('hash agent could not hash the tree after the seed stage; the first round hashes it again')
    }
  }
  log(`seed stage: ${seedsApproved} approved, ${seedChanges.length} applied, ${seedRejected.length} rejected, ${seedFailed.length} failed`)
}

while (true) {
  if (iterations >= MAX_ROUNDS) {
    stopReason = 'max-iterations'
    break
  }
  let targets = batches.filter(isPending)
  const isSweep = targets.length === 0
  if (isSweep) targets = batches.filter(b => b.status !== 'abandoned')
  if (targets.length === 0) {
    const anyRead = batches.some(b => b.progress !== 'unread')
    stopReason = anyRead || treeEdited ? 'all-batches-abandoned-after-progress' : 'all-batches-abandoned'
    if (!anyRead) {
      log(treeEdited
        ? 'every batch was abandoned before any round completed, so nothing was analysed; only the seed appliers were dispatched, so seeds.applied covers their work'
        : 'every batch was abandoned before any round completed, so nothing was analysed')
    } else {
      log(roundApplierDispatched
        ? 'every remaining batch was abandoned after repeated agent deaths; earlier rounds analysed part of the scope and an applier was dispatched, so the summary covers the work done so far'
        : treeEdited
          ? 'every remaining batch was abandoned after repeated agent deaths; earlier rounds analysed part of the scope without dispatching an applier; only the seed appliers were dispatched, so seeds.applied covers their work'
          : 'every remaining batch was abandoned after repeated agent deaths; earlier rounds analysed part of the scope without recording any change')
    }
    break
  }
  iterations++
  if (isSweep) {
    sweeps++
    log(`round ${iterations}: confirmation sweep ${sweeps} over ${targets.length} batches`)
  } else {
    log(`round ${iterations}: ${targets.length}/${batches.length} batches active`)
  }

  let roundDispatched = false
  const applyExclusively = fileQueue()
  const results = await pipeline(
    targets,
    batch =>
      run(finderPrompt(batch, isSweep), {
        label: `find:${batch.name}@${iterations}`,
        phase: 'Find',
        schema: FINDINGS_SCHEMA,
        ...simplifyOpts,
      }),
    (found, batch) => {
      if (!found) return { status: 'finder-dead' }
      if (batch.progress === 'unread') batch.progress = 'read'
      if (found.findings.length === 0) return { status: 'clean' }
      return run(judgePrompt(found.findings, isSweep), {
        label: `judge:${batch.name}@${iterations}`,
        phase: 'Judge',
        schema: judgeSchema(found.findings.length),
        ...judgeOpts,
      }).then(j => ({ status: 'judged', findings: found.findings, verdicts: j }))
    },
    (prev, batch) => {
      if (!prev || prev.status !== 'judged') return prev
      if (!prev.verdicts) return { status: 'judge-dead' }
      const approved = []
      const rejected = []
      prev.findings.forEach((finding, i) => {
        const verdict = prev.verdicts.verdicts.find(v => v.index === i)
        if (verdict?.approved) {
          approved.push(finding)
        } else {
          rejected.push({ ...finding, reason: verdict?.reason ?? 'no verdict returned' })
        }
      })
      if (approved.length === 0) return { status: 'all-rejected', proposed: prev.findings.length, rejected }
      treeEdited = true
      roundApplierDispatched = true
      roundDispatched = true
      batch.progress = 'edited'
      const approvedFiles = approved.flatMap(f => f.files ?? [])
      for (const file of approvedFiles) dispatchedTargets.add(file)
      return applyExclusively(approvedFiles, () => baselineReady.then(() => run(applyPrompt(approved), {
        label: `apply:${batch.name}@${iterations}`,
        phase: 'Apply',
        schema: APPLY_SCHEMA,
        ...applyOpts,
      }))).then(r => ({ status: 'applied', proposed: prev.findings.length, approved: approved.length, rejected, report: r }))
    },
  )
  await baselineReady

  const newFiles = []
  const revived = new Set()
  let roundApplied = 0
  let roundHadDead = false
  for (let i = 0; i < targets.length; i++) {
    const batch = targets[i]
    const r = results[i]
    if (!r || r.status === 'finder-dead' || r.status === 'judge-dead' || (r.status === 'applied' && !r.report)) {
      roundHadDead = true
      batch.status = batch.status === 'retrying' ? 'abandoned' : 'retrying'
      if (batch.status === 'abandoned') {
        if (batch.progress === 'unread') {
          unanalyzedFiles.push(...batch.files)
          log(`batch ${batch.name} abandoned after 2 dead agents; its files were never analysed`)
        } else if (batch.progress === 'edited') {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after 2 dead agents; an applier was dispatched to it, so its files may have been edited without being reported`)
        } else {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after 2 dead agents; a finder did read its files, so they are not listed as unanalysed`)
        }
      }
      if (r?.proposed) proposedTotal += r.proposed
      if (r?.approved) approvedTotal += r.approved
      if (r?.rejected) allRejected.push(...r.rejected)
      continue
    }
    if (!isSweep) batch.visits++
    if (r.status === 'clean') {
      batch.status = 'settled'
      continue
    }
    if (r.status === 'all-rejected') {
      proposedTotal += r.proposed
      allRejected.push(...r.rejected)
      batch.status = 'settled'
      continue
    }
    proposedTotal += r.proposed
    approvedTotal += r.approved
    allRejected.push(...(r.rejected ?? []))
    const report = r.report
    const applied = report.applied ?? []
    roundApplied += applied.length
    batch.status = applied.length > 0 ? 'active' : 'settled'
    if ((report.failed ?? []).length) {
      log(`batch ${batch.name}: ${report.failed.length} approved finding(s) could not be applied`)
    }
    const created = (report.createdFiles ?? []).filter(f => !known.has(f))
    for (const f of created.filter(f => !EXCLUDE_RE.test(f))) {
      known.add(f)
      wholeFile.add(f)
      newFiles.push(f)
    }
    filesCreatedDuringRun.push(...created)
    for (const change of applied) {
      for (const f of change.files ?? []) {
        if (!known.has(f)) continue
        const owner = batches.find(b => b !== batch && b.status !== 'abandoned' && b.files.includes(f))
        if (owner) revived.add(owner)
      }
    }
    allChanges.push(...applied)
  }
  for (const b of revived) if (b.status === 'settled') b.status = 'active'
  for (const f of newFiles) assignNewFile(f)

  const treeHash = roundDispatched || !lastTreeHash ? await runHash(HASH_CMD, `hash:tree@${iterations}`) : lastTreeHash
  if (!treeHash) {
    stopReason = 'hash-unavailable'
    log(`round ${iterations}: hash agent could not return a hash, so convergence cannot be confirmed; stopping and reporting the work done so far`)
    break
  }
  lastTreeHash = treeHash
  if (globalSeen.has(treeHash)) {
    if (isSweep && roundApplied === 0 && !roundHadDead) {
      stopReason = 'converged'
      log(`round ${iterations}: sweep confirms convergence; no findings survived judging`)
      break
    }
    log(`round ${iterations}: no new tree state`)
  } else {
    globalSeen.add(treeHash)
    log(`round ${iterations}: tree changed (${roundApplied} changes applied)`)
  }
}

function touchedFiles() {
  const reportedEdits = [...allChanges, ...seedChanges].flatMap(c => c.files ?? [])
  const dispatchedInScope = [...dispatchedTargets].filter(f => known.has(f))
  return [...new Set([...reportedEdits, ...dispatchedInScope, ...filesCreatedDuringRun])]
}

const baseline = await baselineReady
const openingFiles = openingComments?.commit?.committed ? openingComments.commit.files : []
const treeMoved = globalSeen.size > 1 || openingFiles.length > 0 || (treeEdited && stopReason === 'hash-unavailable')
let undeclaredFiles = []
if (treeMoved) {
  undeclaredFiles = await discoverUntracked()
  if (undeclaredFiles.length) log(`${undeclaredFiles.length} file(s) appeared during the run without being declared: ${touchedBlock(undeclaredFiles)}`)
}

let fixEdited = false
if (baseline && treeMoved) {
  const touched = [...new Set([...touchedFiles(), ...openingFiles, ...undeclaredFiles])]
  const fix = await runFix('fix:simplify', touched, 'code-simplification', baseline)
  if (!fix) {
    simplifyVerification = 'fixup-died'
    log('fix-up agent died; project state unverified')
  } else {
    simplifyVerification = 'ran'
    outstandingFailures = fixFailures(fix, 'code-simplification')
    if (fix.fixed.length) {
      fixEdited = true
      log(`fix-up repaired ${fix.fixed.length} issue(s)`)
    }
    if (fix.remaining.length) {
      log(`fix-up leaves ${fix.remaining.length} failure(s) unresolved`)
    }
  }
}

phase('Commit')
const commitSummary = [
  ...seedChanges.map(c => `- ${c.description}`),
  ...allChanges.map(c => `- ${firstSentence(c.description)}`),
].slice(0, 40).join('\n')
const commitResult = await run(commitPrompt(commitSummary), { label: 'commit simplify', phase: 'Commit', schema: COMMIT_SCHEMA, ...commitOpts })
const commit = commitResult
  ? { committed: commitResult.committed === true, commitSha: commitResult.committed ? commitResult.commitSha : null, files: commitResult.files || [], discarded: commitResult.discarded || [], reason: commitResult.reason || null, clean: commitResult.clean === true }
  : { committed: false, commitSha: null, files: [], discarded: [], reason: 'the commit agent died', clean: false }
let head = commitResult && /^[0-9a-f]{7,64}$/.test(commitResult.head || '') ? commitResult.head : null
log(commit.committed ? `simplify committed as ${commit.commitSha} (${commit.files.length} file(s))` : `simplify committed nothing: ${commit.reason}`)
const isDiscarded = (f) => commit.discarded.some(d => f === d || f.startsWith(d.replace(/\/*$/, '/')))
undeclaredFiles = undeclaredFiles.filter(f => !isDiscarded(f))
filesCreatedDuringRun.push(...undeclaredFiles)

const sourceTouched = touchedFiles().filter(f => !EXCLUDE_RE.test(f))
const commentFiles = sourceTouched.filter(f => PRUNE_EXTS.some((e) => f.endsWith(e)))
let closingComments = null
let closingSkipped = null
let closingError = null
if (input.skipComments) {
  closingSkipped = 'run by the caller'
} else if (stopReason !== 'converged') {
  closingSkipped = 'simplification never converged'
} else if (!head) {
  closingSkipped = commitResult ? 'the commit agent reported no valid HEAD sha, so the tree may be dirty' : 'the commit agent died, so the tree may be dirty'
} else if (commitResult.clean !== true) {
  closingSkipped = 'the commit agent did not report a clean tree'
} else if (commentFiles.length) {
  phase('Comments')
  const closingBase = openingComments?.head || BASE
  const { result, error } = await runChild(input.noCommentsScript, { mode: 'delete-only', root: ROOT, files: commentFiles, ...(closingBase ? { base: closingBase } : {}), tag: 'closing' }, 'closing comment pass')
  closingComments = result
  closingError = error
  if (error) log(`closing comment pass failed: ${error}`)
  if (result?.head) head = result.head
}

const edited = allChanges.length > 0 || seedChanges.length > 0 || globalSeen.size > 1
const editedSinceStart = edited || openingFiles.length > 0
const editPossible = stopReason === 'hash-unavailable'
const verificationLost = (s) => s === 'baseline-failed' || s === 'fixup-died'
const unverified = verificationLost(simplifyVerification)
const noCheck = simplifyVerification === 'not-configured' && (editedSinceStart || editPossible)

const reportLines = []
const say = (text, prominent = false) => reportLines.push({ text, prominent })
const paths = (files) => files.map(f => `\`${f}\``).join(', ')

if (stopReason === 'all-batches-abandoned') {
  say('Every batch was abandoned because its agents kept dying or were skipped, so the scope was never analysed at all: nothing converged, and nothing is known about the shape of the code.', true)
}
if (stopReason === 'all-batches-abandoned-after-progress') {
  say('The loop stopped because every remaining batch\'s agents kept dying or were skipped, so convergence was never confirmed.')
  const anyRead = batches.some(b => b.progress !== 'unread')
  if (!anyRead) say('No round analysed the scope; only the seed appliers ran.')
  if (globalSeen.size > 1) say('The tree was left edited.')
  else if (anyRead) say('Earlier rounds analysed part of the scope without recording any change.')
}
function unsettled(phaseName, reason, changed) {
  if (reason === 'max-iterations') say(`The ${phaseName} phase did not settle within ${MAX_ROUNDS} rounds; the summary covers the work done so far.`)
  else if (reason === 'hash-unavailable') say(`The hash agent could not return a hash during the ${phaseName} phase, so its convergence could not be confirmed; the summary covers the work done so far.`)
  else return
  if (changed) say('The tree was edited.')
  else if (reason === 'max-iterations') say('Nothing was recorded as changed, and the final state could not be confirmed.')
  else say('Nothing was recorded as changed, an edit could not be ruled out, and the final state could not be confirmed.')
}
unsettled('simplify', stopReason, edited)
if (!input.skipComments && closingSkipped && commentFiles.length) say(`The closing comment pass did not run: ${closingSkipped}, so the comments the appliers wrote are still in the tree.`)
if (closingError) say(`The closing comment pass failed (${closingError}), so the comments the appliers wrote may still be in the tree.`)
if (closingComments?.commit?.reason === 'the commit agent died') say('The closing comment pass\'s commit agent died, so its comment deletions may sit uncommitted in the working tree.', true)
else if (closingComments?.commit && closingComments.commit.clean !== true) say('The closing comment pass\'s commit agent did not report a clean tree, so its comment deletions may sit uncommitted in the working tree.', true)
else if (closingComments?.commit && !closingComments.head) say('The closing comment pass\'s commit agent reported no valid HEAD sha, so the reported head may predate its commit.')
if (seedFailed.length) say(`${seedFailed.length} seed(s) were never applied, because their judge or applier died or the applier skipped them; they are listed under \`seeds.failed\`.`)
if (!commit.committed && commit.reason === 'the commit agent died' && (edited || fixEdited || editPossible)) say('The commit agent died, so the run\'s changes sit uncommitted in the working tree.', true)
else if (commitResult && !commit.clean) say('The commit agent did not report a clean tree, so some of the run\'s changes may sit uncommitted in the working tree.', true)
if (unanalyzedFiles.length) {
  say(`These files were never analysed because their batch's agents kept dying or were skipped${stopReason.startsWith('all-batches-abandoned') ? '' : ', so the rest of the scope could still converge'}: ${paths(unanalyzedFiles)}.`)
}
if (abandonedAfterProgress.length) {
  say(`These files' batch was dropped after repeated agent deaths, so the loop never confirmed they had settled and the scope as a whole cannot be said to have converged: ${paths(abandonedAfterProgress)}.`)
}
if (discoveryFailed) say('The workflow could not list the files created during the run, so any an apply agent created without reporting were neither verified nor had their comments stripped.')
else if (undeclaredFiles.length) say(`An apply agent created these files without reporting them, so they were never simplified: ${paths(undeclaredFiles)}.`)
if (unverified) {
  say(`The project was never verified: run the check command manually; an empty list of check failures proves nothing.`, true)
  if (editedSinceStart) say('The project was edited without verification.', true)
  else if (editPossible) say('An edit cannot be ruled out and was not verified.', true)
}
if (baseline && (!baseline.passed || baseline.failures.length > 0)) {
  say('The project\'s check was already failing before the run; those failures were left alone and are still there, so no new failure means only that the run caused none. The project does not pass its check.')
}
if (noCheck) {
  say('No check command could be found for this project, so the absence of check failures means nothing: verify every change the run made, including any it already committed, before relying on or pushing them.', true)
  if (editedSinceStart) say('The edits were never verified by anything.', true)
  else if (editPossible) say('Anything the run may have edited was never verified.', true)
}

const summary = {}
for (const group of GROUPS) summary[group] = []
for (const change of allChanges) {
  const group = GROUPS.includes(change.group) ? change.group : 'Code simplifications'
  summary[group].push({ description: firstSentence(change.description), files: change.files })
}

const REJECTED_SHOWN = 10

function firstSentence(text) {
  const s = String(text || '')
  const end = s.search(/(?<!\b(?:[eE]\.g|[iI]\.e|[vV]s|[eE]tc|[cC]f))[.!?](?=\s+[A-Z`]|\s*$)/)
  const first = end >= 0 ? s.slice(0, end + 1) : s
  return first.length > 300 ? `${first.slice(0, 300)}…` : first
}

return {
  iterations,
  sweeps,
  stopReason,
  findingsProposed: proposedTotal,
  findingsApproved: approvedTotal,
  changesApplied: allChanges.length,
  rejectedTotal: allRejected.length,
  rejectedFindings: allRejected.slice(0, REJECTED_SHOWN).map(({ description, files, reason }) => ({ description: firstSentence(description), files, reason })),
  unresolvedCheckFailures: outstandingFailures,
  seeds: {
    proposed: seeds.length,
    approved: seedsApproved,
    applied: seedChanges,
    rejected: seedRejected.map(({ kind, file, symbol, description, reason }) => ({ kind, file, symbol, description, reason })),
    failed: seedFailed.map(({ kind, file, symbol, description, reason }) => ({ kind, file, symbol, description, reason })),
  },
  comments: { opening: openingComments, closing: closingComments },
  commit,
  head,
  touchedFiles: sourceTouched,
  reportLines,
  summary,
}
