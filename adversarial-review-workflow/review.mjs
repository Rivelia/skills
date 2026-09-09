export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial code review over a scope: finders per dimension, dedup at intake, two skeptics per finding, root-cause clustering, budgeted implementers that commit their own fix',
  phases: [
    { title: 'Find', detail: 'one Opus finder per dimension', model: 'opus' },
    { title: 'Dedup', detail: 'Sonnet intake check against the registered findings', model: 'sonnet' },
    { title: 'Verify', detail: 'materiality skeptic, then technical skeptic', model: 'opus' },
    { title: 'Cluster', detail: 'group confirmed findings by root cause', model: 'opus' },
    { title: 'Implement', detail: 'one implementer per cluster (Fable unless args.implementerModel overrides), strictly sequential, commits its own fix' },
    { title: 'Cover', detail: 'Opus check whether a cluster fix also closes its siblings', model: 'opus' },
    { title: 'Cleanup', detail: 'Sonnet tree restore after a dead implementer', model: 'sonnet' },
  ],
}

const SCOPES = ['uncommitted', 'branch', 'unpushed', 'codebase']
const SEVERITIES = ['low', 'medium', 'high', 'critical']

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('args.root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('args.base: the commit bounding the diff is required for every scope except codebase')
}
for (const key of ['dirtyAtLaunch', 'untracked']) {
  if (!Array.isArray(input[key])) throw new Error(`args.${key}: string[] is required; pass [] when there is none`)
}
if (!Array.isArray(input.dimensions) || input.dimensions.length === 0) {
  throw new Error('args.dimensions: non-empty [{key, title, focus, files: string[]}] is required')
}
for (const d of input.dimensions) {
  if (!d || !d.key || !d.title || !d.focus || !Array.isArray(d.files) || d.files.length === 0) {
    throw new Error(`args.dimensions: every entry needs key, title, focus and a non-empty files list (offending: ${JSON.stringify(d)})`)
  }
}
if (typeof input.context !== 'string' || !input.context.trim()) {
  throw new Error('args.context: a string describing the project (stack, agent docs to quote, commit convention) is required')
}
if (input.implementerModel !== undefined && (typeof input.implementerModel !== 'string' || !input.implementerModel.trim())) {
  throw new Error('args.implementerModel: a model name (e.g. opus, sonnet, haiku) when given; omit it to keep the Fable implementers')
}

const ROOT = input.root
const BASE = input.base || null
const DIMENSIONS = input.dimensions
const CHECKS = typeof input.checks === 'string' && input.checks.trim() ? input.checks.trim() : null
// The implementers run on Fable unless the user picked another model; effort stays tied to severity.
const IMPLEMENTER_MODEL = input.implementerModel ? input.implementerModel.trim() : 'fable'

const FINDER_OPTS = { model: 'opus', effort: 'high' }
const DEDUP_OPTS = { model: 'sonnet', effort: 'low' }
const MATERIALITY_OPTS = { model: 'opus', effort: 'medium' }
const TECHNICAL_OPTS = { model: 'opus', effort: 'high' }
const CLUSTER_OPTS = { model: 'opus', effort: 'medium' }
const SIBLING_OPTS = { model: 'opus', effort: 'high' }
const CLEANUP_OPTS = { model: 'sonnet', effort: 'low' }
const implementerOpts = (severity) => ({ model: IMPLEMENTER_MODEL, effort: severity === 'low' ? 'medium' : 'high' })

// ---------- shared prompt fragments ----------

const SCOPE_LABEL = {
  uncommitted: 'the uncommitted changes',
  branch: 'the branch diff',
  unpushed: 'the unpushed work (unpushed commits plus uncommitted changes)',
  codebase: 'the entire codebase',
}

const untrackedInScope = new Set(input.untracked)

function scopeText() {
  if (input.scope === 'codebase') {
    return `Review scope: ${SCOPE_LABEL.codebase}, every tracked file plus untracked files. There is no base commit: read files whole with cat/sed.`
  }
  const untracked = input.untracked.length
    ? `\nUntracked files are in scope too and have no diff against the base, so read them whole:\n${input.untracked.map((f) => `- ${f}`).join('\n')}`
    : '\nThere were no untracked files at launch.'
  return `Review scope: ${SCOPE_LABEL[input.scope]}, i.e. the working tree against base commit ${BASE}. Read a file's hunks with \`git diff ${BASE} -- <path>\`, the pre-change file with \`git show ${BASE}:<path>\`, the file list with \`git diff --stat ${BASE}\`, and the surrounding current code with cat/sed.${untracked}`
}

const CONTEXT = `Repository: ${ROOT}.
${input.context.trim()}
${scopeText()}
Severity scale: critical = data loss or corruption, a security breach, or a crash of the production process; high = wrong behaviour on a path users hit in normal use, a deadlock, hang or resource leak under normal load, or a security or tenancy gap; medium = wrong behaviour on an edge path, a real leak or race that is hard to hit, a convention violation the project's agent docs state explicitly, or a false statement in docs or comments a maintainer would act on; low = a demonstrably false statement shipped to users (UI copy, translations, docs, error messages), a misleading comment, or a small robustness issue with no user-visible effect today.`

const READ_ONLY = `You are READ-ONLY with respect to the repository: do not edit, create or delete files under ${ROOT}, and run no git command that changes state (no checkout, restore, stash, commit, reset, clean). Scratch files go in /tmp. You may run existing tests and small scripts from /tmp.`

const DIMENSION_LIST = DIMENSIONS.map((d) => `- ${d.key}: ${d.title}. Files: ${d.files.join(', ')}`).join('\n')

const BUDGET = {
  low: 'LOW budget: an edit to copy, a comment or a doc, or a single hunk in the file that holds the defect; no new test file.',
  medium: 'MEDIUM budget: a contained code change in the files the finding names, plus one focused test.',
  high: 'HIGH budget: a contained change of roughly under 60 lines across a few files whose behaviour is easy to reason about and to test.',
  critical: 'CRITICAL budget: a contained change of roughly under 60 lines across a few files whose behaviour is easy to reason about and to test.',
}

const EXCLUDED = `Never auto-applied, whatever the severity: new CI jobs, scripts, config or infrastructure; new abstractions (a wrapper, a predicate, a helper, a module) or changes to exports and public signatures; DB schema or migration changes; dependency changes; edits to files the finding does not name (except files the clustering attached); tests that assert a still-present bug; tests that read source as text; and findings whose only defect is a missing test.`

function findingText(e) {
  const sev = e.finalSeverity ?? e.severity
  const title = e.finalTitle ?? e.title
  const desc = e.finalDescription ?? e.description
  return `Finding #${e.id} [${sev}] ${title}\nLocation: ${e.file}:${e.line}\nReported by finder: ${e.dimension}\nDescription: ${desc}\nEvidence: ${e.evidence}\nSuggested fix: ${e.suggestedFix}`
}

// ---------- schemas ----------

const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'One line naming the defect.' },
          file: { type: 'string', description: 'Repo-relative path of the root location.' },
          line: { type: 'integer', description: 'Line in the current working-tree file.' },
          severity: { type: 'string', enum: SEVERITIES },
          description: { type: 'string', description: 'The defect, the mechanism by which it fails, and the consequence. Concrete: name the code path and the input or timing that triggers it.' },
          evidence: { type: 'string', description: 'What you read or ran that shows it (file:line references, command output).' },
          suggestedFix: { type: 'string', description: 'The smallest change that closes it.' },
        },
        required: ['title', 'file', 'line', 'severity', 'description', 'evidence', 'suggestedFix'],
      },
    },
  },
  required: ['findings'],
}

const DEDUP_SCHEMA = {
  type: 'object',
  properties: {
    duplicateOf: { type: ['integer', 'null'], description: 'The id of the registered finding that is the same defect, or null.' },
    reason: { type: 'string' },
  },
  required: ['duplicateOf', 'reason'],
}

const MATERIALITY_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refute', 'downgrade', 'confirm'] },
    severity: { type: 'string', enum: SEVERITIES, description: 'The severity you settle on: for downgrade the new one, for confirm the finder\'s.' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'severity', 'reason'],
}

const TECHNICAL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refute', 'confirm_as_is', 'confirm_corrected'] },
    correctedTitle: { type: ['string', 'null'] },
    correctedDescription: { type: ['string', 'null'], description: 'For confirm_corrected: the defect as you actually verified it, at the same location.' },
    consequenceChanged: { type: 'boolean', description: 'For confirm_corrected: true when the correction changes what the defect causes, not just its mechanics.' },
    reason: { type: 'string', description: 'What you verified and how (code read, commands run).' },
  },
  required: ['verdict', 'correctedTitle', 'correctedDescription', 'consequenceChanged', 'reason'],
}

const CLUSTER_SCHEMA = {
  type: 'object',
  properties: {
    clusters: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          leadId: { type: 'integer' },
          memberIds: { type: 'array', items: { type: 'integer' }, description: 'All member ids including the lead.' },
          rootCause: { type: 'string' },
        },
        required: ['leadId', 'memberIds', 'rootCause'],
      },
    },
  },
  required: ['clusters'],
}

const IMPL_SCHEMA = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['applied', 'covered', 'not_applied', 'reverted'], description: 'applied: a fix is in the tree (committed or not). covered: an earlier accepted fix already closes it, nothing changed. not_applied: over budget or an excluded kind, nothing changed. reverted: you applied a fix, a check could not pass within the budget, and you undid your own hunks.' },
    plan: { type: 'string', description: 'The smallest fix you identified, in enough detail for a maintainer to apply it by hand.' },
    reason: { type: 'string', description: 'Why you did or did not apply it: fits budget / over budget (which budget line) / excluded kind (which) / covered / which check could not pass.' },
    excludedKind: { type: 'boolean', description: 'For not_applied: true when the fix is an excluded kind, false when merely over budget.' },
    coveredBy: { type: ['integer', 'null'], description: 'For covered: the id of the finding whose fix covers this one.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you changed or created (empty unless outcome is applied).' },
    kinds: { type: 'array', items: { type: 'string' }, description: 'e.g. "copy edit", "comment", "single hunk in defect file", "contained code change", "one focused test added", "existing test updated".' },
    hunks: { type: 'string', description: 'The `git diff` (or `git show` after committing) of your change; empty unless outcome is applied.' },
    checks: { type: 'array', items: { type: 'object', properties: { command: { type: 'string' }, result: { type: 'string' } }, required: ['command', 'result'] } },
    committed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    notes: { type: 'string', description: 'Anything left outside the budget that a more complete fix would need.' },
  },
  required: ['outcome', 'plan', 'reason', 'excludedKind', 'coveredBy', 'files', 'kinds', 'hunks', 'checks', 'committed', 'commitSha', 'notes'],
}

const SIBLING_SCHEMA = {
  type: 'object',
  properties: {
    covered: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['covered', 'reason'],
}

const CLEANUP_SCHEMA = {
  type: 'object',
  properties: {
    wasDirty: { type: 'boolean' },
    reverted: { type: 'array', items: { type: 'string' }, description: 'Paths you restored or deleted.' },
    leftDirty: { type: 'array', items: { type: 'string' }, description: 'Protected paths that still hold uncommitted changes.' },
  },
  required: ['wasDirty', 'reverted', 'leftDirty'],
}

// ---------- prompts ----------

function finderPrompt(d) {
  const own = d.files.map((f) => `- ${f}${untrackedInScope.has(f) ? ' (untracked: read whole)' : ''}`).join('\n')
  const preExisting = input.scope === 'codebase'
    ? 'There is no base, so every defect in the files counts, whatever its age.'
    : `Only defects the diff introduced or worsened. Pre-existing conditions the diff did not touch are out of scope unless the diff makes them worse.`
  return `${CONTEXT}

${READ_ONLY}

You are the specialized FINDER for the review dimension "${d.key}: ${d.title}".
Your focus: ${d.focus}
Files you own:
${own}

All dimensions in this review (other finders own the others; stay on yours, but report a defect you can only see from your files even when its root lies in a file another dimension owns, and say so):
${DIMENSION_LIST}

Method: ${input.scope === 'codebase' ? 'read every file you own in full' : 'read every hunk of every file you own (untracked files whole)'}, then the surrounding current code and whatever callers or callees you need to be sure. Where a claim can be tested cheaply (a regex, a library contract, a runtime behaviour), test it with a small script in /tmp, by reading the library sources in node_modules or the equivalent, or by running an existing test. Each finding goes to two adversarial skeptics that refute by default when uncertain, so a finding you have not verified is wasted: prefer fewer, verified findings over many speculative ones.

Rules:
- Report real defects: wrong behaviour, security or tenancy gaps, races, leaks, data loss, regressions, contradictions between code and docs or copy, and violations of rules you can quote from the project's agent docs.
- Report each defect once, at its root location (the line whose change fixes it), even when several files you read expose it.
- ${preExisting}
- A demonstrably false statement in user-facing copy, docs or error messages is a finding regardless of audience size. A false statement in a code comment counts only when a maintainer acting on it would introduce a bug or miss one.
- Missing tests as the sole defect, style preferences without a quotable rule, and speculative hardening are not findings.
- Give the exact file and line in the current working tree. An empty findings list is a valid answer.`
}

function dedupPrompt(f, dim, candidates) {
  const list = candidates.map((c) => `- id ${c.id}: "${c.title}" at ${c.file}:${c.line}\n  ${c.description}`).join('\n')
  return `You are the DEDUP check of a code review. A new finding just arrived from finder "${dim}". Compare it with every registered finding below and say whether it is the SAME DEFECT as one of them.
Definition: two findings are the same defect when one change at one location fixes both. Findings that are merely related, in the same file, or share a theme are NOT the same defect. When in doubt, answer null (not a duplicate).

New finding:
Title: ${f.title}
Location: ${f.file}:${f.line}
Description: ${f.description}
Suggested fix: ${f.suggestedFix}

Registered findings:
${list}

Answer with the id of the registered finding it duplicates, or null.`
}

function materialityPrompt(e, rerun) {
  const preExisting = input.scope === 'codebase'
    ? ''
    : `; a pre-existing condition the diff neither introduced nor worsened (check with \`git diff ${BASE} -- <file>\` and \`git show ${BASE}:<file>\`)`
  return `${CONTEXT}

${READ_ONLY}

You are the MATERIALITY skeptic in an adversarial code review. Your job is to attack whether this finding matters, refuting by default when uncertain about its substance. ${rerun ? 'This is a re-run: the technical skeptic corrected the finding\'s description and its consequence changed, so judge the corrected version below afresh.' : ''}

${findingText(e)}

Your verdict is three-way:
- refute: the finding's substance fails. Valid grounds ONLY: cosmetic-only consequence${preExisting}; or a documented tradeoff that covers this specific regression (an ADR or doc accepting a related fallback does not excuse a new gap in a component that does implement the mechanism).
- downgrade: the mechanism is real but the impact is overstated. Severity inflation alone is NEVER a kill ground: downgrade and confirm. Say the severity you settle on.
- confirm: the finding is material at the finder's severity.

Carve-out: a demonstrably false statement shipped to users (UI copy, translations, user-facing docs, error messages) is material by definition, however small its audience. You may downgrade it (e.g. to low) but must not refute it; "nothing consumes it" or "no decision depends on it" are not valid kill grounds for factual incorrectness.

Do not judge technical truth here (a later skeptic does); assume the mechanism is as described and ask whether it matters. Read the code and the docs you need to decide. Quote the code or doc your verdict rests on.`
}

function technicalPrompt(e) {
  return `${CONTEXT}

${READ_ONLY}

You are the TECHNICAL skeptic in an adversarial code review. Your job is to attack whether this finding is technically true, refuting by default when uncertain whether the failure mechanism is real at all. A materiality skeptic already confirmed it matters at severity ${e.finalSeverity}.

${findingText(e)}

Verify it yourself: read the code at the location and along the path the finding names, read library sources when the claim depends on their behaviour, and run a small experiment from /tmp or an existing test when that settles it. Do not take the finder's evidence on trust. Try to construct the concrete input or sequence; if it cannot happen, refute.

Your verdict is three-way:
- refute: the mechanism does not exist, or the code already handles it, or the trigger cannot occur. Uncertainty about whether the mechanism is real at all defaults to refute.
- confirm_corrected: a detail in the finding is wrong (bad arithmetic, misattributed cause, overstated scenario) but YOUR OWN verification shows the underlying defect is real in a corrected form at the same location. Give the corrected description; the implementer will work from it. A correction must be something you actually verified, not a charitable reinterpretation. Set consequenceChanged=true if the correction changes what the defect causes (not just its mechanics).
- confirm_as_is: the finding is right as written.

A wrong detail is only a kill ground when the failure mechanism collapses with it. Quote the code your verdict rests on.`
}

function clusterPrompt(confirmed) {
  return `${CONTEXT}

${READ_ONLY}

You are the ROOT-CAUSE CLUSTERING agent. Group the confirmed findings below by root cause and name a lead finding per cluster. Findings in different files belong to one cluster when a SINGLE change fixes them all (a cap change and the viewers it silently truncates; a missing predicate and the endpoints that rely on it). Findings that merely share a file, a theme or a subsystem are separate clusters. When unsure, keep them separate: one implementer handles a whole cluster, and a wrong merge makes it fix things the lead finding does not name.

The lead of a cluster is the finding whose location is where the single change goes, preferring the highest severity when several qualify.

Read the code at each location before deciding. Every finding id must appear in exactly one cluster (a singleton cluster is fine).

Confirmed findings:
${confirmed.map((e) => findingText(e)).join('\n\n')}`
}

// Files an implementer must never sweep into a commit or restore with git:
// the user's uncommitted work at launch, plus fixes earlier in this run that
// had to stay uncommitted because they overlapped that work.
const protectedFiles = new Set(input.dirtyAtLaunch)
const uncommittedFixFiles = new Set()
const priorFixes = []

function protectedText() {
  const user = input.dirtyAtLaunch
  const fixes = [...uncommittedFixFiles]
  if (user.length === 0 && fixes.length === 0) {
    return 'The working tree was clean at launch and every fix accepted so far in this run is committed, so the tree is clean when you start (check with `git status --porcelain`).'
  }
  const lines = []
  if (user.length) lines.push(`These paths held the user's uncommitted work at launch and must keep it:\n${user.map((f) => `- ${f}`).join('\n')}`)
  if (fixes.length) lines.push(`These paths hold fixes from earlier in this run that were left uncommitted:\n${fixes.map((f) => `- ${f}`).join('\n')}`)
  lines.push('Treat every path listed above as PROTECTED: never run git checkout, restore, stash, reset or clean on it, never stage it, and undo your own hunks in it by editing the file back by hand. Everything else in the tree is committed.')
  return lines.join('\n')
}

function priorFixesText() {
  if (priorFixes.length === 0) return 'No fix has been accepted earlier in this run.'
  return `Fixes accepted earlier in this run (if one already covers this finding, change nothing and return outcome=covered with coveredBy):\n${priorFixes.map((p) => `- finding #${p.id} "${p.title}": ${p.sha ? `commit ${p.sha}` : 'uncommitted in the working tree'}, files ${p.files.join(', ')}`).join('\n')}`
}

function checksText() {
  if (CHECKS) {
    return `Then run the project checks relevant to what you touched:\n${CHECKS}\nFix what they flag while staying within the budget. A check you cannot make pass within the budget means you undo your own hunks (\`git checkout -- <file>\` for a file that is not protected, editing back by hand for a protected one, deleting files you created) and return outcome=reverted with the plan and the reason.`
  }
  return 'No check command is known for this project. Verify your change by reading it against its callers and by running the existing tests that cover the files you touched, if any; report what you ran in checks.'
}

function implementerPrompt(e, siblings) {
  const sev = e.finalSeverity
  const sibText = siblings.length
    ? `\nThis finding leads a cluster; the single change that fixes it should also fix these siblings (the clustering attached their files to your allowed set):\n${siblings.map((s) => findingText(s)).join('\n\n')}\n`
    : ''
  return `${CONTEXT}

You are the IMPLEMENTER for one confirmed finding. You may edit files under ${ROOT}. Nobody reviews your change after you: you are the last line. Judge your own diff the way the maintainer reviewing the merge request would; they send back anything bigger than the finding.

${protectedText()}

${findingText(e)}
${sibText}
${priorFixesText()}

Plan your own fix: read the code around the finding, decide the SMALLEST change that closes it, then check that change against the budget for severity ${sev}:
${BUDGET[sev] ?? BUDGET.medium}
${EXCLUDED}

Minimal is relative to the finding, not to any larger plan: when a more complete fix exists beyond the budget, do the part inside the budget and describe the rest in notes. Never extend a fix to a sibling component the finding did not name (that is a new finding). Cheap means small relative to the finding, not quick to type. Follow the project's agent docs for any code or test you write; a test must never add complexity to production code (no test-only parameters, seams or exports).

If the smallest fix does not fit the budget or is an excluded kind, change nothing and return outcome=not_applied with the plan, the reason and excludedKind.

When it fits: make the change. ${checksText()}

Commit rule: when none of the files you changed or created is protected, commit the fix yourself: \`git add <exactly your files>\`, then \`git commit\` with a message in the project's commit convention (from the context above; default \`type(scope): subject\`), with no attribution lines or trailers; report committed=true and the sha. When any file you changed is protected, leave the whole fix uncommitted and report committed=false: never commit a whole file to get around the overlap.

Report outcome=applied with exactly the files and hunks you changed (paste the diff), the kinds of change, every check command with its result, and the commit state. Finish with \`git status --porcelain\` and make sure your report matches it: nothing of yours may remain in the tree after not_applied, covered or reverted.`
}

function siblingPrompt(s, lead, fix) {
  const where = fix.sha
    ? `commit ${fix.sha}; inspect it with \`git show ${fix.sha}\``
    : `uncommitted in the working tree; inspect it with \`git diff -- ${fix.files.join(' ')}\``
  return `${CONTEXT}

${READ_ONLY}

You are checking a cluster SIBLING. The clustering agent said one change fixes both finding #${lead.id} and the sibling below. The fix for #${lead.id} has been applied (${where}).

Lead finding:
${findingText(lead)}

Sibling finding to check:
${findingText(s)}

Read the applied hunks and the sibling's location in its current state. Answer covered=true only if the defect the sibling describes can no longer occur after the fix. If it still can, answer covered=false with what remains, and it will get its own implementer.`
}

function cleanupPrompt(why) {
  const protectedList = [...protectedFiles, ...uncommittedFixFiles]
  const protectedNote = protectedList.length
    ? `These paths are PROTECTED (the user's uncommitted work at launch, or an earlier fix left uncommitted): leave them exactly as they are, never checkout, restore or delete them, and list them in leftDirty if they appear in the status.\n${protectedList.map((f) => `- ${f}`).join('\n')}`
    : 'No path is protected: the tree was clean at launch and every earlier fix is committed.'
  return `Repository: ${ROOT}. Anything uncommitted right now, other than the protected paths below, was left by ${why} and must be restored. Run \`git -C ${ROOT} status --porcelain\`. For every listed path that is not protected: \`git -C ${ROOT} checkout -- <path>\` for a tracked file, delete it for an untracked one. Do nothing else.
${protectedNote}
Report what you found, what you restored or deleted, and which protected paths still hold changes.`
}

// ---------- registry ----------

const registry = []
let nextId = 1
const verifications = []
const finderFailures = []
// Dedup runs serialized so two candidates arriving at once cannot both be
// registered as primaries; verification runs concurrently as soon as a
// finding is registered.
let dedupChain = Promise.resolve()

function byId(id) {
  return registry.find((e) => e.id === id)
}

// agent() resolves to null for a skipped or dead agent and throws once a
// user-set token budget is exhausted; both end a finding the same way.
async function run(prompt, opts) {
  try {
    return await agent(prompt, opts)
  } catch {
    return null
  }
}

async function verify(e) {
  const mat = await run(materialityPrompt(e, false), { label: `materiality #${e.id}`, phase: 'Verify', schema: MATERIALITY_SCHEMA, ...MATERIALITY_OPTS })
  if (!mat) {
    e.status = 'agent_failed'
    e.failedAt = 'materiality skeptic'
    return
  }
  e.verdicts.push({ skeptic: 'materiality', ...mat })
  if (mat.verdict === 'refute') {
    e.status = 'refuted'
    e.refutedBy = 'materiality'
    e.refuteReason = mat.reason
    log(`#${e.id} refuted on materiality`)
    return
  }
  e.finalSeverity = mat.verdict === 'downgrade' && SEVERITIES.includes(mat.severity) ? mat.severity : e.severity

  const tech = await run(technicalPrompt(e), { label: `technical #${e.id}`, phase: 'Verify', schema: TECHNICAL_SCHEMA, ...TECHNICAL_OPTS })
  if (!tech) {
    e.status = 'agent_failed'
    e.failedAt = 'technical skeptic'
    return
  }
  e.verdicts.push({ skeptic: 'technical', ...tech })
  if (tech.verdict === 'refute') {
    e.status = 'refuted'
    e.refutedBy = 'technical'
    e.refuteReason = tech.reason
    log(`#${e.id} refuted on technical truth`)
    return
  }
  if (tech.verdict === 'confirm_corrected') {
    if (tech.correctedDescription) e.finalDescription = tech.correctedDescription
    if (tech.correctedTitle) e.finalTitle = tech.correctedTitle
    e.corrected = true
    if (tech.consequenceChanged) {
      const mat2 = await run(materialityPrompt(e, true), { label: `materiality (corrected) #${e.id}`, phase: 'Verify', schema: MATERIALITY_SCHEMA, ...MATERIALITY_OPTS })
      if (!mat2) {
        e.status = 'agent_failed'
        e.failedAt = 'materiality skeptic (corrected re-run)'
        return
      }
      e.verdicts.push({ skeptic: 'materiality (corrected)', ...mat2 })
      if (mat2.verdict === 'refute') {
        e.status = 'refuted'
        e.refutedBy = 'materiality (after correction)'
        e.refuteReason = mat2.reason
        log(`#${e.id} refuted on materiality after correction`)
        return
      }
      if (mat2.verdict === 'downgrade' && SEVERITIES.includes(mat2.severity)) e.finalSeverity = mat2.severity
    }
  }
  e.status = 'confirmed'
  log(`#${e.id} confirmed at ${e.finalSeverity}`)
}

function registerAndVerify(f, dim) {
  const p = dedupChain.then(async () => {
    let dupOf = null
    if (registry.length > 0) {
      const d = await run(dedupPrompt(f, dim, registry), { label: `dedup: ${f.title.slice(0, 50)}`, phase: 'Dedup', schema: DEDUP_SCHEMA, ...DEDUP_OPTS })
      if (d && d.duplicateOf !== null && registry.some((c) => c.id === d.duplicateOf)) dupOf = d.duplicateOf
    }
    if (dupOf !== null) {
      byId(dupOf).alsoReportedBy.push({ dimension: dim, title: f.title, file: f.file, line: f.line })
      log(`dedup: "${f.title}" (${dim}) attached to #${dupOf}`)
      return
    }
    const entry = {
      id: nextId++,
      dimension: dim,
      title: f.title,
      file: f.file,
      line: f.line,
      severity: SEVERITIES.includes(f.severity) ? f.severity : 'medium',
      description: f.description,
      evidence: f.evidence,
      suggestedFix: f.suggestedFix,
      alsoReportedBy: [],
      verdicts: [],
      status: 'pending',
      finalSeverity: null,
      finalTitle: null,
      finalDescription: null,
    }
    registry.push(entry)
    log(`registered #${entry.id} [${entry.severity}] ${entry.title} (${dim})`)
    verifications.push(verify(entry))
  })
  dedupChain = p.catch(() => undefined)
  return p
}

// ---------- Find + Dedup + Verify, no barriers between them ----------

phase('Find')
log(`scope ${input.scope}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, ${DIMENSIONS.length} finder dimension(s), ${input.dirtyAtLaunch.length ? `${input.dirtyAtLaunch.length} path(s) dirty at launch` : 'tree clean at launch'}, implementers on ${IMPLEMENTER_MODEL}`)

await parallel(DIMENSIONS.map((d) => async () => {
  const res = await run(finderPrompt(d), { label: `find: ${d.key}`, phase: 'Find', schema: FINDINGS_SCHEMA, ...FINDER_OPTS })
  if (!res) {
    finderFailures.push(d.key)
    log(`finder ${d.key} failed; its dimension was not reviewed`)
    return
  }
  const list = res.findings.filter((f) => f && f.title && f.file)
  log(`finder ${d.key}: ${list.length} finding(s)`)
  for (const f of list) await registerAndVerify(f, d.key)
}))
await dedupChain
await Promise.all(verifications)

const confirmed = registry.filter((e) => e.status === 'confirmed')
log(`verification done: ${registry.length} registered, ${confirmed.length} confirmed, ${registry.filter((e) => e.status === 'refuted').length} refuted, ${registry.filter((e) => e.status === 'agent_failed').length} agent-failed`)

// ---------- Cluster (barrier: every finder and every verification has completed) ----------

const clusters = []
if (confirmed.length === 1) {
  clusters.push({ leadId: confirmed[0].id, memberIds: [confirmed[0].id], rootCause: '(single finding)' })
} else if (confirmed.length > 1) {
  phase('Cluster')
  const c = await run(clusterPrompt(confirmed), { label: 'root-cause clustering', phase: 'Cluster', schema: CLUSTER_SCHEMA, ...CLUSTER_OPTS })
  const confirmedIds = new Set(confirmed.map((e) => e.id))
  const assigned = new Set()
  if (c) {
    for (const cl of c.clusters) {
      const members = [...new Set([cl.leadId, ...cl.memberIds])].filter((id) => confirmedIds.has(id) && !assigned.has(id))
      if (members.length === 0) continue
      const leadId = members.includes(cl.leadId) ? cl.leadId : members[0]
      members.forEach((id) => assigned.add(id))
      clusters.push({ leadId, memberIds: members, rootCause: cl.rootCause })
    }
  } else {
    log('clustering agent failed; every confirmed finding becomes its own cluster')
  }
  for (const e of confirmed) {
    if (!assigned.has(e.id)) {
      assigned.add(e.id)
      clusters.push({ leadId: e.id, memberIds: [e.id], rootCause: '(singleton)' })
    }
  }
  log(`${clusters.length} cluster(s): ${clusters.map((cl) => `#${cl.leadId}{${cl.memberIds.join(',')}}`).join(' ')}`)
}
const sevRank = (e) => SEVERITIES.indexOf(e.finalSeverity)
clusters.sort((a, b) => sevRank(byId(b.leadId)) - sevRank(byId(a.leadId)))

// ---------- Implement, strictly sequential ----------

const possiblyDirty = new Set()

async function cleanup(why) {
  const r = await run(cleanupPrompt(why), { label: `cleanup after ${why}`, phase: 'Cleanup', schema: CLEANUP_SCHEMA, ...CLEANUP_OPTS })
  if (!r) {
    log(`cleanup after ${why} failed; the tree may hold stray hunks`)
    possiblyDirty.add('(cleanup agent failed: run git status)')
    return
  }
  if (r.wasDirty) log(`cleanup after ${why}: restored ${r.reverted.join(', ') || 'nothing'}`)
  for (const f of r.leftDirty) possiblyDirty.add(f)
}

async function implement(e, siblings) {
  const impl = await run(implementerPrompt(e, siblings), { label: `implement #${e.id}`, phase: 'Implement', schema: IMPL_SCHEMA, ...implementerOpts(e.finalSeverity) })
  if (!impl) {
    e.outcome = 'agent_failed'
    e.failedAt = 'implementer'
    await cleanup(`the dead implementer for #${e.id}`)
    return
  }
  e.implementation = impl
  if (impl.outcome === 'covered') {
    e.outcome = 'covered'
    e.coveredBy = impl.coveredBy
    log(`#${e.id} covered by an earlier fix${impl.coveredBy ? ` (#${impl.coveredBy})` : ''}`)
    return
  }
  if (impl.outcome === 'not_applied') {
    e.outcome = 'not_fixed'
    log(`#${e.id} not auto-fixed: ${impl.excludedKind ? 'excluded kind' : 'over budget'}`)
    return
  }
  if (impl.outcome === 'reverted') {
    e.outcome = 'reverted'
    log(`#${e.id} fix attempted and reverted: ${impl.reason.slice(0, 120)}`)
    return
  }
  e.outcome = 'fixed'
  e.committed = impl.committed === true
  e.commitSha = e.committed ? impl.commitSha : null
  if (!e.committed) for (const f of impl.files) uncommittedFixFiles.add(f)
  priorFixes.push({ id: e.id, title: e.finalTitle ?? e.title, sha: e.commitSha, files: impl.files })
  log(`#${e.id} fixed${e.committed ? ` (commit ${e.commitSha})` : ' (left uncommitted)'}`)
}

if (clusters.length > 0) {
  phase('Implement')
  for (const cl of clusters) {
    const lead = byId(cl.leadId)
    const siblings = cl.memberIds.filter((id) => id !== cl.leadId).map(byId)
    lead.clusterRootCause = cl.rootCause
    lead.clusterSiblings = siblings.map((s) => s.id)
    await implement(lead, siblings)
    for (const s of siblings) {
      s.clusterLead = lead.id
      if (lead.outcome === 'fixed') {
        const fix = priorFixes.find((p) => p.id === lead.id)
        const check = await run(siblingPrompt(s, lead, fix), { label: `sibling #${s.id} vs fix #${lead.id}`, phase: 'Cover', schema: SIBLING_SCHEMA, ...SIBLING_OPTS })
        if (check && check.covered) {
          s.outcome = 'covered'
          s.coveredBy = lead.id
          s.coveredReason = check.reason
          log(`#${s.id} covered by the fix for #${lead.id}`)
          continue
        }
        s.siblingGap = check ? check.reason : 'sibling check failed'
      }
      await implement(s, [])
    }
  }
}

log(`done: ${registry.filter((e) => e.outcome === 'fixed').length} fixed, ${registry.filter((e) => e.outcome === 'covered').length} covered, ${registry.filter((e) => e.outcome === 'not_fixed').length} confirmed not auto-fixed, ${registry.filter((e) => e.outcome === 'reverted').length} reverted, ${registry.filter((e) => e.status === 'agent_failed' || e.outcome === 'agent_failed').length} agent-failed, ${registry.filter((e) => e.status === 'refuted').length} refuted, ${finderFailures.length} finder(s) failed`)

return {
  scope: input.scope,
  implementerModel: IMPLEMENTER_MODEL,
  base: BASE,
  checksConfigured: CHECKS !== null,
  finderFailures,
  clusters,
  fixes: priorFixes,
  uncommittedFixFiles: [...uncommittedFixFiles],
  possiblyDirty: [...possiblyDirty],
  findings: registry.map((e) => ({
    id: e.id,
    dimension: e.dimension,
    title: e.finalTitle ?? e.title,
    originalTitle: e.title,
    file: e.file,
    line: e.line,
    claimedSeverity: e.severity,
    severity: e.finalSeverity ?? e.severity,
    description: e.finalDescription ?? e.description,
    corrected: e.corrected === true,
    status: e.status,
    refutedBy: e.refutedBy ?? null,
    refuteReason: e.refuteReason ?? null,
    failedAt: e.failedAt ?? null,
    alsoReportedBy: e.alsoReportedBy,
    verdicts: e.verdicts,
    outcome: e.outcome ?? null,
    committed: e.committed ?? null,
    commitSha: e.commitSha ?? null,
    files: e.implementation ? e.implementation.files : null,
    kinds: e.implementation ? e.implementation.kinds : null,
    hunks: e.implementation ? e.implementation.hunks : null,
    checks: e.implementation ? e.implementation.checks : null,
    plan: e.implementation ? e.implementation.plan : null,
    reason: e.implementation ? e.implementation.reason : null,
    excludedKind: e.implementation ? e.implementation.excludedKind : null,
    notes: e.implementation ? e.implementation.notes : null,
    coveredBy: e.coveredBy ?? null,
    coveredReason: e.coveredReason ?? null,
    siblingGap: e.siblingGap ?? null,
    clusterLead: e.clusterLead ?? null,
    clusterSiblings: e.clusterSiblings ?? null,
    clusterRootCause: e.clusterRootCause ?? null,
  })),
}
