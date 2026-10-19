export const meta = {
  name: 'adversarial-review',
  description: 'Adversarial code review over a scope: finders per dimension, dedup at intake, two skeptics per finding, root-cause clustering, implementers that commit their own fix',
  phases: [
    { title: 'Find', detail: 'one finder per dimension: Opus at medium effort for production code, Sonnet at high effort for a dimension with production=false', model: 'opus' },
    { title: 'Dedup', detail: 'Sonnet intake check against the registered findings in the same file, serialized per file', model: 'sonnet' },
    { title: 'Verify', detail: 'Sonnet materiality skeptic, then Sonnet technical skeptic; their verdicts gate the finding and grade the report, never what the implementer reads', model: 'sonnet' },
    { title: 'Cluster', detail: 'group confirmed findings by root cause', model: 'opus' },
    { title: 'Implement', detail: 'one implementer per cluster (the session model unless args.implementerModel overrides), strictly sequential, commits its own fix' },
    { title: 'Cover', detail: 'Opus check whether a cluster fix also closes its siblings, all of a cluster\'s siblings at once', model: 'opus' },
    { title: 'Cleanup', detail: 'Sonnet tree restore after every implementer, also listing the commits made by one that died or reported no commit sha', model: 'sonnet' },
  ],
}

const SCOPES = ['uncommitted', 'branch', 'unpushed', 'since', 'codebase']
const SEVERITIES = ['nit', 'low', 'medium', 'high', 'critical']

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !SCOPES.includes(input.scope)) {
  throw new Error(`args.scope must be one of ${SCOPES.join(', ')}`)
}
if (!input.root) throw new Error('args.root: absolute project root path is required')
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('args.base: the commit bounding the diff is required for every scope except codebase')
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
  throw new Error('args.loopFields: true to return the field merge-ready\'s loop reads (each finding\'s finder); omit it otherwise')
}
if (input.implementerModel !== undefined && (typeof input.implementerModel !== 'string' || !input.implementerModel.trim())) {
  throw new Error('args.implementerModel: a model name (e.g. opus, sonnet, haiku) when given; omit it to run the implementers on the session model')
}
if (input.intent !== undefined && (typeof input.intent !== 'string' || !input.intent.trim())) {
  throw new Error("args.intent: a non-empty string when given (the author's note on what the diff deliberately does); omit it otherwise")
}
if (input.checks !== undefined && (typeof input.checks !== 'string' || !input.checks.trim())) {
  throw new Error('args.checks: a non-empty string of check commands when given; omit it otherwise')
}
if (input.authorEnd !== undefined && (typeof input.authorEnd !== 'string' || !/^[0-9a-f]{7,64}$/.test(input.authorEnd) || input.scope === 'codebase')) {
  throw new Error("args.authorEnd: the hex commit the author's commits end at (HEAD at launch), only for a scope with a base; omit it otherwise")
}

const ROOT = input.root
const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
const GIT = `git -C ${shellQuote(ROOT)}`
const REPO = `Repository: ${ROOT}.`
const BASE = input.base || null
const DIMENSIONS = input.dimensions
const LOOP_FIELDS = input.loopFields === true
const CHECKS = input.checks ? input.checks.trim() : null
const INTENT = typeof input.intent === 'string' && input.intent.trim() ? input.intent.trim() : null
const AUTHOR_END = input.authorEnd || null
const IMPLEMENTER_MODEL = input.implementerModel ? input.implementerModel.trim() : null

const finderOpts = (d) => (d.production === false ? { model: 'sonnet', effort: 'high' } : { model: 'opus', effort: 'medium' })
const DEDUP_OPTS = { model: 'sonnet', effort: 'medium' }
const CLUSTER_OPTS = { model: 'opus', effort: 'medium' }
const SIBLING_OPTS = { model: 'opus', effort: 'high' }
const CLEANUP_OPTS = { model: 'sonnet', effort: 'low' }
const HEAD_OPTS = { model: 'haiku', effort: 'low' }
const skepticOpts = (...severities) => ({ model: 'sonnet', effort: severities.every((s) => s === 'nit') ? 'medium' : 'high' })
const implementerOpts = (severity) => ({ ...(IMPLEMENTER_MODEL ? { model: IMPLEMENTER_MODEL } : {}), effort: { nit: 'low', low: 'medium' }[severity] ?? 'high' })

const SCOPE_LABEL = {
  uncommitted: 'the work uncommitted at launch',
  branch: 'the branch diff',
  unpushed: 'the unpushed work',
  since: `the work since ${BASE}`,
  codebase: 'the entire codebase',
}

function scopeText() {
  if (input.scope === 'codebase') {
    return `Review scope: ${SCOPE_LABEL.codebase}, every tracked file. There is no base commit.`
  }
  return `Review scope: ${SCOPE_LABEL[input.scope]}, i.e. the tree against base commit ${BASE}. Read a file's hunks with \`git --literal-pathspecs diff ${BASE} -- <path>\` and the pre-change file with \`git show ${BASE}:<path>\`.`
}

function intentText() {
  const parts = []
  if (INTENT) parts.push(`The author's note on what the diff deliberately does, verbatim:\n<<<\n${INTENT}\n>>>`)
  if (AUTHOR_END) {
    const end = AUTHOR_END.slice(0, 9)
    const authored = AUTHOR_END.startsWith(BASE) || BASE.startsWith(AUTHOR_END)
      ? 'The author made no commit in scope.'
      : `The author's commits are ${BASE.slice(0, 9)}..${end}; their messages state what the diff deliberately does. Read them for the paths you work on, \`git --literal-pathspecs log --format='--- %h%n%B' ${BASE}..${end} -- <paths>\`, never for the whole range at once: it can hold hundreds of commits.`
    parts.push(`${authored} Every commit after ${end} was made by this review or the loop that launched it (its comment passes and earlier rounds), not by the author, and carries none of the author's decisions. Never list those commits wholesale either; a commit you meet (in a blame, a file's log) is one of them when it is not ${end} itself, which is the author's, and \`git merge-base --is-ancestor ${end} <sha>\` succeeds.`)
  }
  if (!parts.length) return ''
  return `\nAuthor's intent for this diff.\n${parts.join('\n')}`
}

const INTENT_TEXT = intentText()

const DEAD_CODE = 'dead code (an unreachable branch, an unused export, an obsolete option)'
const STALE_TERMINOLOGY = "stale terminology (a term the project's domain or agent docs mark as avoided, deprecated or replaced, on any surface: prompts, identifiers, comments, copy, docs, tests)"
const INCOMPLETE_FIX = "when the author's intent says the diff fixes a failure, an instance of that failure left on a code path the diff changed is an incomplete fix, not a pre-existing condition: it counts as introduced, at the severity of the failure itself, not of the false claim"
const UNPROMPTED_BEHAVIOUR = 'working autonomously, batching calls, summarising what it retrieves, retrying a weak search, asking specific questions'
const NON_INFERABLE_CONTRACT = 'a format, a limit, a fact about the environment, what the tool accepts or returns'
const HOLLOW_TEST = "recomputes the implementation's formula from the same constants, or asserts what a stub or hand-written mock returns"

const PROJECT = `${REPO}
${input.context.trim()}
${scopeText()}`
const PROJECT_INTENT = `${PROJECT}${INTENT_TEXT}`
const SEVERITY_SCALE = `Severity scale: critical = data loss or corruption, a security breach, or a crash of the production process; high = wrong behaviour on a path users hit in normal use, a deadlock, hang or resource leak under normal load, a cost or quality regression on every request of an affected configuration (a cache miss, dropped context), or a security or tenancy gap; medium = wrong behaviour on an edge path, a real leak or race that is hard to hit, a convention violation the project's agent docs state explicitly, or a false statement in docs or comments a maintainer would act on; low = a demonstrably false statement shipped to users (UI copy, translations, docs, error messages), ${DEAD_CODE} or ${STALE_TERMINOLOGY}, a small robustness issue with no user-visible effect today, or a defect reachable only under an unusual setup (an uncommon platform or repository configuration, a name that collides by chance, an agent or process dying in a narrow window) unless it loses or corrupts data; nit = a cosmetic flaw that changes no behaviour and misleads no one: a typo or grammar slip (in copy, docs, comments, log text or an identifier) or a name that breaks the pattern of the names around it.`
const CONTEXT = `${PROJECT_INTENT}\n${SEVERITY_SCALE}`

const READ_ONLY = `You are READ-ONLY with respect to the repository: do not edit, create or delete files under ${ROOT}, and run no git command that changes state. Scratch files and scripts go in /tmp; you may run existing tests.`

const DIMENSION_LIST = DIMENSIONS.map((d) => `- ${d.key}: ${d.title}`).join('\n')

const EXCLUSIONS = {
  'design-decision': 'a fix that needs a behaviour or product choice the code, the finding and the author\'s intent do not settle',
  'new-infra': 'a new CI job or new infrastructure',
  'public-api': 'an export or public signature changed with a consumer outside this repo, or a consumer the fix cannot update',
  schema: 'the DB schema, a new migration, or a migration present at the base commit (every migration in a codebase review)',
  dependency: 'a dependency change',
  'unnamed-file': 'a file you may not touch: you may touch the files the finding or the clustering named, the tests covering them, and the direct callers of the code you change',
}
const EXCLUSION_KEYS = Object.keys(EXCLUSIONS)
const EXCLUDED = `Never auto-applied:\n${EXCLUSION_KEYS.map((k) => `- ${k}: ${EXCLUSIONS[k]}`).join('\n')}`

const REFUTE_GROUNDS = {
  'style-preference': 'a style preference no quotable rule states',
  ...(input.scope === 'codebase' ? {} : { 'pre-existing': `a pre-existing condition the diff neither introduced nor worsened; but ${INCOMPLETE_FIX}` }),
  'documented-tradeoff': 'a documented tradeoff that covers this specific regression (an ADR or doc accepting a related fallback does not excuse a new gap in a component that does implement the mechanism)',
  'intended-removal': "a removal the author's intent states, as a named item or as the general rule the commit applies, when the finding names no surviving code path, user or doc that depends on the deleted thing; a commit made by an earlier round of this review shows none of the author's decisions",
  'unprompted-behaviour': `a deleted prompt or tool-description instruction that restates behaviour a current model shows unprompted (${UNPROMPTED_BEHAVIOUR}); the loss is real only for a contract the model cannot infer (${NON_INFERABLE_CONTRACT})`,
  'hollow-test': `a deleted test that could not fail on a plausible regression: one that ${HOLLOW_TEST}`,
}
const REFUTE_GROUND_KEYS = Object.keys(REFUTE_GROUNDS)

function findingText(e, withFix = true) {
  return `Finding #${e.id} [${e.severity}] ${e.title}\nLocation: ${e.file}:${e.line}\nDescription: ${e.description}\nEvidence: ${e.evidence}${withFix ? `\nSuggested fix: ${e.suggestedFix}` : ''}`
}

function briefText(e) {
  return `Finding #${e.id} [${e.severity}] ${e.title}\nLocation: ${e.file}:${e.line}\nDescription: ${e.description}`
}

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
    ground: { type: 'string', enum: [...REFUTE_GROUND_KEYS, 'none'], description: 'For refute: the key of the ground it rests on. none for any other verdict.' },
    severity: { type: 'string', enum: SEVERITIES, description: 'The severity you settle on: for downgrade or upgrade the new one, for confirm the finding\'s.' },
    reason: { type: 'string' },
  },
  required: ['verdict', 'ground', 'severity', 'reason'],
}

const TECHNICAL_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['refute', 'confirm'] },
    reason: { type: 'string', description: 'What you verified and how (code read, commands run).' },
  },
  required: ['verdict', 'reason'],
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
    outcome: { type: 'string', enum: ['applied', 'covered', 'not_applied', 'reverted'], description: 'applied: a fix is committed. covered: the defect can no longer occur in the current tree, nothing changed. not_applied: an excluded kind, nothing changed. reverted: you applied a fix, a check could not pass without going beyond the finding, and you undid your own hunks.' },
    plan: { type: 'string', description: 'For not_applied or reverted: the smallest fix you identified, in enough detail for a maintainer to apply it by hand. Empty when outcome is applied or covered.' },
    reason: { type: 'string', description: 'Why you did or did not apply it: applied / excluded kind (which, and what in the fix triggers it) / covered / which check could not pass.' },
    excludedKind: { type: ['string', 'null'], enum: [...EXCLUSION_KEYS, null], description: 'For not_applied: the key of the excluded kind that applies; null for every other outcome.' },
    files: { type: 'array', items: { type: 'string' }, description: 'Repo-relative paths you changed or created (empty unless outcome is applied).' },
    committed: { type: 'boolean' },
    commitSha: { type: ['string', 'null'] },
    notes: { type: 'string', description: 'Anything beyond the finding that a more complete fix would need; empty when nothing.' },
    head: { type: 'string', description: 'The full sha `git rev-parse HEAD` prints once you are done.' },
    clean: { type: 'boolean', description: 'Whether your final `git status --porcelain --untracked-files=all` printed nothing.' },
  },
  required: ['outcome', 'plan', 'reason', 'excludedKind', 'files', 'committed', 'commitSha', 'notes', 'head', 'clean'],
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
    leftDirty: { type: 'array', items: { type: 'string' }, description: 'Paths `git status --porcelain` still lists when you are done.' },
  },
  required: ['wasDirty', 'reverted', 'leftDirty'],
}

const DEAD_IMPLEMENTER_CLEANUP_SCHEMA = {
  type: 'object',
  properties: {
    ...CLEANUP_SCHEMA.properties,
    commits: { type: 'array', items: { type: 'string' }, description: 'The shas the git log printed, newest first.' },
    committedFiles: { type: 'array', items: { type: 'string' }, description: 'The paths the git diff --name-only printed.' },
  },
  required: [...CLEANUP_SCHEMA.required, 'commits', 'committedFiles'],
}

const HEAD_SCHEMA = {
  type: 'object',
  properties: { sha: { type: 'string' } },
  required: ['sha'],
}

function finderPrompt(d) {
  const own = d.files.map((f) => `- ${f}${f.endsWith('/') ? ' (every file in scope under it)' : ''}`).join('\n')
  const listDir = input.scope === 'codebase'
    ? '`git --literal-pathspecs ls-files -- <dir>`'
    : `\`git --literal-pathspecs diff --name-only ${BASE} -- <dir>\``
  const preExisting = input.scope === 'codebase'
    ? ''
    : `\n- Only defects the diff introduced or worsened. But ${INCOMPLETE_FIX}.`
  const others = DIMENSIONS.length > 1
    ? `\n\nAll dimensions in this review (other finders own the others; stay on yours, but report a defect you can only see from your files even when its root lies in a file another dimension owns, and say so):\n${DIMENSION_LIST}`
    : ''
  return `${CONTEXT}

${READ_ONLY}

You are the specialized FINDER for the review dimension "${d.key}: ${d.title}".
Your focus: ${d.focus}
Files you own:
${own}${d.files.some((f) => f.endsWith('/')) ? `\nList the files under a directory entry with ${listDir}.` : ''}${others}

Method: ${input.scope === 'codebase' ? 'read every file you own in full' : 'read every hunk of every file you own'}. Where a claim can be tested cheaply (a regex, a library contract, a runtime behaviour), test it with a small script in /tmp, by reading the library sources in node_modules or the equivalent, or by running an existing test. Report only what you verified: fewer, verified findings are worth more than many speculative ones.

Rules:
- Report every defect the severity scale rates, dead code, stale terminology and violations of rules you can quote from the project's agent docs included.
- Report each defect once, at its root location (the line whose change fixes it), even when several files you read expose it.${preExisting}
- Judge a change by what it breaks, not by which commit carries it. A deletion is a defect only when you can name the code path, user or doc that still depends on what was deleted.
- An instruction deleted from an LLM prompt or tool description is a defect only when the model, without it, breaks a contract it cannot infer (${NON_INFERABLE_CONTRACT}). Coaching a current model follows unprompted (${UNPROMPTED_BEHAVIOUR}) is not a defect to restore.
- A demonstrably false statement in user-facing copy, docs or error messages is a finding regardless of audience size. A false statement in a code comment counts only when a maintainer acting on it would introduce a bug or miss one.
- A missing test is not a finding. A deleted test is one only when it could fail on a plausible regression of code that still exists; a test that ${HOLLOW_TEST}, is not coverage.
- Style preferences without a quotable rule and speculative hardening are not findings.
- An empty findings list is a valid answer.`
}

function dedupPrompt(f, dim, candidates) {
  const list = candidates.map((c) => `- id ${c.id}: "${c.title}" at ${c.file}:${c.line}\n  ${c.description}`).join('\n')
  return `You are the DEDUP check of a code review. A new finding just arrived from finder "${dim}". Compare it with every registered finding in the same file below and say whether it is the same defect as one of them.
Definition: two findings are the same defect when one change at one location fixes both. Findings that are merely related, in the same file, or share a theme are not the same defect. When in doubt, answer null (not a duplicate).

New finding:
Title: ${f.title}
Location: ${f.file}:${f.line}
Description: ${f.description}
Suggested fix: ${f.suggestedFix}

Registered findings in ${f.file}:
${list}`
}

function materialityPrompt(e) {
  return `${CONTEXT}

${READ_ONLY}

You are the MATERIALITY skeptic in an adversarial code review. Your job is to attack whether this finding matters, refuting by default when uncertain about its substance.

${findingText(e, false)}

Your verdict is four-way:
- refute: the finding's substance fails. Valid grounds, and no others:
${REFUTE_GROUND_KEYS.map((k) => `  - ${k}: ${REFUTE_GROUNDS[k]}`).join(';\n')}.
  A change lying outside its commit's stated scope is not a ground to confirm; judge it by what it breaks.
- downgrade: the mechanism is real but the impact is overstated. Severity inflation alone is not a kill ground: downgrade and confirm. Lower a finding to the tier its rarity puts it in only when you quote the config, seed data, docs or callers that show that rarity; without that evidence, keep the finding's severity. Data loss or corruption keeps its tier however rare.
- upgrade: the mechanism is as described and its consequence sits in a higher tier of the severity scale than the finding claims.
- confirm: the finding is material at its stated severity.

Carve-outs, where you may downgrade (e.g. to low) but must not refute:
- A demonstrably false statement shipped to users (UI copy, translations, user-facing docs, error messages) is material by definition, however small its audience. "Nothing consumes it" and "no decision depends on it" are not valid kill grounds for factual incorrectness.
- ${DEAD_CODE[0].toUpperCase()}${DEAD_CODE.slice(1)} and ${STALE_TERMINOLOGY} are material by definition: stale code misleads the next reader and spreads. A vocabulary rule applies to every surface in the repository unless the doc exempts that surface by name; do not narrow its scope by inference. "No user can see the mismatch", "the surrounding text already pins the correct term" and "other shipped code uses the same term" are not valid kill grounds; the last one widens the finding rather than refuting it.
- A cosmetic flaw the severity scale rates nit is material at nit: downgrade a cosmetic-only finding to nit rather than refute it.

Do not judge technical truth here (a later skeptic does); assume the mechanism is as described and ask whether it matters. Quote the code or doc your verdict rests on.`
}

function technicalPrompt(e) {
  return `${PROJECT}

${READ_ONLY}

You are the TECHNICAL skeptic in an adversarial code review. Your job is to attack whether this finding is technically true, refuting by default when uncertain whether the failure mechanism is real at all. A materiality skeptic already confirmed it matters, and that judgement is not yours to redo: whether the impact is worth a fix, what the author intended, how a project rule or convention reads, and whether the condition predates the diff are never grounds to refute here.

${findingText(e, false)}

Do not take the finder's evidence on trust: read the code along the path the finding names yourself, and the library sources when the claim depends on their behaviour. Try to construct the concrete input or sequence. An experiment counts only when it ran under the conditions the finding names (its runtime, version, platform, configuration or timing); one that could not reproduce them is no evidence either way, and the code decides.

Your verdict is two-way:
- refute: the mechanism does not exist, or the code already handles it, or the trigger cannot occur.
- confirm: the defect is real at the location the finding names, even when a detail of it is wrong (bad arithmetic, misattributed cause, overstated scenario).

Quote the code your verdict rests on.`
}

function clusterPrompt(confirmed) {
  return `${PROJECT}

${READ_ONLY}

You are the ROOT-CAUSE CLUSTERING agent. Group the confirmed findings below by root cause and name a lead finding per cluster. Findings in different files belong to one cluster when a single change fixes them all (a cap change and the viewers it silently truncates; a missing predicate and the endpoints that rely on it). Findings that merely share a file, a theme or a subsystem are separate clusters. When unsure, keep them separate: one implementer handles a whole cluster, and a wrong merge makes it fix things the lead finding does not name.

The lead of a cluster is the finding whose location is where the single change goes, preferring the highest severity when several qualify.

Confirmed findings:
${confirmed.map(briefText).join('\n\n')}`
}

const priorFixes = []

function checksText() {
  if (CHECKS) {
    return `Then run the project checks relevant to what you touched:\n${CHECKS}\nFix what they flag without going beyond the finding. A check you cannot make pass that way means you undo your own hunks (\`git --literal-pathspecs checkout HEAD -- <file>\`, deleting files you created) and return outcome=reverted.`
  }
  return 'No check command is known for this project. Verify your change by reading it against its callers and by running the existing tests that cover the files you touched, if any.'
}

function implementerPrompt(e, siblings) {
  const sibText = siblings.length
    ? `\nThis finding leads a cluster; the single change that fixes it should also fix these siblings (the clustering attached their files to your allowed set):\n${siblings.map((s) => findingText(s)).join('\n\n')}\n`
    : ''
  return `${PROJECT_INTENT}

You are the IMPLEMENTER for one confirmed finding. Nobody reviews your change after you: you are the last line. Judge your own diff the way the maintainer reviewing the merge request would; they send back anything bigger than the finding.

The tree was clean when you started: everything in it is committed.

${findingText(e)}
${sibText}
Plan your own fix: decide the smallest change that closes the finding, then check that change against the excluded kinds:
${EXCLUDED}

Minimal is relative to the finding, not to any larger plan: when a more complete fix exists beyond the finding, close the finding and describe the rest in notes. Never extend a fix to a sibling component the finding did not name (that is a new finding). Follow the project's agent docs for any code or test you write; a test must never add complexity to production code (no test-only parameters, seams or exports), never assert a still-present bug, and never read source as text. When a comment, doc or tool description warns about a defect in code, fix the code, not the warning. Write no comments. When code needs one to be understood, reshape the code instead.

Size alone is never a reason to refuse.

Make the change. ${checksText()}

Commit rule: commit the fix yourself: \`git --literal-pathspecs add -A -- <exactly your files>\`, then \`git commit\` with a message in the project's commit convention, with no attribution lines or trailers.

Nothing of yours may remain in the tree after not_applied, covered or reverted.`
}

function siblingPrompt(s, lead, fix) {
  const where = fix.commits.length > 1
    ? `commits ${fix.commits.join(', ')}; inspect each with \`git show <sha>\``
    : `commit ${fix.sha}; inspect it with \`git show ${fix.sha}\``
  return `${PROJECT}

${READ_ONLY}

You are checking a cluster SIBLING. The clustering agent said one change fixes both finding #${lead.id} and the sibling below. The fix for #${lead.id} has been applied (${where}).

Lead finding:
${briefText(lead)}

Sibling finding to check:
${findingText(s, false)}

Answer covered=true only if the defect the sibling describes can no longer occur after the fix.`
}

function cleanupPrompt(why, since) {
  const commits = since
    ? ` Then list what it committed: run \`${GIT} log --format=%H ${since}..HEAD\` and \`${GIT} -c core.quotePath=false diff --name-only ${since} HEAD\`.`
    : ''
  return `Repository: ${ROOT}. The tree was clean before ${why} started, so anything uncommitted right now is its leftover and must be restored. Run \`${GIT} -c core.quotePath=false status --porcelain --untracked-files=all\`. For every listed path: unstage it with \`${GIT} --literal-pathspecs reset -q -- <path>\`, then run \`${GIT} --literal-pathspecs checkout -- <path>\` if HEAD tracks it (\`${GIT} cat-file -e HEAD:<path>\` succeeds), delete it otherwise.${commits} Do nothing else.`
}

const registry = []
let nextId = 1
const verifications = []
const finderFailures = []

function serializedPerKey() {
  const tails = new Map()
  return {
    run(key, task) {
      const p = (tails.get(key) || Promise.resolve()).then(task)
      tails.set(key, p.catch(() => undefined))
      return p
    },
    drained: () => Promise.all(tails.values()),
  }
}

const dedupPerFile = serializedPerKey()

function byId(id) {
  return registry.find((e) => e.id === id)
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
    e.refuteGround = REFUTE_GROUND_KEYS.includes(mat.ground) ? mat.ground : null
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
  e.status = 'confirmed'
  log(`#${e.id} confirmed at ${e.finalSeverity}`)
}

function registerAndVerify(f, dim) {
  return dedupPerFile.run(f.file, async () => {
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
    }
    registry.push(entry)
    log(`registered #${entry.id} [${entry.severity}] ${entry.title} (${dim})`)
    verifications.push(verify(entry))
  })
}

phase('Find')
log(`scope ${input.scope}${BASE ? ` against ${BASE.slice(0, 8)}` : ''}, ${DIMENSIONS.length} finder dimension(s) (${DIMENSIONS.filter((d) => d.production === false).length} on Sonnet), implementers on ${IMPLEMENTER_MODEL || 'the session model'}`)

await parallel(DIMENSIONS.map((d) => async () => {
  const res = await run(finderPrompt(d), { label: `find: ${d.key}`, phase: 'Find', schema: FINDINGS_SCHEMA, ...finderOpts(d) })
  if (!res) {
    finderFailures.push(d.key)
    log(`finder ${d.key} failed; its dimension was not reviewed`)
    return
  }
  const list = res.findings.filter((f) => f && f.title && f.file)
  log(`finder ${d.key}: ${list.length} finding(s)`)
  await Promise.all(list.map((f) => registerAndVerify(f, d.key)))
}))
await dedupPerFile.drained()
await Promise.all(verifications)

const confirmed = registry.filter((e) => e.status === 'confirmed')
log(`verification done: ${registry.length} registered, ${confirmed.length} confirmed, ${registry.filter((e) => e.status === 'refuted').length} refuted, ${registry.filter((e) => e.status === 'agent_failed').length} agent-failed`)

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

const possiblyDirty = new Set()
let implementerStart = null

async function cleanup(why, since = null) {
  const schema = since ? DEAD_IMPLEMENTER_CLEANUP_SCHEMA : CLEANUP_SCHEMA
  const r = await run(cleanupPrompt(why, since), { label: `cleanup after ${why}`, phase: 'Cleanup', schema, ...CLEANUP_OPTS })
  if (!r) {
    log(`cleanup after ${why} failed; the tree may hold stray hunks`)
    possiblyDirty.add('(cleanup agent failed: run git status)')
    return null
  }
  if (r.wasDirty) log(`cleanup after ${why}: restored ${r.reverted.join(', ') || 'nothing'}`)
  for (const f of r.leftDirty) possiblyDirty.add(f)
  return r
}

function recordFix(e, commits, files, notes) {
  const sha = commits[0]
  e.outcome = 'fixed'
  e.commitSha = sha
  e.implementation = { ...e.implementation, files, notes }
  priorFixes.push({ id: e.id, sha, commits })
  implementerStart = sha
}

async function implement(e, siblings) {
  if (possiblyDirty.size > 0) {
    e.outcome = 'agent_failed'
    e.failedAt = 'cleanup'
    log(`#${e.id} not attempted: an earlier cleanup could not restore the tree`)
    return
  }
  const impl = await run(implementerPrompt(e, siblings), { label: `implement #${e.id}`, phase: 'Implement', schema: IMPL_SCHEMA, ...implementerOpts(e.severity) })
  if (!impl) {
    const r = await cleanup(`the dead implementer for #${e.id}`, implementerStart)
    const commits = r && r.commits ? r.commits : []
    if (commits.length > 0) {
      recordFix(e, commits, r.committedFiles, `The implementer died after committing ${commits.join(', ')} and before reporting, so nothing confirms its checks passed: inspect ${commits.length > 1 ? 'these commits' : 'this commit'} with git show.`)
      log(`#${e.id} implementer died after committing ${commits.join(', ')}`)
      return
    }
    e.outcome = 'agent_failed'
    e.failedAt = r && r.commits ? 'implementer' : 'implementer (commits unknown)'
    return
  }
  e.implementation = impl
  const reportedCommit = impl.outcome === 'applied' && impl.committed === true && impl.commitSha
  const expectedHead = reportedCommit ? impl.commitSha : implementerStart
  const settled = impl.clean === true && expectedHead && typeof impl.head === 'string' && impl.head.startsWith(expectedHead)
  const r = settled
    ? { wasDirty: false, reverted: [], leftDirty: [], commits: [], committedFiles: [] }
    : await cleanup(`the implementer for #${e.id}`, reportedCommit ? null : implementerStart)
  const unreported = !reportedCommit && r && r.commits ? r.commits : []
  if (unreported.length > 0) {
    recordFix(e, unreported, r.committedFiles, `The implementer reported outcome ${impl.outcome} and did not report its commit as a fix, yet committed ${unreported.join(', ')}: inspect ${unreported.length > 1 ? 'these commits' : 'this commit'} with git show.`)
    log(`#${e.id} implementer committed ${unreported.join(', ')} without reporting it`)
    return
  }
  if (!reportedCommit && !(r && r.commits)) {
    e.outcome = 'agent_failed'
    e.failedAt = 'implementer (commits unknown)'
    log(`#${e.id} implementer reported outcome ${impl.outcome} without a commit sha, and its commits could not be listed`)
    return
  }
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
  if (!reportedCommit) {
    e.outcome = 'reverted'
    const restored = r !== null && r.leftDirty.length === 0
    impl.reason = `the implementer left its fix uncommitted, so the cleanup ${restored ? 'restored the tree' : 'tried to restore the tree and failed (see possiblyDirty)'}; its reason: ${impl.reason}`
    impl.plan = impl.files.length > 0 ? `The discarded fix changed ${impl.files.join(', ')}. ${e.suggestedFix}` : e.suggestedFix
    log(`#${e.id} fix left uncommitted and ${restored ? 'restored' : 'not fully restored'}`)
    return
  }
  const notes = r && r.wasDirty ? `${impl.notes ? `${impl.notes} ` : ''}The implementer left ${r.reverted.join(', ') || 'paths'} uncommitted after its commit, and the cleanup restored or deleted them: check that the commit does not depend on them.` : impl.notes
  recordFix(e, [impl.commitSha], impl.files, notes)
  log(`#${e.id} fixed (commit ${e.commitSha})`)
}

if (clusters.length > 0) {
  phase('Implement')
  const head = await run(`Run \`${GIT} rev-parse HEAD\` and report the sha it prints. Do nothing else.`, { label: 'read HEAD', phase: 'Implement', schema: HEAD_SCHEMA, ...HEAD_OPTS })
  if (head && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head.sha)) implementerStart = head.sha
  else log('reading HEAD failed; until the first fix lands, any implementer that reports no commit sha, dead or alive, is reported as failed with its commits unknown')
  for (const cl of clusters) {
    const lead = byId(cl.leadId)
    const siblings = cl.memberIds.filter((id) => id !== cl.leadId).map(byId)
    await implement(lead, siblings)
    const fix = lead.outcome === 'fixed' ? priorFixes.find((p) => p.id === lead.id) : null
    const checks = fix
      ? await parallel(siblings.map((s) => () => run(siblingPrompt(s, lead, fix), { label: `sibling #${s.id} vs fix #${lead.id}`, phase: 'Cover', schema: SIBLING_SCHEMA, ...SIBLING_OPTS })))
      : []
    for (const [k, s] of siblings.entries()) {
      if (checks[k] && checks[k].covered) {
        s.outcome = 'covered'
        s.coveredBy = lead.id
        log(`#${s.id} covered by the fix for #${lead.id}`)
        continue
      }
      await implement(s, [])
    }
  }
}

log(`done: ${registry.filter((e) => e.outcome === 'fixed').length} fixed, ${registry.filter((e) => e.outcome === 'covered').length} covered, ${registry.filter((e) => e.outcome === 'not_fixed').length} confirmed not auto-fixed, ${registry.filter((e) => e.outcome === 'reverted').length} reverted, ${registry.filter((e) => e.status === 'agent_failed' || e.outcome === 'agent_failed').length} agent-failed, ${registry.filter((e) => e.status === 'refuted').length} refuted, ${finderFailures.length} finder(s) failed`)

function firstSentence(text) {
  const reason = String(text || '')
  const end = reason.search(/(?<!\b(?:[eE]\.g|[iI]\.e|[vV]s|[eE]tc|[cC]f))[.!?](?=\s+[A-Z`]|\s*$)/)
  const first = end >= 0 ? reason.slice(0, end + 1) : reason
  return first.length > 300 ? `${first.slice(0, 300)}…` : first
}

function reported(e) {
  const f = {
    id: e.id,
    title: e.title,
    file: e.file,
    line: e.line,
    severity: e.finalSeverity ?? e.severity,
    status: e.status,
  }
  const handedOn = e.refuteGround === 'pre-existing' && (e.severity === 'high' || e.severity === 'critical')
  if ((e.status !== 'refuted' || handedOn) && e.outcome !== 'fixed' && e.outcome !== 'covered') f.description = e.description
  if (LOOP_FIELDS) f.dimension = e.dimension
  if (e.alsoReportedBy.length) f.alsoReportedBy = e.alsoReportedBy
  if (e.status === 'refuted') Object.assign(f, { refutedBy: e.refutedBy, refuteReason: firstSentence(e.refuteReason) })
  if (e.refuteGround) f.refuteGround = e.refuteGround
  if (e.failedAt) f.failedAt = e.failedAt
  if (!e.outcome) return f
  f.outcome = e.outcome
  const impl = e.implementation
  if (e.outcome === 'fixed') {
    Object.assign(f, { commitSha: e.commitSha, files: impl.files })
    if (impl.notes && impl.notes.trim()) f.notes = impl.notes
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
  excludedKinds: Object.fromEntries(EXCLUSION_KEYS.filter((k) => registry.some((e) => e.outcome === 'not_fixed' && e.implementation.excludedKind === k)).map((k) => [k, EXCLUSIONS[k]])),
  finderFailures,
  possiblyDirty: [...possiblyDirty],
  findings: registry.map(reported),
}
