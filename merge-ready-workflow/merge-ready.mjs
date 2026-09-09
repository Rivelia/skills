export const meta = {
  name: 'merge-ready',
  description: 'Repeat the adversarial code review over a scope, re-scouting the finders each round, until a round fixes nothing severe in production code and fewer issues than it had finders; then simplify the same scope',
  phases: [
    { title: 'Scout', detail: 'Sonnet records the tree state, then Fable (or args.model) designs the finder dimensions afresh for the round' },
    { title: 'Review', detail: 'the adversarial-review workflow (review.mjs) over the round\'s dimensions' },
    { title: 'Triage', detail: 'Opus decides whether each fixed critical/high finding changed production behaviour', model: 'opus' },
    { title: 'Prepare', detail: 'Sonnet computes the simplify inputs: file list, prune candidates, untracked baseline, tree hash', model: 'sonnet' },
    { title: 'Simplify', detail: 'the simplify-converge workflow (simplify.mjs) over the same scope' },
  ],
}

const SCOPES = ['uncommitted', 'branch', 'unpushed', 'codebase']
const SEVERE = ['critical', 'high']
// Backstop only: the loop ends on its own once a round fixes too little to
// justify another. Each round spends a few dozen agents and the simplify
// phase spends more, all against the harness's 1000-agent lifetime cap.
const MAX_ROUNDS = 10
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
for (const key of ['checks', 'checkCmd', 'excludePattern', 'model']) {
  if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
    throw new Error(`args.${key}: a non-empty string when given; omit it otherwise`)
  }
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
// The model argument replaces Fable wherever it is the default: the scout here,
// the review implementers, the simplify appliers. Every other agent keeps its model.
const MODEL = input.model ? input.model.trim() : undefined
const PRUNE_EXTS = input.pruneExts.map((e) => (e.startsWith('.') ? e : `.${e}`))

const STATE_OPTS = { model: 'sonnet', effort: 'low' }
const SCOUT_OPTS = { model: MODEL || 'fable', effort: 'high' }
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

// ---------- schemas ----------

const STATE_SCHEMA = {
  type: 'object',
  properties: {
    dirtyAtLaunch: { type: 'array', items: { type: 'string' } },
    untracked: { type: 'array', items: { type: 'string' } },
    tracked: { type: 'array', items: { type: 'string' } },
  },
  required: ['dirtyAtLaunch', 'untracked', 'tracked'],
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

const TRIAGE_SCHEMA = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer' },
          production: { type: 'boolean', description: 'true when the fix changed what shipped code does.' },
          reason: { type: 'string', description: 'The hunk your verdict rests on.' },
        },
        required: ['id', 'production', 'reason'],
      },
    },
  },
  required: ['verdicts'],
}

const PREPARE_SCHEMA = {
  type: 'object',
  properties: {
    files: { type: 'array', items: { type: 'string' } },
    pruneFiles: { type: 'array', items: { type: 'string' } },
    pruneUntrackedFiles: { type: 'array', items: { type: 'string' } },
    untrackedBaseline: { type: 'array', items: { type: 'string' } },
    baselineHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
  required: ['files', 'pruneFiles', 'pruneUntrackedFiles', 'untrackedBaseline', 'baselineHash'],
}

// ---------- prompts ----------

function statePrompt() {
  return `Repository: ${ROOT}. Run exactly these shell commands via Bash from ${ROOT}, unmodified, and copy their output verbatim into the named fields. Every path is relative to ${ROOT} with no leading './'. An empty array is a normal answer. Do not read, review or edit any project file.

1. dirtyAtLaunch: \`${GIT} status --porcelain\`. Return every path it lists as a plain path, without the two status columns and the space after them. For a rename line ("R  old -> new") return both paths.
2. untracked: \`${GIT} ls-files -o --exclude-standard\`. Return every path.
3. tracked: \`${LIST_TRACKED_CMD}\`. Return every path.`
}

// The scout is told nothing about earlier rounds: no round number, no earlier
// split, no list of what the fixes touched. Each round's cut is designed from
// the scope alone, the way a cleared conversation would design it.
function scoutPrompt(state, inScope) {
  const untracked = new Set(state.untracked)
  const list = inScope.map((f) => `- ${f}${untracked.has(f) ? ' (untracked: no diff against the base, read whole)' : ''}`).join('\n')
  const sizes = SCOPE === 'codebase'
    ? 'See sizes with `wc -l` on the paths.'
    : `See sizes with \`git diff --stat ${BASE}\`.`
  return `${CONTEXT}

${READ_ONLY}

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

function triagePrompt(round, candidates, findings) {
  const blocks = candidates.map((c) => {
    const fixer = c.outcome === 'covered' && c.coveredBy != null ? findings.find((f) => f.id === c.coveredBy) : null
    const fix = fixer || c
    const via = fixer ? `\nFixed by the change for finding #${fixer.id} "${fixer.title}", which covers it.` : ''
    const hunks = fix.hunks && fix.hunks.trim() ? `\nHunks:\n${fix.hunks.trim()}` : '\nHunks: not reported; read the fix from git.'
    return `Finding #${c.id} [${c.severity}] ${c.title}\nLocation: ${c.file}:${c.line}\nDescription: ${c.description}${via}\nFix: ${fixLocation(fix)}\nKinds reported by the implementer: ${(fix.kinds || []).join(', ') || '(none)'}${hunks}`
  }).join('\n\n')
  return `${CONTEXT}

${READ_ONLY}

You are the TRIAGE agent of a looping adversarial code review. Round ${round} just fixed the critical and high findings below. For each one, decide whether its fix CHANGED PRODUCTION BEHAVIOUR. Production behaviour is what shipped code does at runtime: application logic, data handling, queries, API handlers, UI behaviour, configuration the running product reads. A fix that only touched comments, docs, tests, test fixtures or test helpers, CI or build configuration, type annotations with no runtime effect, formatting, log text, or user-facing copy and translations did not change production behaviour. A fix that did both did change it.

Read each fix's hunks (pasted below when the implementer reported them, otherwise from git as indicated) and answer production=true only when a hunk changes what shipped code does; quote that hunk in the reason. One verdict per finding id.

${blocks}`
}

function preparePrompt() {
  const extRe = `\\.(${PRUNE_EXTS.map((e) => e.slice(1).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`
  const filesCmd = `{ ${LIST_TRACKED_CMD}; ${GIT} ls-files -o --exclude-standard; } | sort -u | grep -vE '${EXCLUDE}' | while IFS= read -r f; do [ -f "$f" ] && echo "$f"; done || :`
  const pruneCmd = SCOPE === 'codebase'
    ? `${GIT} ls-files | sort -u | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && grep -qE '(//|/\\*|<!--)' "$f" && echo "$f"; done || :`
    : `${GIT} diff --name-only ${BASE} | sort -u | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && ${GIT} diff ${BASE} -- "$f" | grep -qE '^\\+.*(//|/\\*|<!--)' && echo "$f"; done || :`
  const pruneUntrackedCmd = `${GIT} ls-files -o --exclude-standard | grep -vE '${EXCLUDE}' | grep -E '${extRe}' | while IFS= read -r f; do [ -f "$f" ] && grep -qE '(//|/\\*|<!--)' "$f" && echo "$f"; done || :`
  const untrackedCmd = `${GIT} ls-files -o --exclude-standard`
  return {
    hashCmd: hashCommand(),
    prompt: `Repository: ${ROOT}. Run exactly these shell commands via Bash from ${ROOT}, one at a time, unmodified, in this order, and copy their output verbatim into the named fields. Every path is relative to ${ROOT} with no leading './'. An empty array is a normal answer. Do not read, review or edit any project file.

1. files:
${filesCmd}

2. pruneFiles:
${pruneCmd}

3. pruneUntrackedFiles:
${pruneUntrackedCmd}

4. untrackedBaseline (raw, every path, no filtering):
${untrackedCmd}

5. baselineHash, run last: the 64-character hex hash, the first field of the output of
${hashCommand()}`,
  }
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

log(`scope ${SCOPE}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, up to ${MAX_ROUNDS} review round(s), Fable agents on ${MODEL || 'fable'}, simplify afterwards`)

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Scout')
  const state = await run(statePrompt(), { label: `state @${round}`, phase: 'Scout', schema: STATE_SCHEMA, ...STATE_OPTS })
  if (!state) {
    stopReason = 'agent-failed'
    stopDetail = `the state agent of round ${round} died`
    break
  }
  const inScope = [...new Set([...state.tracked, ...state.untracked])]
  if (inScope.length === 0) {
    stopReason = 'scope-empty'
    stopDetail = `round ${round} found nothing in scope`
    break
  }
  const scout = await run(scoutPrompt(state, inScope), { label: `scout @${round}`, phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
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

  const findings = review.findings || []
  const fixed = findings.filter((f) => f.outcome === 'fixed')
  const covered = findings.filter((f) => f.outcome === 'covered')
  const resolved = fixed.length + covered.length
  const counts = {
    finders: dimensions.length,
    finderFailures: (review.finderFailures || []).length,
    registered: findings.length,
    confirmed: findings.filter((f) => f.status === 'confirmed').length,
    fixed: fixed.length,
    covered: covered.length,
    resolved,
  }

  // A covered severe finding was closed by its coverer's change, so that change
  // is the one triaged.
  const severe = findings.filter((f) => SEVERE.includes(f.severity) && (f.outcome === 'fixed' || f.outcome === 'covered'))
  const triage = { candidates: severe.map((f) => f.id), verdicts: [], failed: false, productionIds: [] }
  if (severe.length) {
    phase('Triage')
    const t = await run(triagePrompt(round, severe, findings), { label: `triage @${round}`, phase: 'Triage', schema: TRIAGE_SCHEMA, ...TRIAGE_OPTS })
    if (!t) {
      triage.failed = true
      triage.productionIds = severe.map((f) => f.id)
      log(`round ${round}: the triage agent died; every severe fix is assumed to have changed production behaviour`)
    } else {
      triage.verdicts = t.verdicts.filter((v) => severe.some((f) => f.id === v.id))
      triage.productionIds = triage.verdicts.filter((v) => v.production).map((v) => v.id)
    }
  }
  entry.triage = triage

  const reasons = []
  if (triage.productionIds.length) {
    reasons.push(`${triage.productionIds.length} critical/high fix(es) changed production behaviour (#${triage.productionIds.join(', #')})`)
  }
  if (resolved >= dimensions.length) {
    reasons.push(`${resolved} issue(s) fixed or covered, at least as many as the ${dimensions.length} finder(s)`)
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
    log(`round ${round}: ${counts.resolved} issue(s) resolved by ${counts.finders} finder(s), none severe in production code; the review loop is done`)
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
  const { prompt, hashCmd } = preparePrompt()
  let prep = null
  for (let attempt = 1; attempt <= 2 && !prep; attempt++) {
    prep = await run(prompt, { label: `prepare simplify.${attempt}`, phase: 'Prepare', schema: PREPARE_SCHEMA, ...PREPARE_OPTS })
  }
  if (!prep) {
    simplify = { ran: false, skipped: 'prepare-failed', error: 'the prepare agent died twice', result: null }
    log('simplify skipped: the prepare agent died twice')
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
  model: MODEL || 'fable',
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
