export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial code review over a scope: finders per dimension, dedup at intake, two skeptics per finding, root-cause clustering, implementers that commit their own fix',
  phases: [
    { title: 'Prepare', detail: 'Sonnet lists the untracked and the dirty paths at launch, unless args carry them', model: 'sonnet' },
    { title: 'Find', detail: 'one finder per dimension: Opus at medium effort for production code, Sonnet at high effort for a dimension with production=false', model: 'opus' },
    { title: 'Dedup', detail: 'Sonnet intake check against the registered findings in the same file', model: 'sonnet' },
    { title: 'Verify', detail: 'Sonnet materiality skeptic, then Sonnet technical skeptic; their verdicts gate the finding and grade the report, never what the implementer reads', model: 'sonnet' },
    { title: 'Cluster', detail: 'group confirmed findings by root cause', model: 'opus' },
    { title: 'Implement', detail: 'one implementer per cluster (the session model unless args.implementerModel overrides), strictly sequential, commits its own fix' },
    { title: 'Cover', detail: 'Opus check whether a cluster fix also closes its siblings', model: 'opus' },
    { title: 'Cleanup', detail: 'Sonnet tree restore after a dead implementer', model: 'sonnet' },
  ],
}

// Never resume a dead run with resumeFromRunId: the cache key of each agent
// call chains every call issued before it, and the finders and skeptics issue
// theirs in the order earlier calls finish, so a resume misses partway through,
// re-runs the rest live against a tree that already holds the fixes, and the
// skeptics refute every finding as already fixed. Relaunch instead.
const SCOPES = ['uncommitted', 'branch', 'unpushed', 'codebase']
const SEVERITIES = ['nit', 'low', 'medium', 'high', 'critical']

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('args.root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('args.base: the commit bounding the diff is required for every scope except codebase')
}
// merge-ready passes both, derived from its own launch state; a standalone run
// omits both and lists them here.
if ((input.dirtyAtLaunch === undefined) !== (input.untracked === undefined)
  || (input.untracked !== undefined && (!Array.isArray(input.dirtyAtLaunch) || !Array.isArray(input.untracked)))) {
  throw new Error('args.dirtyAtLaunch and args.untracked: pass both as string[] or omit both to have the workflow list them')
}
if (!Array.isArray(input.dimensions) || input.dimensions.length === 0) {
  throw new Error('args.dimensions: non-empty [{key, title, focus, files: string[], production?: boolean}] is required; a files entry ending in / stands for every file in scope under that directory')
}
for (const d of input.dimensions) {
  if (!d || !d.key || !d.title || !d.focus || !Array.isArray(d.files) || d.files.length === 0) {
    throw new Error(`args.dimensions: every entry needs key, title, focus and a non-empty files list (offending: ${JSON.stringify(d)})`)
  }
  if (d.production !== undefined && typeof d.production !== 'boolean') {
    throw new Error(`args.dimensions: production is a boolean when given (offending: ${JSON.stringify(d)})`)
  }
}
if (typeof input.context !== 'string' || !input.context.trim()) {
  throw new Error('args.context: a string describing the project (stack, agent docs to quote, commit convention) is required')
}
if (input.loopFields !== undefined && typeof input.loopFields !== 'boolean') {
  throw new Error('args.loopFields: true to return the fields merge-ready\'s loop reads (each finding\'s finder, an uncommitted fix\'s hunks); omit it otherwise')
}
if (input.implementerModel !== undefined && (typeof input.implementerModel !== 'string' || !input.implementerModel.trim())) {
  throw new Error('args.implementerModel: a model name (e.g. opus, sonnet, haiku) when given; omit it to run the implementers on the session model')
}
if (input.intent !== undefined && (typeof input.intent !== 'string' || !input.intent.trim())) {
  throw new Error("args.intent: a non-empty string when given (the author's note on what the diff deliberately does); omit it otherwise")
}
if (input.authorEnd !== undefined && (typeof input.authorEnd !== 'string' || !/^[0-9a-f]{7,40}$/.test(input.authorEnd) || input.scope === 'codebase')) {
  throw new Error("args.authorEnd: the hex commit the author's commits end at (HEAD at launch), only for a scope with a base; omit it otherwise")
}

const ROOT = input.root
const BASE = input.base || null
const DIMENSIONS = input.dimensions
// Only merge-ready reads a finding's finder and an uncommitted fix's hunks; a
// standalone run neither returns them nor has the implementers paste the hunks.
const LOOP_FIELDS = input.loopFields === true
const CHECKS = typeof input.checks === 'string' && input.checks.trim() ? input.checks.trim() : null
// The author's intent: a note, verbatim, and the commits up to authorEnd. A
// removal it states is a decision the finders test for breakage, not a loss to
// restore.
const INTENT = typeof input.intent === 'string' && input.intent.trim() ? input.intent.trim() : null
const AUTHOR_END = input.authorEnd || null
// The implementers inherit the session model unless the user picked another; effort stays tied to severity.
const IMPLEMENTER_MODEL = input.implementerModel ? input.implementerModel.trim() : null

// A dimension holding no production code (docs, tests, CI) gets a Sonnet finder
// at high effort; any other, including one that omits production, gets Opus.
const finderOpts = (d) => (d.production === false ? { model: 'sonnet', effort: 'high' } : { model: 'opus', effort: 'medium' })
const DEDUP_OPTS = { model: 'sonnet', effort: 'medium' }
const CLUSTER_OPTS = { model: 'opus', effort: 'medium' }
const SIBLING_OPTS = { model: 'opus', effort: 'high' }
const CLEANUP_OPTS = { model: 'sonnet', effort: 'low' }
// The skeptics run once per finding, so they run on Sonnet; what they settle
// (severity, corrected wording) reaches the report only, never the clustering,
// the sibling check or the implementer. Both run at high effort except on a
// nit, taken as the higher of the finder's and the settled severity so that a
// downgrade never lowers the technical skeptic's effort.
const skepticOpts = (...severities) => ({ model: 'sonnet', effort: severities.every((s) => s === 'nit') ? 'medium' : 'high' })
const implementerOpts = (severity) => ({ ...(IMPLEMENTER_MODEL ? { model: IMPLEMENTER_MODEL } : {}), effort: { nit: 'low', low: 'medium' }[severity] ?? 'high' })

// ---------- shared prompt fragments ----------

const SCOPE_LABEL = {
  uncommitted: 'the uncommitted changes',
  branch: 'the branch diff',
  unpushed: 'the unpushed work (unpushed commits plus uncommitted changes)',
  codebase: 'the entire codebase',
}

let untrackedInScope = new Set(input.untracked || [])

function scopeText() {
  if (input.scope === 'codebase') {
    return `Review scope: ${SCOPE_LABEL.codebase}, every tracked file plus untracked files. There is no base commit: read files whole with cat/sed.`
  }
  // The untracked paths are not listed here: every agent reads this, and the
  // finders get theirs marked in their own file list.
  return `Review scope: ${SCOPE_LABEL[input.scope]}, i.e. the working tree against base commit ${BASE}, plus untracked files. Read a file's hunks with \`git diff ${BASE} -- <path>\`, the pre-change file with \`git show ${BASE}:<path>\`, the file list with \`git diff --stat ${BASE}\` and \`git ls-files -o --exclude-standard\`, and the surrounding current code with cat/sed. A path in scope whose diff is empty is untracked: read it whole.`
}

// The commit messages are never pasted: a branch, or the commits earlier
// rounds of a review loop added, can run to hundreds, and every agent reading
// all of them would exhaust its context. Each agent reads the author's
// messages for the paths it works on.
function intentText() {
  const parts = []
  if (INTENT) parts.push(`The author's note on what the diff deliberately does, verbatim:\n<<<\n${INTENT}\n>>>`)
  if (AUTHOR_END) {
    const end = AUTHOR_END.slice(0, 9)
    const authored = AUTHOR_END.startsWith(BASE) || BASE.startsWith(AUTHOR_END)
      ? 'The author made no commit in scope.'
      : `The author's commits are ${BASE.slice(0, 9)}..${end}; their messages state what the diff deliberately does. Read them for the paths you work on, \`git log --format='--- %h%n%B' ${BASE}..${end} -- <paths>\`, never for the whole range at once: it can hold hundreds of commits.`
    parts.push(`${authored} Every commit after ${end} was made by this review (an earlier round of it or this one), not by the author, and carries none of the author's decisions. Never list those commits wholesale either; \`git merge-base --is-ancestor ${end} <sha>\` says whether a commit you meet (in a blame, a file's log) is one of them.`)
  }
  if (!parts.length) return ''
  return `\nAuthor's intent for this diff. A removal the intent states is a decision, not a defect, unless it breaks something that still exists.\n${parts.join('\n')}`
}

const INTENT_TEXT = intentText()

// Rules both the finders and the materiality skeptic apply, written once so the
// two cannot drift apart.
const DEAD_CODE = 'dead code (an unreachable branch, an unused export, an obsolete option)'
const STALE_TERMINOLOGY = "stale terminology (a term the project's domain or agent docs mark as avoided, deprecated or replaced, on any surface: prompts, identifiers, comments, copy, docs, tests)"
const INCOMPLETE_FIX = "when the author's intent says the diff fixes a failure, an instance of that failure left on a code path the diff changed is an incomplete fix, not a pre-existing condition: it counts as introduced, at the severity of the failure itself, not of the false claim"
const UNPROMPTED_BEHAVIOUR = 'working autonomously, batching calls, summarising what it retrieves, retrying a weak search, asking specific questions'
const NON_INFERABLE_CONTRACT = 'a format, a limit, a fact about the environment, what the tool accepts or returns'
const HOLLOW_TEST = "recomputes the implementation's formula from the same constants, or asserts what a stub or hand-written mock returns"

// Clustering, the sibling check and the technical skeptic judge neither
// severity nor intent, and the implementer works from the finder's severity, so
// each agent gets only the parts it uses.
const PROJECT = `Repository: ${ROOT}.
${input.context.trim()}
${scopeText()}`
const PROJECT_INTENT = `${PROJECT}${INTENT_TEXT}`
const SEVERITY_SCALE = `Severity scale: critical = data loss or corruption, a security breach, or a crash of the production process; high = wrong behaviour on a path users hit in normal use, a deadlock, hang or resource leak under normal load, a cost or quality regression on every request of an affected configuration (a cache miss, dropped context), or a security or tenancy gap; medium = wrong behaviour on an edge path, a real leak or race that is hard to hit, a convention violation the project's agent docs state explicitly, or a false statement in docs or comments a maintainer would act on; low = a demonstrably false statement shipped to users (UI copy, translations, docs, error messages), a misleading comment, ${DEAD_CODE} or ${STALE_TERMINOLOGY}, or a small robustness issue with no user-visible effect today; nit = a cosmetic flaw that changes no behaviour and misleads no one: a typo or grammar slip (in copy, docs, comments, log text or an identifier) or a name that breaks the pattern of the names around it.`
const CONTEXT = `${PROJECT_INTENT}\n${SEVERITY_SCALE}`

const READ_ONLY = `You are READ-ONLY with respect to the repository: do not edit, create or delete files under ${ROOT}, and run no git command that changes state (no checkout, restore, stash, commit, reset, clean). Scratch files go in /tmp. You may run existing tests and small scripts from /tmp.`

// Keys and titles only: every finder reads it, and the files of the others add
// nothing to knowing which angle is whose.
const DIMENSION_LIST = DIMENSIONS.map((d) => `- ${d.key}: ${d.title}`).join('\n')

// The kinds of fix never auto-applied, each with the key the implementer
// reports when it refuses one. These are the only grounds for refusing a fix.
const EXCLUSIONS = {
  'design-decision': 'a fix that needs a behaviour or product choice the code, the finding and the author\'s intent do not settle',
  'new-infra': 'a new CI job or new infrastructure',
  'public-api': 'an export or public signature changed with a consumer outside this repo, or a consumer the fix cannot update',
  schema: 'the DB schema, a new migration, or a migration present at the base commit (every migration in a codebase review)',
  dependency: 'a dependency change',
  'unnamed-file': 'a file you may not touch: you may touch the files the finding or the clustering named, the tests covering them, and the direct callers of the code you change',
}
const EXCLUSION_KEYS = Object.keys(EXCLUSIONS)
const EXCLUDED = `Never auto-applied; report the key as excludedKind:\n${EXCLUSION_KEYS.map((k) => `- ${k}: ${EXCLUSIONS[k]}`).join('\n')}`

// Every agent reads the finding as the finder wrote it: the skeptics' severity
// and corrections are for the report. The skeptics and the sibling check judge
// the defect, not how to fix it, so they get it without the suggested fix.
function findingText(e, withFix = true) {
  return `Finding #${e.id} [${e.severity}] ${e.title}\nLocation: ${e.file}:${e.line}\nDescription: ${e.description}\nEvidence: ${e.evidence}${withFix ? `\nSuggested fix: ${e.suggestedFix}` : ''}`
}

// A confirmed finding without the finder's evidence and suggested fix, for the
// agents that read the code or the applied fix instead.
function briefText(e) {
  return `Finding #${e.id} [${e.severity}] ${e.title}\nLocation: ${e.file}:${e.line}\nDescription: ${e.description}`
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
    verdict: { type: 'string', enum: ['refute', 'downgrade', 'upgrade', 'confirm'] },
    severity: { type: 'string', enum: SEVERITIES, description: 'The severity you settle on: for downgrade or upgrade the new one, for confirm the finding\'s.' },
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
    reason: { type: 'string', description: 'What you verified and how (code read, commands run).' },
  },
  required: ['verdict', 'correctedTitle', 'correctedDescription', 'reason'],
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
    outcome: { type: 'string', enum: ['applied', 'covered', 'not_applied', 'reverted'], description: 'applied: a fix is in the tree (committed or not). covered: the defect can no longer occur in the current tree, nothing changed. not_applied: an excluded kind, nothing changed. reverted: you applied a fix, a check could not pass without going beyond the finding, and you undid your own hunks.' },
    plan: { type: 'string', description: 'For not_applied or reverted: the smallest fix you identified, in enough detail for a maintainer to apply it by hand. Empty when outcome is applied or covered.' },
    reason: { type: 'string', description: 'Why you did or did not apply it: applied / excluded kind (which, and what in the fix triggers it) / covered / which check could not pass.' },
    excludedKind: { type: ['string', 'null'], enum: [...EXCLUSION_KEYS, null], description: 'For not_applied: the key of the excluded kind that applies; null for every other outcome.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you changed or created (empty unless outcome is applied).' },
    ...(LOOP_FIELDS ? { hunks: { type: 'string', description: 'The `git diff` of your change when you left it uncommitted; empty when you committed it (the commit carries it) and unless outcome is applied.' } } : {}),
    committed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    notes: { type: 'string', description: 'Anything beyond the finding that a more complete fix would need; empty when nothing.' },
  },
  required: ['outcome', 'plan', 'reason', 'excludedKind', 'files', ...(LOOP_FIELDS ? ['hunks'] : []), 'committed', 'commitSha', 'notes'],
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

// A files entry ending in / stands for every file in scope under it, so a
// codebase-wide cut never spells out thousands of paths.
function finderPrompt(d) {
  const own = d.files.map((f) => `- ${f}${f.endsWith('/') ? ' (every file in scope under it)' : untrackedInScope.has(f) ? ' (untracked: read whole)' : ''}`).join('\n')
  const listDir = input.scope === 'codebase'
    ? '`git ls-files -co --exclude-standard -- <dir>`'
    : `\`git diff --name-only ${BASE} -- <dir>\` plus \`git ls-files -o --exclude-standard -- <dir>\``
  const preExisting = input.scope === 'codebase'
    ? 'There is no base, so every defect in the files counts, whatever its age.'
    : `Only defects the diff introduced or worsened. Pre-existing conditions the diff did not touch are out of scope unless the diff makes them worse. But ${INCOMPLETE_FIX}.`
  return `${CONTEXT}

${READ_ONLY}

You are the specialized FINDER for the review dimension "${d.key}: ${d.title}".
Your focus: ${d.focus}
Files you own:
${own}${d.files.some((f) => f.endsWith('/')) ? `\nList the files under a directory entry with ${listDir}.` : ''}

All dimensions in this review (other finders own the others; stay on yours, but report a defect you can only see from your files even when its root lies in a file another dimension owns, and say so):
${DIMENSION_LIST}

Method: ${input.scope === 'codebase' ? 'read every file you own in full' : 'read every hunk of every file you own (untracked files whole)'}, then the surrounding current code and whatever callers or callees you need to be sure. Where a claim can be tested cheaply (a regex, a library contract, a runtime behaviour), test it with a small script in /tmp, by reading the library sources in node_modules or the equivalent, or by running an existing test. Report only what you verified: fewer, verified findings are worth more than many speculative ones.

Rules:
- Report real defects: wrong behaviour, security or tenancy gaps, races, leaks, data loss, regressions, contradictions between code and docs or copy, ${DEAD_CODE}, ${STALE_TERMINOLOGY}, and violations of rules you can quote from the project's agent docs.
- Report each defect once, at its root location (the line whose change fixes it), even when several files you read expose it.
- ${preExisting}
- Judge a change by what it breaks, not by which commit carries it. A deletion is a defect only when you can name the code path, user or doc that still depends on what was deleted.
- An instruction deleted from an LLM prompt or tool description is a defect only when the model, without it, breaks a contract it cannot infer (${NON_INFERABLE_CONTRACT}). Coaching a current model follows unprompted (${UNPROMPTED_BEHAVIOUR}) is not a defect to restore.
- A demonstrably false statement in user-facing copy, docs or error messages is a finding regardless of audience size. A false statement in a code comment counts only when a maintainer acting on it would introduce a bug or miss one.
- A missing test is not a finding. A deleted test is one only when it could fail on a plausible regression of code that still exists; a test that ${HOLLOW_TEST}, is not coverage.
- A cosmetic flaw the severity scale rates nit is a finding at nit. Style preferences without a quotable rule and speculative hardening are not findings.
- Give the exact file and line in the current working tree. An empty findings list is a valid answer.`
}

// Findings are reported at their root location, the line whose change fixes
// them, so a duplicate shares the new finding's file; only those are compared,
// and a finding with none gets no dedup agent at all.
function dedupPrompt(f, dim, candidates) {
  const list = candidates.map((c) => `- id ${c.id}: "${c.title}" at ${c.file}:${c.line}\n  ${c.description}`).join('\n')
  return `You are the DEDUP check of a code review. A new finding just arrived from finder "${dim}". Compare it with every registered finding in the same file below and say whether it is the same defect as one of them.
Definition: two findings are the same defect when one change at one location fixes both. Findings that are merely related, in the same file, or share a theme are not the same defect. When in doubt, answer null (not a duplicate).

New finding:
Title: ${f.title}
Location: ${f.file}:${f.line}
Description: ${f.description}
Suggested fix: ${f.suggestedFix}

Registered findings in ${f.file} (read the code at a location when a description alone leaves it open):
${list}

Answer with the id of the registered finding it duplicates, or null.`
}

function materialityPrompt(e) {
  const preExisting = input.scope === 'codebase'
    ? ''
    : `; a pre-existing condition the diff neither introduced nor worsened (check with \`git diff ${BASE} -- <file>\` and \`git show ${BASE}:<file>\`); but ${INCOMPLETE_FIX}`
  return `${CONTEXT}

${READ_ONLY}

You are the MATERIALITY skeptic in an adversarial code review. Your job is to attack whether this finding matters, refuting by default when uncertain about its substance.

${findingText(e, false)}

Your verdict is four-way:
- refute: the finding's substance fails. Valid grounds, and no others:
  - a style preference no quotable rule states${preExisting};
  - a documented tradeoff that covers this specific regression (an ADR or doc accepting a related fallback does not excuse a new gap in a component that does implement the mechanism);
  - a removal the author's intent states, as a named item or as the general rule the commit applies, when the finding names no surviving code path, user or doc that depends on the deleted thing; a commit made by an earlier round of this review shows none of the author's decisions;
  - a deleted prompt or tool-description instruction that restates behaviour a current model shows unprompted (${UNPROMPTED_BEHAVIOUR}); the loss is real only for a contract the model cannot infer (${NON_INFERABLE_CONTRACT});
  - a deleted test that could not fail on a plausible regression: one that ${HOLLOW_TEST}.
  A change lying outside its commit's stated scope is not a ground to confirm; judge it by what it breaks.
- downgrade: the mechanism is real but the impact is overstated. Severity inflation alone is not a kill ground: downgrade and confirm. Say the severity you settle on. A downgrade because the path is rare, the configuration unlikely or the input unusual quotes the config, seed data, docs or callers that show it; without that evidence, keep the finding's severity.
- upgrade: the mechanism is as described and its consequence sits in a higher tier of the severity scale than the finding claims. Quote the code, config or callers that place it there, and say the severity you settle on.
- confirm: the finding is material at its stated severity.

Carve-outs, where you may downgrade (e.g. to low) but must not refute:
- A demonstrably false statement shipped to users (UI copy, translations, user-facing docs, error messages) is material by definition, however small its audience. "Nothing consumes it" and "no decision depends on it" are not valid kill grounds for factual incorrectness.
- ${DEAD_CODE[0].toUpperCase()}${DEAD_CODE.slice(1)} and ${STALE_TERMINOLOGY} are material by definition: stale code misleads the next reader and spreads. A vocabulary rule applies to every surface in the repository unless the doc exempts that surface by name; do not narrow its scope by inference. "No user can see the mismatch", "the surrounding text already pins the correct term" and "other shipped code uses the same term" are not valid kill grounds; the last one widens the finding rather than refuting it.
- A cosmetic flaw the severity scale rates nit is material at nit: downgrade a cosmetic-only finding to nit rather than refute it.

Do not judge technical truth here (a later skeptic does); assume the mechanism is as described and ask whether it matters. Read the code and the docs you need to decide. Quote the code or doc your verdict rests on.`
}

function technicalPrompt(e) {
  return `${PROJECT}

${READ_ONLY}

You are the TECHNICAL skeptic in an adversarial code review. Your job is to attack whether this finding is technically true, refuting by default when uncertain whether the failure mechanism is real at all. A materiality skeptic already confirmed it matters.

${findingText(e, false)}

Verify it yourself: read the code at the location and along the path the finding names, read library sources when the claim depends on their behaviour, and run a small experiment from /tmp or an existing test when that settles it. Do not take the finder's evidence on trust. Try to construct the concrete input or sequence; if it cannot happen, refute.

Your verdict is three-way:
- refute: the mechanism does not exist, or the code already handles it, or the trigger cannot occur. Uncertainty about whether the mechanism is real at all defaults to refute.
- confirm_corrected: a detail in the finding is wrong (bad arithmetic, misattributed cause, overstated scenario) but your own verification shows the underlying defect is real in a corrected form at the same location. Give the corrected description; the report carries it. A correction must be something you actually verified, not a charitable reinterpretation.
- confirm_as_is: the finding is right as written.

A wrong detail is only a kill ground when the failure mechanism collapses with it. Quote the code your verdict rests on.`
}

function clusterPrompt(confirmed) {
  return `${PROJECT}

${READ_ONLY}

You are the ROOT-CAUSE CLUSTERING agent. Group the confirmed findings below by root cause and name a lead finding per cluster. Findings in different files belong to one cluster when a single change fixes them all (a cap change and the viewers it silently truncates; a missing predicate and the endpoints that rely on it). Findings that merely share a file, a theme or a subsystem are separate clusters. When unsure, keep them separate: one implementer handles a whole cluster, and a wrong merge makes it fix things the lead finding does not name.

The lead of a cluster is the finding whose location is where the single change goes, preferring the highest severity when several qualify.

Read the code at each location before deciding. Every finding id must appear in exactly one cluster (a singleton cluster is fine).

Confirmed findings:
${confirmed.map(briefText).join('\n\n')}`
}

// Files never swept into a commit or restored with git: the user's uncommitted
// work at launch, plus fixes earlier in this run that had to stay uncommitted
// because they overlapped that work.
let protectedFiles = new Set(input.dirtyAtLaunch || [])
const uncommittedFixFiles = new Set()
const priorFixes = []

// Every fix is either committed or left in a protected file, so the paths
// `git status` lists when an implementer starts are exactly the protected ones,
// and no prompt carries the list: for an uncommitted scope it is every file.
const PROTECTED_TEXT = 'Before you edit anything, run `git status --porcelain`: every path it lists is PROTECTED, holding the user\'s uncommitted work at launch or a fix from earlier in this run that had to stay uncommitted. Everything else in the tree is committed. Never run git checkout, restore, stash, reset or clean on a protected path, never stage it, and undo your own hunks in it by editing the file back by hand.'

function checksText() {
  if (CHECKS) {
    return `Then run the project checks relevant to what you touched:\n${CHECKS}\nFix what they flag without going beyond the finding. A check you cannot make pass that way means you undo your own hunks (\`git checkout -- <file>\` for a file that is not protected, editing back by hand for a protected one, deleting files you created) and return outcome=reverted with the plan and the reason.`
  }
  return 'No check command is known for this project. Verify your change by reading it against its callers and by running the existing tests that cover the files you touched, if any.'
}

function implementerPrompt(e, siblings) {
  const sev = e.severity
  const sibText = siblings.length
    ? `\nThis finding leads a cluster; the single change that fixes it should also fix these siblings (the clustering attached their files to your allowed set):\n${siblings.map((s) => findingText(s)).join('\n\n')}\n`
    : ''
  return `${PROJECT_INTENT}

You are the IMPLEMENTER for one confirmed finding. You may edit files under ${ROOT}. Nobody reviews your change after you: you are the last line. Judge your own diff the way the maintainer reviewing the merge request would; they send back anything bigger than the finding.

${PROTECTED_TEXT}

${findingText(e)}
${sibText}
Plan your own fix: read the code around the finding (if the defect can no longer occur, change nothing and return outcome=covered), decide the smallest change that closes it (severity ${sev}), then check that change against the excluded kinds:
${EXCLUDED}

Minimal is relative to the finding, not to any larger plan: when a more complete fix exists beyond the finding, close the finding and describe the rest in notes. Never extend a fix to a sibling component the finding did not name (that is a new finding). Follow the project's agent docs for any code or test you write; a test must never add complexity to production code (no test-only parameters, seams or exports), never assert a still-present bug, and never read source as text. A finding whose only defect is a missing test is fixed by adding that test. When a comment, doc or tool description warns about a defect in code, fix the code, not the warning.

Size alone is never a reason to refuse. If the smallest fix is an excluded kind, change nothing and return outcome=not_applied with the plan, the reason and its key as excludedKind.

Otherwise: make the change. ${checksText()}

Commit rule: when none of the files you changed or created is protected, commit the fix yourself: \`git add <exactly your files>\`, then \`git commit\` with a message in the project's commit convention (from the context above; default \`type(scope): subject\`), with no attribution lines or trailers; report committed=true and the sha. When any file you changed is protected, leave the whole fix uncommitted and report committed=false: never commit a whole file to get around the overlap.

Report outcome=applied with exactly the files you changed${LOOP_FIELDS ? ", your own hunks pasted only when the fix stays uncommitted (a protected file's diff also holds the user's work)" : ''}, and the commit state. Finish with \`git status --porcelain\` and make sure your report matches it: nothing of yours may remain in the tree after not_applied, covered or reverted.`
}

function siblingPrompt(s, lead, fix) {
  const where = fix.sha
    ? `commit ${fix.sha}; inspect it with \`git show ${fix.sha}\``
    : `uncommitted in the working tree; inspect it with \`git diff -- ${fix.files.join(' ')}\``
  return `${PROJECT}

${READ_ONLY}

You are checking a cluster SIBLING. The clustering agent said one change fixes both finding #${lead.id} and the sibling below. The fix for #${lead.id} has been applied (${where}).

Lead finding:
${briefText(lead)}

Sibling finding to check:
${findingText(s, false)}

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

// ---------- the launch state ----------

// Listed here when the args omit it, so the launching session never carries
// the paths. --no-renames lists both sides of a rename.
const GIT = 'git -c core.quotePath=false'
const PREPARE_OPTS = { model: 'sonnet', effort: 'low' }
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
const PREPARE_SECTIONS = [
  { name: 'untracked', cmd: `${GIT} ls-files -o --exclude-standard` },
  { name: 'dirty', cmd: `{ ${GIT} diff --name-only --no-renames HEAD; ${GIT} ls-files -o --exclude-standard; } || :` },
]

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
  return `You are a helper of the adversarial review workflow the user launched on the repository ${ROOT}. The workflow's script cannot run commands itself, so it asks you to run one and hand back its output: ${what}. The command only reads git state; it changes nothing. The \`${MARKER}\` lines are headers the script splits the output on.`
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

// A materiality verdict moves the severity only when it says so and names a
// valid one; confirm keeps the severity the skeptic was shown.
function settledSeverity(mat, current) {
  const moves = mat.verdict === 'downgrade' || mat.verdict === 'upgrade'
  return moves && SEVERITIES.includes(mat.severity) ? mat.severity : current
}

async function verify(e) {
  const mat = await run(materialityPrompt(e), { label: `materiality #${e.id}`, phase: 'Verify', schema: MATERIALITY_SCHEMA, ...skepticOpts(e.severity) })
  if (!mat) {
    e.status = 'agent_failed'
    e.failedAt = 'materiality skeptic'
    return
  }
  if (mat.verdict === 'refute') {
    e.status = 'refuted'
    e.refutedBy = 'materiality'
    e.refuteReason = mat.reason
    log(`#${e.id} refuted on materiality`)
    return
  }
  e.finalSeverity = settledSeverity(mat, e.severity)

  const tech = await run(technicalPrompt(e), { label: `technical #${e.id}`, phase: 'Verify', schema: TECHNICAL_SCHEMA, ...skepticOpts(e.severity, e.finalSeverity) })
  if (!tech) {
    e.status = 'agent_failed'
    e.failedAt = 'technical skeptic'
    return
  }
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
  }
  e.status = 'confirmed'
  log(`#${e.id} confirmed at ${e.finalSeverity}`)
}

function registerAndVerify(f, dim) {
  const p = dedupChain.then(async () => {
    let dupOf = null
    const sameFile = registry.filter((c) => c.file === f.file)
    if (sameFile.length > 0) {
      const d = await run(dedupPrompt(f, dim, sameFile), { label: `dedup: ${f.title.slice(0, 50)}`, phase: 'Dedup', schema: DEDUP_SCHEMA, ...DEDUP_OPTS })
      if (d && d.duplicateOf !== null && sameFile.some((c) => c.id === d.duplicateOf)) dupOf = d.duplicateOf
    }
    if (dupOf !== null) {
      byId(dupOf).alsoReportedBy.push(dim)
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

if (input.untracked === undefined) {
  phase('Prepare')
  const { value: launch, error } = await runCopy(PREPARE_SECTIONS, 'the untracked and dirty paths the review starts from', 'prepare', 'Prepare', PREPARE_OPTS)
  if (!launch) throw new Error(`the launch state could not be read: ${error}`)
  untrackedInScope = new Set(launch.untracked)
  protectedFiles = new Set(launch.dirty)
}

phase('Find')
log(`scope ${input.scope}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, ${DIMENSIONS.length} finder dimension(s) (${DIMENSIONS.filter((d) => d.production === false).length} on Sonnet), ${protectedFiles.size ? `${protectedFiles.size} path(s) dirty at launch` : 'tree clean at launch'}, implementers on ${IMPLEMENTER_MODEL || 'the session model'}`)

await parallel(DIMENSIONS.map((d) => async () => {
  const res = await run(finderPrompt(d), { label: `find: ${d.key}`, phase: 'Find', schema: FINDINGS_SCHEMA, ...finderOpts(d) })
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
const sevRank = (e) => SEVERITIES.indexOf(e.severity)
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
  const impl = await run(implementerPrompt(e, siblings), { label: `implement #${e.id}`, phase: 'Implement', schema: IMPL_SCHEMA, ...implementerOpts(e.severity) })
  if (!impl) {
    e.outcome = 'agent_failed'
    e.failedAt = 'implementer'
    await cleanup(`the dead implementer for #${e.id}`)
    return
  }
  e.implementation = impl
  if (impl.outcome === 'covered') {
    e.outcome = 'covered'
    log(`#${e.id} already closed in the current tree`)
    return
  }
  if (impl.outcome === 'not_applied') {
    e.outcome = 'not_fixed'
    log(`#${e.id} not auto-fixed: excluded kind ${impl.excludedKind ?? 'unreported'}`)
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
  priorFixes.push({ id: e.id, title: e.title, sha: e.commitSha, files: impl.files })
  log(`#${e.id} fixed${e.committed ? ` (commit ${e.commitSha})` : ' (left uncommitted)'}`)
}

if (clusters.length > 0) {
  phase('Implement')
  for (const cl of clusters) {
    const lead = byId(cl.leadId)
    const siblings = cl.memberIds.filter((id) => id !== cl.leadId).map(byId)
    await implement(lead, siblings)
    for (const s of siblings) {
      if (lead.outcome === 'fixed') {
        const fix = priorFixes.find((p) => p.id === lead.id)
        const check = await run(siblingPrompt(s, lead, fix), { label: `sibling #${s.id} vs fix #${lead.id}`, phase: 'Cover', schema: SIBLING_SCHEMA, ...SIBLING_OPTS })
        if (check && check.covered) {
          s.outcome = 'covered'
          s.coveredBy = lead.id
          log(`#${s.id} covered by the fix for #${lead.id}`)
          continue
        }
      }
      await implement(s, [])
    }
  }
}

log(`done: ${registry.filter((e) => e.outcome === 'fixed').length} fixed, ${registry.filter((e) => e.outcome === 'covered').length} covered, ${registry.filter((e) => e.outcome === 'not_fixed').length} confirmed not auto-fixed, ${registry.filter((e) => e.outcome === 'reverted').length} reverted, ${registry.filter((e) => e.status === 'agent_failed' || e.outcome === 'agent_failed').length} agent-failed, ${registry.filter((e) => e.status === 'refuted').length} refuted, ${finderFailures.length} finder(s) failed`)

// The first sentence of a skeptic's reason: the report gives a refuted finding
// one line.
function firstSentence(text) {
  const reason = String(text || '')
  const end = reason.search(/[.!?](\s|$)/)
  const first = end >= 0 ? reason.slice(0, end + 1) : reason
  return first.length > 300 ? `${first.slice(0, 300)}…` : first
}

// Each finding carries only the fields its outcome is reported by: the result
// lands whole in the launching session, every round of it under merge-ready.
function reported(e) {
  const f = {
    id: e.id,
    title: e.finalTitle ?? e.title,
    file: e.file,
    line: e.line,
    severity: e.finalSeverity ?? e.severity,
    status: e.status,
  }
  // A refuted finding is reported by its title and the skeptic's reason, a
  // fixed or covered one by its title and the fix.
  if (e.status !== 'refuted' && e.outcome !== 'fixed' && e.outcome !== 'covered') f.description = e.finalDescription ?? e.description
  if (LOOP_FIELDS) f.dimension = e.dimension
  if (e.corrected) f.corrected = true
  if (e.alsoReportedBy.length) f.alsoReportedBy = e.alsoReportedBy
  if (e.status === 'refuted') Object.assign(f, { refutedBy: e.refutedBy, refuteReason: firstSentence(e.refuteReason) })
  if (e.failedAt) f.failedAt = e.failedAt
  if (!e.outcome) return f
  f.outcome = e.outcome
  const impl = e.implementation
  if (e.outcome === 'fixed') {
    Object.assign(f, { commitSha: e.commitSha, files: impl.files })
    if (impl.notes && impl.notes.trim()) f.notes = impl.notes
    // A commit carries its own hunks.
    if (LOOP_FIELDS && !e.committed && impl.hunks) f.hunks = impl.hunks
  } else if (e.outcome === 'covered') {
    f.coveredBy = e.coveredBy ?? null
  } else if (e.outcome === 'not_fixed') {
    Object.assign(f, { excludedKind: impl.excludedKind, plan: impl.plan })
  } else if (e.outcome === 'reverted') {
    Object.assign(f, { reason: impl.reason, plan: impl.plan })
  }
  return f
}

return {
  implementerModel: IMPLEMENTER_MODEL,
  checksConfigured: CHECKS !== null,
  // Only the exclusions a finding was refused under: the report quotes no other.
  excludedKinds: Object.fromEntries(EXCLUSION_KEYS.filter((k) => registry.some((e) => e.outcome === 'not_fixed' && e.implementation.excludedKind === k)).map((k) => [k, EXCLUSIONS[k]])),
  finderFailures,
  uncommittedFixFiles: [...uncommittedFixFiles],
  possiblyDirty: [...possiblyDirty],
  findings: registry.map(reported),
}
