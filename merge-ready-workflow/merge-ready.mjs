export const meta = {
  name: 'merge-ready',
  description: 'Repeat the adversarial code review over a scope, re-scouting the finders each round, until a round fixes nothing medium or higher that changes production behaviour and fewer than half its finders reported a medium-or-higher fix; then simplify the same scope',
  phases: [
    { title: 'Scout', detail: 'the session model (or args.model) at medium effort designs the finder dimensions afresh for the round' },
    { title: 'Review', detail: 'the adversarial-review workflow (review.mjs) over the round\'s dimensions' },
    { title: 'Triage', detail: 'Opus classifies each fixed medium-or-higher finding by the kinds of change in its hunks; a production kind means another round', model: 'opus' },
    { title: 'Simplify', detail: 'the simplify-converge workflow (simplify.mjs) over the same scope, which computes its own file lists' },
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
for (const key of ['files', 'dirtyAtLaunch', 'untracked']) {
  if (!Array.isArray(input[key])) throw new Error(`args.${key}: string[] is required; pass [] when there is none`)
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
  logic: { production: true, text: 'a change to what shipped code does: application logic, data handling, queries, API handlers, UI behaviour; a helper local to the file it fixes is part of it' },
  config: { production: true, text: 'configuration the running product reads' },
  robustness: { production: true, text: 'a small guard or fallback with no user-visible effect today' },
  rename: { production: false, text: 'a symbol renamed with every consumer updated and nothing else changed' },
  'dead-code': { production: false, text: 'unreachable or unused code removed' },
  types: { production: false, text: 'type annotations with no runtime effect' },
  format: { production: false, text: 'formatting only' },
  comment: { production: false, text: 'comments and docstrings' },
  docs: { production: false, text: 'docs, agent docs, tool and prompt descriptions' },
  copy: { production: false, text: 'user-facing copy, error message text and translations' },
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
          kinds: { type: 'array', items: { type: 'string', enum: Object.keys(CHANGE_KINDS) }, description: 'Every kind of change the fix\'s hunks contain, by key from the list in the prompt.' },
          reason: { type: 'string', description: 'The hunk each production kind rests on, quoted; for a fix with no production kind, what its hunks are instead.' },
        },
        required: ['id', 'kinds', 'reason'],
      },
    },
  },
  required: ['verdicts'],
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

// The scout is told nothing about earlier rounds: no round number, no earlier
// split, no list of what the fixes touched. Each round's cut is designed from
// the scope alone, the way a cleared conversation would design it.
function scoutPrompt(inScope, untracked) {
  const list = inScope.map((f) => `- ${f}${untracked.has(f) ? ' (untracked: no diff against the base, read whole)' : ''}`).join('\n')
  const sizes = SCOPE === 'codebase'
    ? 'See sizes with `wc -l` on the paths.'
    : `See sizes with \`git diff --stat ${BASE}\`.`
  return `${CONTEXT}

${READ_ONLY}
${scoutIntentText()}
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
  const kindList = Object.keys(CHANGE_KINDS).map((k) => `- ${k}${CHANGE_KINDS[k].production ? ' (production)' : ''}: ${CHANGE_KINDS[k].text}`).join('\n')
  const blocks = candidates.map((c) => {
    const fixer = c.outcome === 'covered' && c.coveredBy != null ? findings.find((f) => f.id === c.coveredBy) : null
    const fix = fixer || c
    const via = fixer ? `\nFixed by the change for finding #${fixer.id} "${fixer.title}", which covers it.` : ''
    const hunks = fix.hunks && fix.hunks.trim() ? `\nHunks:\n${fix.hunks.trim()}` : ''
    return `Finding #${c.id} [${c.severity}] ${c.title}\nLocation: ${c.file}:${c.line}\nDescription: ${c.description}${via}\nFix: ${fixLocation(fix)}${hunks}`
  }).join('\n\n')
  return `${CONTEXT}

${READ_ONLY}

You are the TRIAGE agent of a looping adversarial code review. Round ${round} just fixed the medium, high and critical findings below. For each one, classify its fix by the kinds of change its hunks contain, from this list. The kinds marked production change what shipped code does at runtime; the others do not:
${kindList}

A fix carries every kind its hunks contain: one that changed a comment and a query is comment and logic. Read each fix's hunks (from its commit, or pasted below for a fix left uncommitted), list a production kind only when a hunk changes what shipped code does, and quote that hunk in the reason. One verdict per finding id.

${blocks}`
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

function refutedLine(f) {
  const reason = String(f.refuteReason || '')
  const end = reason.search(/[.!?](\s|$)/)
  const first = end >= 0 ? reason.slice(0, end + 1) : reason
  return { ...f, refuteReason: first.length > 300 ? `${first.slice(0, 300)}…` : first }
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

for (let round = 1; round <= MAX_ROUNDS; round++) {
  phase('Scout')
  // Nothing but this loop's implementers writes to the tree between rounds (a
  // cleanup that cannot restore it stops the loop), so a round's state is the
  // launch state plus what the fixes so far touched, and no agent re-reads it.
  const dirtyAtLaunch = [...new Set([...input.dirtyAtLaunch, ...allUncommittedFixFiles])].sort()
  const untracked = [...new Set(input.untracked)].sort()
  const inScope = [...new Set([...input.files, ...untracked, ...allFixes.flatMap((f) => f.files || [])])].sort()
  if (inScope.length === 0) {
    stopReason = 'scope-empty'
    stopDetail = `round ${round} found nothing in scope`
    break
  }
  const scout = await run(scoutPrompt(inScope, new Set(untracked)), { label: `scout @${round}`, phase: 'Scout', schema: DIMENSIONS_SCHEMA, ...SCOUT_OPTS })
  if (!scout) {
    stopReason = 'agent-failed'
    stopDetail = `the scout of round ${round} died`
    break
  }
  const { dimensions, missing } = normalizeDimensions(scout.dimensions, inScope)
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
  }
  if (BASE) reviewArgs.base = BASE
  if (CHECKS) reviewArgs.checks = CHECKS
  if (MODEL) reviewArgs.implementerModel = MODEL
  if (LOOP_START) reviewArgs.authorEnd = LOOP_START
  if (INTENT_NOTE) reviewArgs.intent = INTENT_NOTE
  const { result: review, error } = await runChild(input.reviewScript, reviewArgs, 'review workflow')

  const entry = {
    round,
    unassignedFiles: missing,
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

  const triage = { failed: false, productionIds: [] }
  if (candidates.length) {
    phase('Triage')
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
  }
  entry.triage = triage
  // The result lands in the launching session whole, every round of it, so
  // what the report never reads leaves once the loop and the triage have read
  // it: the hunks, the finder a finding came from, a committed fix's files (its
  // commit carries them), the fields the loop-wide notes report once for every
  // round, the exclusion table every round repeats, and all of a refuted
  // finding's reason but its first sentence.
  Object.assign(excludedKindsTable, review.excludedKinds)
  entry.review = {
    finderFailures: review.finderFailures,
    findings: findings.map(({ hunks, dimension, ...f }) => {
      if (f.commitSha) delete f.files
      return f.status === 'refuted' ? refutedLine(f) : f
    }),
  }

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
  entry.decision = { counts, reasons }

  if (blocked) {
    stopReason = 'possibly-dirty'
    stopDetail = `round ${round}: an implementer died and the cleanup could not restore ${review.possiblyDirty.join(', ')}`
    log(`round ${round}: stopping, the tree may hold partial hunks in protected paths`)
    break
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

log(`done: ${rounds.length} review round(s), stop reason ${stopReason}, ${allFixes.length} fix(es) in total, simplify ${simplify.ran ? 'ran' : `skipped (${simplify.skipped})`}`)

return {
  scope: SCOPE,
  base: BASE,
  model: MODEL || null,
  checksConfigured: CHECKS !== null,
  excludedKinds: excludedKindsTable,
  stopReason,
  stopDetail,
  rounds,
  uncommittedFixFiles: [...allUncommittedFixFiles],
  possiblyDirty: [...allPossiblyDirty],
  simplify,
}
