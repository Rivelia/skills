export const meta = {
  name: 'simplify-converge',
  description: 'Loop simplification rounds (find, judge, apply) over a scope until fresh finders come up empty, then prune non-useful comments once converged',
  phases: [
    { title: 'Prepare', detail: 'Sonnet runs the commands listing the scope, the untracked files and the source files with no comment in scope, and hashes the tree', model: 'sonnet' },
    { title: 'Find', detail: 'read-only agents propose simplifications per batch', model: 'opus' },
    { title: 'Judge', detail: 'independent gatekeepers strike proposals that are not genuine improvements', model: 'opus' },
    { title: 'Apply', detail: 'implement the approved findings per batch' },
    { title: 'Hash', detail: 'deterministic tree hash after each round an applier ran in, and each prune pass', model: 'sonnet' },
    { title: 'Discover', detail: 'list untracked files the appliers did not declare', model: 'sonnet' },
    { title: 'Verify', detail: 'project check command: baseline on sonnet, then an opus fix-up agent after each editing phase', model: 'opus' },
    { title: 'Prune', detail: 'audit and delete non-useful comments per file batch', model: 'opus' },
  ],
}

// Never resume a dead run with resumeFromRunId: the cache key of each agent
// call chains every call issued before it, and the judges and appliers issue
// theirs in the order the finders finish, so a resume misses partway through
// and re-runs the rest live against a tree that already holds the edits.
// Relaunch instead.
const FOCUS = {
  uncommitted: 'Focus on the uncommitted changes.',
  branch: 'Focus on the full working-tree diff against the base branch.',
  unpushed: 'Focus on the unpushed work: the full working-tree diff against the remote-tracking base, covering unpushed commits and uncommitted changes.',
  codebase: 'Focus on the entire codebase.',
}

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !FOCUS[input.scope]) {
  throw new Error('args.scope must be one of uncommitted, branch, unpushed, codebase')
}
if (!input.root) throw new Error('root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('uncommitted/branch/unpushed scope requires base (the commit bounding the diff)')
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
if (input.model && !EFFORTS.includes(input.effort)) {
  throw new Error(`when model is overridden, effort must also be chosen: one of ${EFFORTS.join(', ')}`)
}

// The prune candidates are the files carrying one of these extensions, and a
// file that appears mid-run is judged by them too.
if (!Array.isArray(input.pruneExts) || input.pruneExts.length === 0) {
  throw new Error('pruneExts: string[] is required, the comment-carrying source extensions of this repo, e.g. [".ts", ".js", ".svelte"]')
}
if (input.excludePattern !== undefined && (typeof input.excludePattern !== 'string' || !input.excludePattern.trim() || input.excludePattern.includes("'"))) {
  throw new Error('excludePattern: a non-empty extended regex with no single quote (it is embedded in single quotes in a shell command) when given; omit it to keep the default')
}

// Agents start in the session's directory, which is not the root when the run
// targets a worktree; a prompt without the root sends them to the wrong tree.
const shellQuote = s => `'${s.replace(/'/g, `'\\''`)}'`
const QUOTED_ROOT = shellQuote(input.root)
const REPO = `Repository (the project root): ${input.root}. Run every command from there (\`cd ${QUOTED_ROOT}\` first, or \`git -C ${QUOTED_ROOT}\`); every relative path is relative to it.`

// A literal command runs in a subshell after the cd, so an `a || b` inside it
// cannot run b elsewhere when the cd fails, and a trailing comment cannot
// swallow the closing parenthesis.
function rootedCmd(cmd) {
  return `cd ${QUOTED_ROOT} && (\n${cmd}\n)`
}

// A narrower override than [model effort]: it sets the appliers' model only,
// which otherwise inherits the session model, and leaves their medium effort
// and every other agent alone. The full override wins when both are given.
if (input.applyModel !== undefined && (typeof input.applyModel !== 'string' || !input.applyModel.trim())) {
  throw new Error('applyModel: a model name (e.g. opus, sonnet, haiku) when given; omit it to run the appliers on the session model')
}

// ---------- the launch state, computed here ----------

// The launching session names the scope and the exclusions; the lists and the
// baseline hash are read here, so a scope of thousands of files never passes
// through its context.

// Described in SKILL.md step 3 of this skill and of merge-ready; the launching
// session reads it here only to override it.
const DEFAULT_EXCLUDE = '(^|/)(node_modules|vendor|third_party|dist|build|target|generated)/|\\.min\\.|(^|/)(package-lock\\.json|yarn\\.lock|pnpm-lock\\.yaml|Cargo\\.lock|poetry\\.lock|go\\.sum)$|\\.(json|jsonl|csv|tsv|md|mdx|lock|snap|svg|png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|otf|eot|zip|gz|wasm|so|dylib|dll|exe|bin)$'
const SCOPE = input.scope
const ROOT = input.root
const BASE = input.base || null
const EXCLUDE = input.excludePattern ? input.excludePattern.trim() : DEFAULT_EXCLUDE
const PRUNE_EXTS = input.pruneExts.map((e) => (e.startsWith('.') ? e : `.${e}`))
const GIT = 'git -c core.quotePath=false'
const LIST_TRACKED_CMD = SCOPE === 'codebase' ? `${GIT} ls-files` : `${GIT} diff --name-only ${BASE}`
const PREPARE_OPTS = { model: 'sonnet', effort: 'low' }

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
  return [
    { name: 'files', kind: 'list', cmd: `{ ${LIST_TRACKED_CMD}; ${GIT} ls-files -o --exclude-standard; } | sort -u | grep -vE '${EXCLUDE}' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done || :` },
    { name: 'untrackedBaseline', kind: 'list', cmd: `${GIT} ls-files -o --exclude-standard` },
    // The complement of the prune candidates among the source files: most
    // source files carry a comment, so in a codebase scope this list is far
    // shorter than the candidates it stands for, and the copy agents copy it
    // instead.
    {
      name: 'noCommentFiles',
      kind: 'list',
      cmd: `{ ${LIST_TRACKED_CMD} | sort -u | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ! ${SCOPE === 'codebase' ? `grep -qE '(//|/\\*|<!--)' "$f"` : `${GIT} diff ${BASE} -- "$f" | grep -qE '^\\+.*(//|/\\*|<!--)'`} && echo "$f"; done; ${GIT} ls-files -o --exclude-standard | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ! grep -qE '(//|/\\*|<!--)' "$f" && echo "$f"; done; } || :`,
    },
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
  return `You are a helper of the simplify workflow the user launched on the repository ${ROOT}. The workflow's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state and files; it changes nothing. The \`${MARKER}\` lines are headers the script splits the output on.`
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

// The first copy runs the command and lays out the parts; the parts past the
// first are copied in parallel. A copy that fails its check is retried once;
// the second failure ends the step. A refusal is one agent's judgement of the
// harness's framing, which its siblings with the same prompt did not share, so
// it is retried like any other failed copy.
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
  const failures = []
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await run(prompt, { label: `${label}.${attempt}`, phase, schema: COPY_SCHEMA, ...opts })
    const declined = r && r.declined && r.declined.trim()
    const value = r && !declined ? parse(r.output) : null
    if (value) return { value, error: null }
    failures.push(!r ? 'died' : declined ? `declined to run the command (${declined})` : 'returned an output that failed its check')
  }
  return { value: null, error: `the ${label} agent ${failures[0] === failures[1] ? `${failures[0]} twice` : `${failures[0]}, then ${failures[1]}`}` }
}

function hashCommand() {
  if (SCOPE === 'codebase') {
    return '{ git ls-files -z; git ls-files -o --exclude-standard -z; } | sort -zu | xargs -0 -r sha256sum | sha256sum'
  }
  return `{ git diff ${BASE}...HEAD; git diff HEAD; git status --porcelain -z; git ls-files -o --exclude-standard -z | sort -z | xargs -0 -r sha256sum; } | sha256sum`
}

// agent() resolves to null for a skipped or dead agent and throws once a
// user-set token budget is exhausted; both end the step the same way.
async function run(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch {
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
// The prune candidates: the source files in scope whose diff adds a comment
// (whole files for untracked ones and for codebase), split by whether they
// were untracked at launch.
const untrackedAtLaunch = new Set(prep.untrackedBaseline)
const noComment = new Set(prep.noCommentFiles)
const pruneable = prep.files.filter((f) => PRUNE_EXTS.some((e) => f.endsWith(e)) && !noComment.has(f))
const trackedPruneFiles = pruneable.filter((f) => !untrackedAtLaunch.has(f))
const untrackedPruneFiles = pruneable.filter((f) => untrackedAtLaunch.has(f))

const BATCH_SIZE = 15
const MAX_ROUNDS = 100

// The user's [model effort] override drives every phase except the judge and
// the verify phase, which stay fixed so the gate and the repair are independent
// of how cheap the run was asked to be.
const override = input.model ? { model: input.model, effort: input.effort } : null
const simplifyOpts = override ?? { model: 'opus', effort: 'medium' }
const applyOpts = override ?? { ...(input.applyModel ? { model: input.applyModel.trim() } : {}), effort: 'medium' }
const pruneOpts = override ?? { model: 'opus', effort: 'medium' }
const judgeOpts = { model: 'opus', effort: 'high' }
const checkOpts = { model: 'sonnet', effort: 'low' }

const GROUPS = ['Performance improvements', 'Code simplifications', 'Bug fixes']

const SIMPLIFY = `You are the FINDER in an automated code-simplification loop. Read the code in scope and return every refinement worth making as a finding. Do not edit any files; separate agents apply the findings.

Propose refinements that:

1. **Preserve functionality**: change only how the code does something, never what it does. All original features, outputs, and behaviors must remain intact.

2. **Follow project standards**: apply the coding standards from CLAUDE.md/AGENTS.md and the docs they reference: naming, imports, error handling, everything they establish.

3. **Improve clarity, not compactness**: less nesting, less duplication, clearer names, related logic in one place. Readable and maintainable beats clever and short: a switch or an if/else chain beats a nested ternary, and a helpful abstraction stays even when inlining it would save lines.

4. **Scope**: $ARGUMENTS

Each finding names the group it belongs to (${GROUPS.join(', ')}), the files involved, and a description concrete enough for another agent to implement without seeing your reasoning: name the construct and state exactly what to change and how. A finding may involve creating a new file when extracting shared logic genuinely simplifies the code.

The same files are re-examined by fresh agents every round until a round finds nothing; only then can the process finish. Returning zero findings is the expected, successful terminal state for code that is already in good shape, not a failure to contribute. Marginal, cosmetic, or judgment-call refinements never clear the bar: renaming an already-clear identifier, extracting a single-use helper, restructuring code that is already readable. If you find yourself weighing whether a particular change is worth proposing, drop that change and report only the ones you are sure of.`

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
            index: { type: 'integer', minimum: 0, maximum: count - 1, description: 'zero-based position of the proposal in the Proposals array' },
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

const SCOPE_INSTRUCTIONS = {
  uncommitted: (base) => `First run \`git diff ${base} -- <file>\` to see the uncommitted changes, then Read the current file. Audit ONLY comments added or modified by those changes (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  branch: (base) => `First run \`git diff ${base} -- <file>\` to see what this branch changed, then Read the current file. Audit ONLY comments added or modified by this branch (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  unpushed: (base) => `First run \`git diff ${base} -- <file>\` to see the unpushed changes (unpushed commits plus uncommitted work), then Read the current file. Audit ONLY comments added or modified by those changes (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  codebase: () => `Read the current file. Audit EVERY comment in it.`,
}

const RULES = `A comment may stay only if it is one of:
1. API documentation (JSDoc or docstring) on a function, type or module.
2. A directive a tool reads: lint or type-checker suppressions, formatter pragmas, build tags, license headers.
3. Context the code cannot show and a reader needs: an external constraint, a protocol or platform quirk, a security reason, a non-obvious invariant. Before keeping a comment under this rule, name the line a reader would misread, or break on their next edit, if the comment were gone. If no line comes to mind, rule 3 does not apply.

Everything else goes, in particular:
- Restating what the code does.
- History: how the code came to be rather than what it is. What it replaced, what it used to do, what was removed, which bug or review prompted the change. A comment that would read as pointless or confusing to someone who never saw the previous version is history, whatever its tense.
- Decisions: why the code does not do something, or why this design won over an alternative that is not in the file. "X is a Y, not a Z" is a decision when no Z exists in the file. Such a comment can be true, well written and impossible to infer, and still belong in the commit message or an ADR rather than beside the code. This is the kind most often kept by mistake.
- Section markers, narration, and commented-out code.

The code is the source of truth; a comment stays only when the code cannot carry that information.`

const PRUNE_SCHEMA = {
  type: 'object',
  required: ['removed'],
  properties: {
    removed: { type: 'number' },
  },
}

const FIND_SWEEP_NOTE = `\n\nThis is a confirmation sweep: every part of the scope has settled and this pass exists to confirm nothing was missed. The expected outcome is zero findings. Report only a clear defect or a cross-file inconsistency left by earlier rounds, never a preference.`

function fileListBlock(files) {
  return files.map(f => `- ${f}`).join('\n')
}

function touchedBlock(files) {
  const shown = files.slice(0, 100)
  const extra = files.length - shown.length
  return fileListBlock(shown) + (extra > 0 ? `\n…and ${extra} more` : '')
}

function hashAgentPrompt(cmd) {
  return `${REPO}

Run exactly this shell command via Bash, unmodified:

${rootedCmd(cmd)}

Return the 64-character hex hash it prints (the first field of its output) as \`hash\`. Do not read, review, or edit any project files.`
}

async function runHash(cmd, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let result
    // agent() throws once a user-set token budget is exhausted, and that throw
    // repeats deterministically, so the attempts stop here rather than burning
    // the remaining two on the same wall.
    try {
      result = await agent(hashAgentPrompt(cmd), {
        label: `${label}.${attempt}`,
        phase: 'Hash',
        schema: HASH_SCHEMA,
        model: 'sonnet',
        effort: 'low',
      })
    } catch {
      return null
    }
    if (result?.hash) return result.hash
  }
  return null
}

// An empty discovery result from a dead agent reads exactly like a run that
// created nothing, so the caller gets this flag to tell the two apart.
let discoveryFailed = false

// Appliers declare what they create, but one that forgets leaves a file no
// later phase can see. Path quoting is off because a quoted non-ASCII path
// names no file the later phases can open, and the orchestrator captures the
// baseline with the same flag; turning it on for one side of the subtraction
// alone would fabricate new files.
async function discoverUntracked() {
  let result = null
  // agent() throws once a user-set token budget is exhausted; this call sits at
  // the top level, after the appliers have edited, so the throw is folded into
  // the dead-agent path rather than discarding the run's whole report.
  try {
    result = await agent(
      `${REPO}

Run exactly this shell command via Bash, unmodified:

${rootedCmd('git -c core.quotePath=false ls-files -o --exclude-standard')}

Return every path it prints, verbatim, as \`untracked\`, relative to the project root with no leading './'. Returning an empty array is a normal outcome. Do not read, review, or edit any project files.`,
      { label: 'discover:untracked', phase: 'Discover', schema: UNTRACKED_SCHEMA, model: 'sonnet', effort: 'low' },
    )
  } catch {
    result = null
  }
  if (!result) {
    discoveryFailed = true
    log('discovery agent died; undeclared new files, if any, will not be pruned or verified')
    return []
  }
  const before = new Set([...prep.untrackedBaseline, ...known])
  return result.untracked.filter(f => !before.has(f))
}

async function runCheck(label) {
  // agent() throws once a user-set token budget is exhausted, which would escape
  // to the top level; a budget that cannot afford the baseline cannot afford the
  // run either, so it degrades to the same null the callers already handle.
  try {
    const result = await agent(
      `${REPO}

Run exactly this shell command via Bash, unmodified:

${rootedCmd(input.checkCmd)}

Report whether it passed. For every failure it reports (type error, test failure, lint error), return the implicated file path and a concise one-line message. The path must be relative to the project root, with no leading './' and never absolute. Do not edit any project files and do not attempt any fixes.`,
      { label, phase: 'Verify', schema: CHECK_SCHEMA, ...checkOpts },
    )
    return result
  } catch {
    return null
  }
}

const allChanges = []
const allRejected = []
const globalSeen = new Set([prep.baselineHash])
let iterations = 0
let sweeps = 0
let stopReason = 'converged'
let outstandingFailures = []
// The tree hash is what normally proves the appliers edited something, so a run
// whose hash agent died needs its own record of it: discovery and the fix-up
// are gated on the tree having moved, and must still run when the hash is gone.
let treeEdited = false
let lastTreeHash = prep.baselineHash
const filesCreatedDuringRun = []
// The prune phase and the fix-up both have to reach files an applier edited
// without living to report them, and an applier's approved targets are the only
// record of where those edits could be.
const possiblyEditedFiles = new Set()
let proposedTotal = 0
let approvedTotal = 0

let baselineFailures = []
// A check that fails while naming no file, like a compiler rejecting its own
// options or a suite aborting in global setup, is honestly reported as a failing
// baseline with an empty list, so the verdict has to be kept apart from the
// list: the list alone would present that project as clean at baseline.
let baselineFailing = false
// An empty baseline from a dead agent would make every pre-existing failure
// look new, so the baseline retries and, failing that, disables verification
// for the run rather than fabricating fix work.
let checkDisabled = false
// An empty `unresolvedCheckFailures` cannot tell a verified-clean tree from one
// the verification never reached, so each phase also reports how its own
// verification ended.
let simplifyVerification = input.checkCmd ? 'no-changes' : 'not-configured'
if (input.checkCmd) {
  let baseline = null
  for (let attempt = 1; attempt <= 3 && !baseline; attempt++) {
    baseline = await runCheck(`check:baseline.${attempt}`)
  }
  if (!baseline) {
    checkDisabled = true
    simplifyVerification = 'baseline-failed'
    log('verification disabled: baseline check failed 3 times; no check failures will be attributed to this run')
  } else {
    baselineFailures = baseline.failures
    baselineFailing = !baseline.passed
    if (baselineFailing) {
      log(baselineFailures.length
        ? `baseline check already failing: ${baselineFailures.length} pre-existing failure(s) will be ignored`
        : 'baseline check already failing but named no file; no check failure will be attributed to this run')
    }
  }
}

// The fix-up agent runs alone at a quiet point, so unlike the loop agents it
// may run the project check itself, repeatedly, until it passes.
async function runFix(label, touched, cause, carried = []) {
  // Withholding the pre-existing failures makes an exit-0 command unreachable, so
  // `passed` has to be defined against the baseline instead: an agent reading it
  // as "the command exits 0" can only answer false with nothing it is allowed to
  // list, which reads as a run-caused failure that does not exist.
  let baselineNote = ''
  if (baselineFailures.length) {
    baselineNote = `\n\nThese failures existed BEFORE the run and are NOT yours to fix. Leave them alone and do not list them in \`remaining\`:\n${baselineFailures.map(f => `- ${f.file}: ${f.message}`).join('\n')}\n\nThe command will therefore still exit non-zero at the end. Report passed=true when the ONLY failures left are the pre-existing ones listed above; report passed=false only if a failure this run caused is still present, and list it in \`remaining\`. \`passed\` means "no run-caused failures remain", not "the command exits 0".`
  } else if (baselineFailing) {
    baselineNote = `\n\nThis command ALREADY exited non-zero BEFORE the run, and the baseline could not tie that failure to any file. It is NOT yours to fix and the command will still exit non-zero at the end. Report passed=true unless you can tie a specific failure to the edits this run made; do not list a failure you cannot tie to them in \`remaining\`. \`passed\` means "no run-caused failures remain", not "the command exits 0".`
  }
  const carriedNote = carried.length
    ? `\n\nAn earlier phase of this same run left these failures unrepaired. They are NOT pre-existing. Fix them too, and re-list any that survive in \`remaining\`:\n${carried.map(f => `- ${f.file}: ${f.message}`).join('\n')}`
    : ''
  // An agent that edits and then dies reports no files, so the list can be empty
  // on a tree that was edited anyway; presenting it as the bound on the search
  // would point the agent away from the breakage.
  const touchedNote = touched.length ? '; the files it touched are listed below' : ''
  const traceNote = touched.length ? ', which will be in or traceable to the touched files' : ''
  const touchedSection = touched.length
    ? `\n\nFiles touched by the run:\n${touchedBlock(touched)}`
    : `\n\nWhich files the run touched could not be recorded, so nothing bounds where the breakage is.`
  // agent() throws once a user-set token budget is exhausted; this call sits at
  // the top level, after the tree has been edited, so the throw becomes the same
  // null a dead fix-up returns rather than discarding the run's whole report.
  try {
    return await agent(
      `${REPO}

Run exactly this shell command via Bash:

${rootedCmd(input.checkCmd)}

An automated ${cause} run has just edited this project${touchedNote}. If the command passes, report passed=true with empty \`fixed\` and \`remaining\`. If it fails, fix the failures the run caused${traceNote}, then re-run the command, repeating until it passes or you have made three rounds of fixes. Keep every fix minimal and behavior-preserving; do not refactor or simplify beyond what the repair requires.${baselineNote}${carriedNote}${touchedSection}

Report \`passed\` for the final state, one line per repair in \`fixed\`, and any run-caused failures still present in \`remaining\` (file paths relative to the project root, no leading './', never absolute).`,
      { label, phase: 'Verify', schema: FIX_SCHEMA, ...judgeOpts },
    )
  } catch {
    return null
  }
}

// Stands in for a failure no fix-up would attribute to a file. It names no
// path, so it must be kept out of any list an agent is told to read as file
// paths.
const UNATTRIBUTED = '(unattributed)'

// A fix-up that reports the check still failing while listing nothing in
// `remaining` contradicts itself; taking the empty list at face value would
// report a knowingly broken project as clean.
function fixFailures(fix, cause) {
  if (fix.passed || fix.remaining.length) return fix.remaining
  log(`${cause} fix-up reports the check still failing but listed no failure`)
  return [{ file: UNATTRIBUTED, message: `check command still failing after the ${cause} fix-up, which named no specific failure` }]
}

function topDir(path) {
  return path.includes('/') ? path.slice(0, path.indexOf('/')) : '(root)'
}

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
    batches.push({ name, group: dir, files: files.slice(i, i + BATCH_SIZE), active: true, visits: 0 })
  }
}
log(`${prep.files.length} files across ${batches.length} batches (scope: ${input.scope})`)
// The workflow harness caps a run at 1000 agents in total; each batch-round
// costs up to three agents (find, judge, apply).
if (batches.length > 80) {
  log(`warning: ${batches.length} batches; the 1000-agent lifetime cap may end this run before convergence`)
}

const known = new Set(prep.files)

// A batch nobody could ever analyse is dropped rather than retried forever, so
// its files leave no trace anywhere else in the result: this is the only record
// that they were in scope and never looked at. A batch a finder did reach, or
// an applier was dispatched against, is not one of those: it was looked at,
// and `abandonedAfterProgress` is where it is recorded; listing it here would
// bury the never-looked-at files under ordinary transient agent flake.
const unanalyzedFiles = []

// The confirmation sweep is what `converged` speaks for, and it skips abandoned
// batches, so a batch dropped after earlier rounds had already worked on it
// leaves files whose settled state no fresh finder ever confirmed, with nothing
// in `unanalyzedFiles` to say so.
const abandonedAfterProgress = []

const scopeNote =
  input.scope === 'codebase'
    ? ''
    : `\n\nFor each file, first run \`git diff ${input.base} -- <file>\` and focus on the code that changed relative to ${input.base}. Do not propose changes to parts of these files that the diff did not touch.`

// A file that did not exist at the base has an empty diff against it, so the
// diff-bounded note on its own tells the finder that nothing in it is in scope.
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
  const focus = `${FOCUS[input.scope]} Examine ONLY these files:\n${fileListBlock(batch.files)}${batchScopeNote(batch.files)}\n\nYou may read any other project files for context. Other agents are working on other parts of this project concurrently, so do not run project-wide commands (typecheck, build, lint, test suite).`
  const visitNote = batch.visits > 0 ? `\n\nThis is visit ${batch.visits + 1} to these files; previous rounds already simplified them.` : ''
  // Function replacement: focus embeds paths, so $-patterns must not be interpreted.
  return `${REPO}\n\n` + SIMPLIFY.replace('$ARGUMENTS', () => focus) + (isSweep ? FIND_SWEEP_NOTE : visitNote)
}

function judgePrompt(findings, isSweep) {
  const sweepNote = isSweep
    ? `\n\nContext: these proposals come from a confirmation sweep. Earlier rounds already refined this scope and every batch had settled, and an approval reopens it for another round. Judge each proposal on the same standard as any other. The sweep exists to catch what earlier rounds genuinely missed, not to relitigate choices they already made.`
    : ''
  return `${REPO}

You are the independent gatekeeper in an automated code-simplification loop. A finder agent proposed the simplifications below. For each one, read the current code it targets and decide whether applying it would genuinely improve the codebase.

Proposals (JSON, judge each by its array index, starting at 0):
${JSON.stringify(findings)}

Approve a proposal only when it clearly preserves behavior and leaves the code easier to read or maintain by a margin that justifies touching settled code. Reject:
- cosmetic and preference-level changes: renaming an already-clear identifier, reshuffling already-readable code, style churn;
- anything with any risk of changing behavior;
- abstractions or extractions that do not remove real duplication;
- proposals too vague to implement safely exactly as described.
When in doubt, reject.${sweepNote}

The scope of this loop is ${input.scope === 'codebase' ? 'the entire codebase' : `code changed relative to ${input.base}`}; reject proposals reaching beyond it as out of scope.

Do not edit any files. Other agents are working elsewhere in this project concurrently, so do not run project-wide commands (typecheck, build, lint, test suite). Return one verdict per proposal: its index, approved true/false, and a one-line reason.`
}

function applyPrompt(approved) {
  return `${REPO}

Implement the following code-simplification findings exactly as described. Each was proposed by a finder agent and validated by an independent judge; your job is faithful application, not invention. Make no improvements beyond these findings.

Findings (JSON):
${JSON.stringify(approved)}

Preserve behavior exactly. Create a new file only when a finding calls for it. If a finding proves unsafe or impossible as described once you see the code, skip it and record it in \`failed\` with a reason instead of improvising an alternative.

Other agents are editing other parts of this project concurrently, so project-wide commands (typecheck, build, lint, test suite) would see a half-edited tree, so do not run them. Verify your edits by reading the code.

Report every change you actually made in \`applied\`, each in one sentence and classified as one of: ${GROUPS.join(', ')}, with the files it touched; every file you created in \`createdFiles\`; and every finding you skipped in \`failed\`. Every path must be relative to the project root, with no leading './' and never absolute. For files you edited, use exactly the paths as they appear in the findings above.`
}

function assignNewFile(path) {
  const dir = topDir(path)
  // An abandoned batch is never visited again, so a file homed into one would
  // silently leave the scope.
  const target = batches.find(b => b.group === dir && !b.abandoned && b.files.length < BATCH_SIZE)
  if (target) {
    target.files.push(path)
    target.active = true
    log(`new file ${path} joins batch ${target.name}`)
  } else {
    const existing = batches.filter(b => b.group === dir).length
    const name = existing ? `${dir}#${existing + 1}` : dir
    batches.push({ name, group: dir, files: [path], active: true, visits: 0 })
    log(`new file ${path} opens new batch ${name}`)
  }
}

while (true) {
  if (iterations >= MAX_ROUNDS) {
    stopReason = 'max-iterations'
    break
  }
  iterations++
  let targets = batches.filter(b => b.active)
  let isSweep = false
  if (targets.length === 0) {
    // Abandoned batches stay out: their agents would die again and the resulting
    // `roundHadDead` would block the sweep from ever confirming convergence.
    targets = batches.filter(b => !b.abandoned)
    // A sweep over nothing applies nothing and leaves the hash where it was,
    // which is exactly the shape of convergence, so a run where every batch was
    // abandoned would report the most reassuring stop reason for the worst
    // possible outcome. The two abandonment stories get their own stop reasons:
    // a scope no finder ever reached is a different report from one earlier
    // rounds did analyse before their agents started dying.
    if (targets.length === 0) {
      const everAnalysed = batches.some(b => b.visits > 0 || b.analysed) || treeEdited
      stopReason = everAnalysed ? 'all-batches-abandoned-after-progress' : 'all-batches-abandoned'
      log(everAnalysed
        ? (treeEdited
            ? 'every remaining batch was abandoned after repeated agent deaths; earlier rounds analysed part of the scope and an applier was dispatched, so the summary covers the work done so far'
            : 'every remaining batch was abandoned after repeated agent deaths; earlier rounds analysed part of the scope without recording any change')
        : 'every batch was abandoned before any round completed, so nothing was analysed')
      break
    }
    isSweep = true
    sweeps++
    log(`round ${iterations}: confirmation sweep ${sweeps} over ${targets.length} batches`)
  } else {
    log(`round ${iterations}: ${targets.length}/${batches.length} batches active`)
  }

  // Finders and judges are read-only, so a round that dispatched no applier
  // left the tree where the last hash found it and needs no hash agent.
  let roundDispatched = false
  const results = await pipeline(
    targets,
    batch =>
      agent(finderPrompt(batch, isSweep), {
        label: `find:${batch.name}@${iterations}`,
        phase: 'Find',
        schema: FINDINGS_SCHEMA,
        ...simplifyOpts,
      }),
    (found, batch) => {
      if (!found) return { status: 'finder-dead' }
      // A completed finder proves the batch's files were read, whatever dies
      // later in the round; `visits` cannot carry that, since it is only reached
      // by a round that survived to the end.
      batch.analysed = true
      if (found.findings.length === 0) return { status: 'clean' }
      return agent(judgePrompt(found.findings, isSweep), {
        label: `judge:${batch.name}@${iterations}`,
        phase: 'Judge',
        schema: judgeSchema(found.findings.length),
        ...judgeOpts,
      }).then(j => ({ status: 'judged', findings: found.findings, verdicts: j }))
    },
    (prev, batch) => {
      if (!prev || prev.status !== 'judged') return prev
      if (!prev.verdicts) return { status: 'judge-dead', proposed: prev.findings.length }
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
      // Recorded at dispatch, not from the report: an applier that edits and
      // then dies, or whose stage throws on an exhausted budget, returns
      // nothing to count, and neither the discovery and fix-up gates nor an
      // abandoned batch's account of its own files may read that silence as an
      // untouched tree.
      treeEdited = true
      roundDispatched = true
      batch.applierDispatched = true
      for (const file of approved.flatMap(f => f.files ?? [])) possiblyEditedFiles.add(file)
      return agent(applyPrompt(approved), {
        label: `apply:${batch.name}@${iterations}`,
        phase: 'Apply',
        schema: APPLY_SCHEMA,
        ...applyOpts,
      }).then(r => ({ status: 'applied', proposed: prev.findings.length, approved: approved.length, rejected, report: r }))
    },
  )

  const newFiles = []
  const revived = new Set()
  let roundApplied = 0
  let roundHadDead = false
  for (let i = 0; i < targets.length; i++) {
    const batch = targets[i]
    const r = results[i]
    // agent() resolves to null rather than throwing, so a dead finder, judge,
    // or applier surfaces here: the batch was not (fully) processed, so keep it
    // active for a fresh attempt and block this round from confirming
    // convergence.
    if (!r || r.status === 'finder-dead' || r.status === 'judge-dead' || (r.status === 'applied' && !r.report)) {
      batch.active = true
      roundHadDead = true
      // Fresh attempts, but a bounded number: a batch whose agents keep dying,
      // or that the user skips every round, would otherwise stay active
      // forever, so no sweep could ever run and convergence would be
      // unreachable for the whole scope.
      batch.deadAttempts = (batch.deadAttempts ?? 0) + 1
      if (batch.deadAttempts >= 2) {
        batch.active = false
        batch.abandoned = true
        if (!batch.analysed && !batch.applierDispatched) {
          unanalyzedFiles.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents; its files were never analysed`)
        } else if (batch.applierDispatched) {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents; an applier was dispatched to it, so its files may have been edited without being reported`)
        } else {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents; a finder did read its files, so they are not listed as unanalysed`)
        }
      }
      if (r?.proposed) proposedTotal += r.proposed
      if (r?.approved) approvedTotal += r.approved
      if (r?.rejected) allRejected.push(...r.rejected)
      continue
    }
    if (!isSweep) batch.visits++
    // Only back-to-back failures mean a batch is hopeless; without this reset,
    // two unrelated agent deaths rounds apart would abandon a batch that has
    // been analysed successfully in between.
    batch.deadAttempts = 0
    if (r.status === 'clean') {
      batch.active = false
      continue
    }
    if (r.status === 'all-rejected') {
      proposedTotal += r.proposed
      allRejected.push(...r.rejected)
      batch.active = false
      continue
    }
    proposedTotal += r.proposed
    approvedTotal += r.approved
    allRejected.push(...(r.rejected ?? []))
    const report = r.report
    const applied = report.applied ?? []
    roundApplied += applied.length
    batch.active = applied.length > 0
    if ((report.failed ?? []).length) {
      log(`batch ${batch.name}: ${report.failed.length} approved finding(s) could not be applied`)
    }
    // Only declared creations join the scope. An unknown path in an applied
    // entry is an out-of-scope edit, not a reason to widen the scope.
    const created = (report.createdFiles ?? []).filter(f => !known.has(f))
    for (const f of created) {
      known.add(f)
      wholeFile.add(f)
    }
    newFiles.push(...created)
    for (const change of applied) {
      for (const f of change.files ?? []) {
        if (!known.has(f)) continue
        // An edit in another batch's territory: give that batch a re-look now
        // instead of waiting for the sweep. An abandoned owner is skipped;
        // reviving it would only spend two more rounds re-abandoning it.
        const owner = batches.find(b => b !== batch && !b.abandoned && b.files.includes(f))
        if (owner) revived.add(owner)
      }
    }
    allChanges.push(...applied)
  }
  // Applied only after every batch's own status is written: an owner at a later
  // index would otherwise overwrite its revival with its own clean/all-rejected
  // verdict, leaving the re-look to whichever sweep comes next. Abandonment is
  // re-checked; the owner may have been abandoned after it was collected.
  for (const b of revived) if (!b.abandoned) b.active = true
  for (const f of newFiles) assignNewFile(f)
  filesCreatedDuringRun.push(...newFiles)

  const treeHash = roundDispatched ? await runHash(HASH_CMD, `hash:tree@${iterations}`) : lastTreeHash
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

// An unchanged tree means nothing was created, declared or not, so discovery is
// skipped unless the round hashes showed the tree move. Every applier is fully
// awaited before its round's hash, so those hashes settle it on their own; only
// a run that ended with no hash at all has to fall back on an applier having
// been dispatched. It runs before the fix-up so undeclared files reach both the
// fix-up and the prune phase.
const treeMoved = globalSeen.size > 1 || (treeEdited && stopReason === 'hash-unavailable')
let undeclaredFiles = []
if (treeMoved) {
  undeclaredFiles = await discoverUntracked()
  if (undeclaredFiles.length) {
    for (const f of undeclaredFiles) known.add(f)
    filesCreatedDuringRun.push(...undeclaredFiles)
    log(`${undeclaredFiles.length} file(s) appeared during the run without being declared: ${touchedBlock(undeclaredFiles)}`)
  }
}

if (input.checkCmd && !checkDisabled && treeMoved) {
  // Same `known` gate as the loop on the dispatched targets: an out-of-scope
  // path there is a proposal this run never owned. A path in `allChanges` is a
  // report of a real edit; in scope or not, it is where breakage may be.
  const touched = [...new Set([
    ...allChanges.flatMap(c => c.files ?? []),
    ...[...possiblyEditedFiles].filter(f => known.has(f)),
    ...filesCreatedDuringRun,
  ])]
  const fix = await runFix('fix:simplify', touched, 'code-simplification')
  if (!fix) {
    simplifyVerification = 'fixup-died'
    log('fix-up agent died; project state unverified')
  } else {
    simplifyVerification = 'ran'
    outstandingFailures = fixFailures(fix, 'code-simplification')
    if (fix.fixed.length) {
      log(`fix-up repaired ${fix.fixed.length} issue(s)`)
    }
    if (fix.remaining.length) {
      log(`fix-up leaves ${fix.remaining.length} failure(s) unresolved`)
    }
  }
  // Only a fix-up that ran the check clean and touched nothing proves the tree
  // still matches the last hash; a dead one, or one that edited and reported the
  // attempt only in `remaining`, leaves it ahead. The prune phase is the sole
  // consumer of the refreshed value, so an unstable run skips the agent. A
  // failed hash keeps the pre-fix seed: it costs one extra prune pass, where an
  // unseeded set would let the first pass look settled.
  const fixLeftTreeIntact = fix && fix.passed && !fix.fixed.length && !fix.remaining.length
  if (stopReason === 'converged' && !fixLeftTreeIntact) {
    const postFixHash = await runHash(HASH_CMD, 'hash:tree@postfix')
    if (postFixHash) {
      lastTreeHash = postFixHash
    } else {
      log('hash agent could not return a hash after the fix-up; the prune phase seeds from the pre-fix tree state')
    }
  }
}

// Pruning starts only once simplification has converged, so prune agents
// never audit comments in code a later pass would rewrite.
let prune
if (stopReason === 'converged') {
  // Extension comes from the basename only: a dotted directory name must not
  // supply an extension.
  function extOf(f) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    const i = base.lastIndexOf('.')
    return i > 0 ? base.slice(i) : ''
  }
  const alreadyListed = new Set([...trackedPruneFiles, ...untrackedPruneFiles])
  const pruneExts = new Set(PRUNE_EXTS)
  const createdPruneFiles = filesCreatedDuringRun.filter(f => pruneExts.has(extOf(f)) && !alreadyListed.has(f))
  // The tracked candidate list was frozen before launch from the pre-run diff, so
  // a file that carried no comment then is absent from it even after an applier
  // wrote one into it, including an applier that died before reporting, which is
  // why the files it was merely dispatched against count too. A file it turned out
  // not to touch costs one prune pass that removes nothing. Same `known` gate as
  // the loop: a path outside the scope is an out-of-scope edit, not a reason to
  // widen the audit.
  const editedTracked = [...new Set([...allChanges.flatMap(c => c.files ?? []), ...possiblyEditedFiles])]
    .filter(f => known.has(f) && pruneExts.has(extOf(f)) && !alreadyListed.has(f) && !filesCreatedDuringRun.includes(f))
  // A file that was already untracked at launch has no diff against the base, so
  // a diff-bounded instruction would audit nothing in it and retire its batch
  // as clean, reporting a comment as audited that no agent was asked to read.
  const editedFresh = editedTracked.filter(f => wholeFile.has(f))
  const editedDiffBounded = editedTracked.filter(f => !wholeFile.has(f))
  const wholeFilePruneFiles = [...untrackedPruneFiles, ...createdPruneFiles, ...editedFresh]
  const pruneList = [...trackedPruneFiles, ...editedDiffBounded, ...wholeFilePruneFiles]

  const BATCH = 5
  let activeBatches = []
  function addBatches(files, instruction) {
    for (let i = 0; i < files.length; i += BATCH) {
      activeBatches.push({ id: activeBatches.length + 1, files: files.slice(i, i + BATCH), instruction })
    }
  }
  addBatches([...trackedPruneFiles, ...editedDiffBounded], SCOPE_INSTRUCTIONS[input.scope](input.base))
  addBatches(wholeFilePruneFiles, SCOPE_INSTRUCTIONS.codebase())
  const batchesTotal = activeBatches.length
  log(`prune (${input.scope}): ${pruneList.length} candidate files (${wholeFilePruneFiles.length} untracked) in ${batchesTotal} batches`)

  function prunePass(iteration) {
    return pipeline(
      activeBatches,
      (batch) => {
        // Recorded at dispatch, not from the report: an agent that edits and
        // then dies, or whose stage throws on an exhausted budget, reports no
        // removals, and the fix-up gate must still open for the broken syntax it
        // may have left behind.
        pruneEdited = true
        return agent(
          `${REPO}

You are pruning comments in this repository.

For each of these files: ${batch.instruction}

Files:
${batch.files.join('\n')}

${RULES}

Remove every removal candidate with Read + Edit: remove only the comment (and its now-empty line), never touch code, and verify each edit leaves valid syntax. Report the number of comments you removed in \`removed\`. Removing nothing is a normal, successful outcome; do not remove borderline comments to justify the pass.`,
          { label: `prune:${iteration}.batch${batch.id}`, phase: 'Prune', schema: PRUNE_SCHEMA, ...pruneOpts },
        ).then((res) => {
          // agent() resolves to null rather than throwing, so a dead or skipped
          // agent is indistinguishable from one that removed nothing unless the
          // two are split here; retiring it as clean would report files as
          // audited that no agent ever finished.
          if (!res) {
            log(`prune: agent for batch ${batch.id} did not answer; its files are unaudited so far`)
            return { batch, removed: 0, clean: false, dead: true }
          }
          return { batch, removed: res.removed, clean: res.removed === 0 }
        })
      },
    )
  }

  const pruneSeen = new Set([lastTreeHash])
  let removed = 0
  const unauditedFiles = []
  let batchesDone = 0
  let stable = 0
  let pruneIterations = 0
  let pruneStop = 'converged'
  let incompleteRetries = 0
  let pruneEdited = false
  let pruneVerification = 'not-configured'
  if (input.checkCmd) pruneVerification = checkDisabled ? 'baseline-failed' : 'no-changes'

  while (stable < 1) {
    if (pruneIterations >= MAX_ROUNDS) {
      pruneStop = 'max-iterations'
      break
    }
    pruneIterations++
    const attempted = activeBatches.length
    const ok = (await prunePass(pruneIterations)).filter(Boolean)
    const passRemoved = ok.reduce((n, r) => n + r.removed, 0)
    // A batch whose agent died left its comments unaudited, and an exhausted
    // token budget makes its stage throw, dropping the batch from `ok`
    // entirely. Neither is a pass that found nothing left to do, so neither
    // may confirm a still tree.
    const incomplete = ok.length < attempted || ok.some((r) => r.dead)
    // The retry allowance below bounds a failure that keeps repeating, not the
    // phase's lifetime: a pass in which every agent answered proves the earlier
    // death was transient, so the phase must not end on the next isolated one.
    if (!incomplete) incompleteRetries = 0

    // A batch whose agent keeps dying gets fresh attempts, but only a bounded
    // number: a user who skips the same agent every pass would otherwise keep
    // the loop alive until the round backstop. Only back-to-back deaths mean a
    // batch is unreachable, so an agent that answered clears the tally; without
    // the reset, two flakes passes apart would drop a batch that has been
    // pruned in between.
    const abandonedIds = new Set()
    for (const r of ok) {
      if (!r.dead) {
        r.batch.deadAttempts = 0
        continue
      }
      r.batch.deadAttempts = (r.batch.deadAttempts ?? 0) + 1
      if (r.batch.deadAttempts >= 2) {
        abandonedIds.add(r.batch.id)
        unauditedFiles.push(...r.batch.files)
        log(`prune: batch ${r.batch.id} abandoned after ${r.batch.deadAttempts} consecutive prune agents died; it never produced a clean pass, so its comments may not be fully audited`)
      }
    }

    // Re-auditing a settled batch every pass invites agents to justify the
    // visit by flagging borderline comments, so the tree keeps changing and
    // the hash never repeats.
    const cleanIds = new Set(ok.filter((r) => r.clean).map((r) => r.batch.id))
    activeBatches = activeBatches.filter((b) => !cleanIds.has(b.id) && !abandonedIds.has(b.id))
    batchesDone += cleanIds.size

    const hash = await runHash(HASH_CMD, `hash:prune@${pruneIterations}`)
    if (!hash) {
      pruneStop = 'hash-unavailable'
      // The removals of the pass that ends the loop are real, and counting them
      // only where the hash moved would report an edited tree as one nothing
      // was removed from.
      removed += passRemoved
      log(`prune ${pruneIterations}: hash agent could not return a hash, so a settled tree cannot be confirmed; stopping and reporting the work done so far`)
      break
    }
    if (pruneSeen.has(hash)) {
      // One more attempt for the batches an agent left unfinished, then out: a
      // failure that keeps repeating, like a user skipping every prune agent
      // or an exhausted budget, would otherwise re-run it until the round backstop.
      if (incomplete && activeBatches.length && incompleteRetries < 1) {
        incompleteRetries++
        log(`prune ${pruneIterations}: no new tree state, but an agent died with candidates outstanding; retrying its batch`)
        continue
      }
      if (incomplete) {
        pruneStop = 'incomplete-dead-agent'
        log(`prune ${pruneIterations}: agents kept dying with candidates outstanding; stopping with batches unfinished`)
        break
      }
      stable++
      log(`prune ${pruneIterations}: no new tree state (${stable}/1 confirmations)`)
    } else {
      stable = 0
      pruneSeen.add(hash)
      removed += passRemoved
      log(`prune ${pruneIterations}: tree changed (${passRemoved} comments removed, ${cleanIds.size} batches retired, ${activeBatches.length} still active)`)
    }
    // Every batch having retired is a different terminal state from a tree that
    // merely stopped moving, and only an end-of-pass test can catch it: the
    // stability exit at the loop condition fires before the loop body could
    // retest an emptied batch list.
    if (activeBatches.length === 0) {
      pruneStop = 'all-batches-clean'
      break
    }
  }

  // Prune agents edit in parallel and never run project-wide commands, so
  // one fix-up on the settled tree is the safety net for broken syntax. Every
  // agent is awaited before its pass's hash, so a phase that never left the
  // seed state proves nothing moved; only a phase that ended with no hash at
  // all has to fall back on an agent having been dispatched.
  if (input.checkCmd && !checkDisabled && (pruneSeen.size > 1 || (pruneEdited && pruneStop === 'hash-unavailable'))) {
    // This fix-up runs last on the final tree, so it adjudicates what the
    // simplify fix-up left broken too; otherwise its verdict would replace a
    // failure it was never told about.
    const carried = outstandingFailures
    const touched = [...new Set([...pruneList, ...carried.map((f) => f.file).filter((f) => f !== UNATTRIBUTED)])]
    const fix = await runFix('fix:prune', touched, 'comment-pruning', carried)
    if (!fix) {
      pruneVerification = 'fixup-died'
      log('prune fix-up agent died; project state unverified')
    } else {
      pruneVerification = 'ran'
      outstandingFailures = fixFailures(fix, 'comment-pruning')
      if (fix.fixed.length) log(`prune fix-up repaired ${fix.fixed.length} issue(s)`)
      if (fix.remaining.length) log(`prune fix-up leaves ${fix.remaining.length} failure(s) unresolved`)
    }
  }

  // A prune agent that edits and then dies reports no removal, so `removed` alone
  // cannot say the tree moved; the pass hashes can, though a pre-fix seed
  // leaves the first of them counting the simplify fix-up's edits.
  prune = { iterations: pruneIterations, stopReason: pruneStop, distinctTreeStates: pruneSeen.size - 1, removed, batchesDone, batchesTotal, unauditedFiles, verificationStatus: pruneVerification }
} else {
  prune = { stopReason: 'skipped-simplify-unstable' }
}

// Every caveat the report must state, worded here from the fields that decide
// it, so the orchestrator relays sentences instead of evaluating a table of
// conditions and the result carries none of the fields they were built from.
const fullPrune = prune.stopReason !== 'skipped-simplify-unstable'
const edited = allChanges.length > 0 || globalSeen.size > 1 || (fullPrune && (prune.removed > 0 || prune.distinctTreeStates > 0))
const editPossible = stopReason === 'hash-unavailable' || (fullPrune && prune.stopReason === 'hash-unavailable')
const verificationLost = (s) => s === 'baseline-failed' || s === 'fixup-died'
const unverified = (fullPrune && verificationLost(prune.verificationStatus))
  || (verificationLost(simplifyVerification) && !(fullPrune && prune.verificationStatus === 'ran'))
const noCheck = simplifyVerification === 'not-configured' && (edited || editPossible)

const reportLines = []
const say = (text, prominent = false) => reportLines.push({ text, prominent })
const paths = (files) => files.map(f => `\`${f}\``).join(', ')

if (stopReason === 'all-batches-abandoned') {
  say('Every batch was abandoned because its agents kept dying or were skipped, so the scope was never analysed at all: nothing converged, and nothing is known about the shape of the code.', true)
}
if (stopReason === 'all-batches-abandoned-after-progress') {
  say('The loop stopped because every remaining batch\'s agents kept dying or were skipped, so convergence was never confirmed.')
  say(globalSeen.size > 1 ? 'The tree was left edited.' : 'Earlier rounds analysed part of the scope without recording any change.')
}
function unsettled(phaseName, reason, changed) {
  if (reason === 'max-iterations') say(`The ${phaseName} phase did not settle within ${MAX_ROUNDS} rounds; the summary covers the work done so far.`)
  else if (reason === 'hash-unavailable') say(`The hash agent could not return a hash during the ${phaseName} phase, so its convergence could not be confirmed; the summary covers the work done so far.`)
  else return
  if (changed) say('The tree was edited.')
  else if (reason === 'max-iterations') say('Nothing was recorded as changed, and the final state could not be confirmed.')
  else say('Nothing was recorded as changed, an edit could not be ruled out, and the final state could not be confirmed.')
}
unsettled('simplify', stopReason, allChanges.length > 0 || globalSeen.size > 1)
if (!fullPrune) {
  say(`Comment pruning was skipped because simplification never converged: it stopped on \`${stopReason}\`.`)
} else {
  unsettled('prune', prune.stopReason, prune.removed > 0 || prune.distinctTreeStates > 0)
  const unfinished = prune.batchesTotal - prune.batchesDone
  if (prune.stopReason === 'incomplete-dead-agent') say(`Pruning stopped with ${unfinished} batch(es) unfinished because its agents kept dying; their comments were not audited.`)
  if (prune.stopReason === 'converged') say(`The tree stopped moving while prune batches were still active, so the remaining ${unfinished} batch(es) never produced a clean pass.`)
  if (prune.unauditedFiles.length) say(`The comments in these files may not be fully audited, since the prune agents for their batch died or were skipped and it never produced a clean pass: ${paths(prune.unauditedFiles)}.`)
}
if (unanalyzedFiles.length) {
  say(`These files were never analysed because their batch's agents kept dying or were skipped${stopReason === 'all-batches-abandoned' ? '' : ', so the rest of the scope could still converge'}: ${paths(unanalyzedFiles)}.`)
}
if (abandonedAfterProgress.length) {
  say(`These files' batch was dropped after repeated agent deaths, so the loop never confirmed they had settled and the scope as a whole cannot be said to have converged: ${paths(abandonedAfterProgress)}.`)
}
if (discoveryFailed) say('The workflow could not list the files created during the run, so any an apply agent created without reporting were neither pruned nor verified.')
else if (undeclaredFiles.length) say(`An apply agent created these files without reporting them, so they were never simplified: ${paths(undeclaredFiles)}.`)
if (unverified) {
  say(`The project was never verified: run the check command manually${outstandingFailures.length ? '' : '; an empty list of check failures proves nothing'}.`, true)
  if (edited) say('The project was edited without verification.', true)
  else if (editPossible) say('An edit cannot be ruled out and was not verified.', true)
}
if (simplifyVerification === 'fixup-died' && fullPrune && prune.verificationStatus === 'ran') {
  say('The mid-run verification died, but the prune fix-up re-ran the same check on the final tree, so the final tree was verified.')
}
if (baselineFailures.length > 0 || baselineFailing) {
  say('The project\'s check was already failing before the run; those failures were left alone and are still there, so no new failure means only that the run caused none. The project does not pass its check.')
}
if (noCheck) {
  say('No check command could be found for this project, so the absence of check failures means nothing: verify the tree before relying on or committing it.', true)
  if (edited) say('The edits were never verified by anything.', true)
  else if (editPossible) say('Anything the run may have edited was never verified.', true)
}

const summary = {}
for (const group of GROUPS) summary[group] = []
for (const change of allChanges) {
  const group = GROUPS.includes(change.group) ? change.group : 'Code simplifications'
  summary[group].push({ description: firstSentence(change.description), files: change.files })
}

// A long run can reject hundreds of proposals; the report relays the first
// few, each by its first sentence, and past the cap gives only the count. An
// applied change is relayed by its first sentence too.
const REJECTED_SHOWN = 10

function firstSentence(text) {
  const s = String(text || '')
  const end = s.search(/[.!?](\s|$)/)
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
  prune: fullPrune
    ? { iterations: prune.iterations, stopReason: prune.stopReason, removed: prune.removed, batchesDone: prune.batchesDone, batchesTotal: prune.batchesTotal }
    : { stopReason: prune.stopReason },
  reportLines,
  summary,
}
