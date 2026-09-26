export const meta = {
  name: 'simplify-converge',
  description: 'Loop simplification rounds (find, judge, apply) over a scope until fresh finders come up empty, then prune non-useful comments once converged',
  phases: [
    { title: 'Find', detail: 'read-only agents propose simplifications per batch', model: 'opus' },
    { title: 'Judge', detail: 'independent gatekeepers strike proposals that are not genuine improvements', model: 'opus' },
    { title: 'Apply', detail: 'implement the approved findings per batch' },
    { title: 'Hash', detail: 'deterministic tree hash after each round', model: 'sonnet' },
    { title: 'Discover', detail: 'list untracked files the appliers did not declare', model: 'sonnet' },
    { title: 'Verify', detail: 'project check command: baseline on sonnet, then an opus fix-up agent after each editing phase', model: 'opus' },
    { title: 'Prune', detail: 'audit and delete non-useful comments per file batch', model: 'opus' },
  ],
}

const FOCUS = {
  uncommitted: 'Focus on the uncommitted changes.',
  branch: 'Focus on the full working-tree diff against the base branch.',
  unpushed: 'Focus on the unpushed work: the full working-tree diff against the remote-tracking base, covering unpushed commits and uncommitted changes.',
  codebase: 'Focus on the entire codebase.',
}

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !FOCUS[input.scope] || !input.hashCmd || !input.baselineHash || !Array.isArray(input.files) || !Array.isArray(input.untrackedBaseline)) {
  throw new Error('args must be {scope: "uncommitted"|"branch"|"unpushed"|"codebase", hashCmd: string, baselineHash: string, files: string[], untrackedBaseline: string[], base?: string (required unless scope is "codebase"), model?: string, effort?: string}')
}

// The baseline seeds the same convergence set the round hashes land in, and
// those are pinned to bare lowercase hex; a raw `sha256sum` line ("<hash>  -")
// would never match any round hash and fake a tree change on an untouched tree.
if (!/^[0-9a-f]{64}$/.test(input.baselineHash)) {
  throw new Error('baselineHash must be the bare 64-character lowercase hex hash, the first field of the hash command output, nothing else')
}

if (input.files.length === 0) {
  throw new Error('files must not be empty; nothing is in scope')
}

if (input.scope !== 'codebase' && !input.base) {
  throw new Error('uncommitted/branch/unpushed scope requires base (a git ref bounding the diff)')
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
if (input.model && !EFFORTS.includes(input.effort)) {
  throw new Error(`when model is overridden, effort must also be chosen: one of ${EFFORTS.join(', ')}`)
}

// Pruning always follows convergence, so its inputs are always required. Two
// empty lists are a legitimate launch: a diff that adds no comment and no
// untracked source still leaves the comments the simplify phase itself writes
// to classify. An absent key is a different thing: an orchestrator that
// computed candidates and failed to pass them would silently narrow the audit
// to the files the run touched.
for (const key of ['pruneFiles', 'pruneUntrackedFiles']) {
  if (input[key] === undefined) throw new Error(`${key}: string[] is required; pass [] for a list with no candidates`)
  if (!Array.isArray(input[key])) throw new Error(`${key} must be string[]`)
}
// Files that appear mid-run are not in either candidate list, so the script
// needs the orchestrator's own extension filter to judge them by.
if (!Array.isArray(input.pruneExts) || input.pruneExts.length === 0) {
  throw new Error('pruneExts: string[] is required, the extensions the candidate lists were filtered on, e.g. [".ts", ".js", ".svelte"]')
}
if (!input.root) throw new Error('root: absolute project root path is required')

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
          description: { type: 'string' },
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
  const before = new Set([...input.untrackedBaseline, ...known])
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
const globalSeen = new Set([input.baselineHash])
let iterations = 0
let sweeps = 0
let stopReason = 'converged'
let outstandingFailures = []
// The tree hash is what normally proves the appliers edited something, so a run
// whose hash agent died needs its own record of it: discovery and the fix-up
// are gated on the tree having moved, and must still run when the hash is gone.
let treeEdited = false
let lastTreeHash = input.baselineHash
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
for (const path of input.files) {
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
log(`${input.files.length} files across ${batches.length} batches (scope: ${input.scope})`)
// The workflow harness caps a run at 1000 agents in total; each batch-round
// costs up to three agents (find, judge, apply).
if (batches.length > 80) {
  log(`warning: ${batches.length} batches; the 1000-agent lifetime cap may end this run before convergence`)
}

const known = new Set(input.files)

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
const wholeFile = new Set(input.untrackedBaseline)

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
${JSON.stringify(findings, null, 2)}

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
${JSON.stringify(approved, null, 2)}

Preserve behavior exactly. Create a new file only when a finding calls for it. If a finding proves unsafe or impossible as described once you see the code, skip it and record it in \`failed\` with a reason instead of improvising an alternative.

Other agents are editing other parts of this project concurrently, so project-wide commands (typecheck, build, lint, test suite) would see a half-edited tree, so do not run them. Verify your edits by reading the code.

Report every change you actually made in \`applied\`, each classified as one of: ${GROUPS.join(', ')}, with the files it touched; every file you created in \`createdFiles\`; and every finding you skipped in \`failed\`. Every path must be relative to the project root, with no leading './' and never absolute. For files you edited, use exactly the paths as they appear in the findings above.`
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

  const treeHash = await runHash(input.hashCmd, `hash:tree@${iterations}`)
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
    const postFixHash = await runHash(input.hashCmd, 'hash:tree@postfix')
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
  const trackedPruneFiles = input.pruneFiles
  const untrackedPruneFiles = input.pruneUntrackedFiles
  const alreadyListed = new Set([...trackedPruneFiles, ...untrackedPruneFiles])
  const pruneExts = new Set(input.pruneExts.map(e => (e.startsWith('.') ? e : `.${e}`)))
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

    const hash = await runHash(input.hashCmd, `hash:prune@${pruneIterations}`)
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

// The report conditions the orchestrator would otherwise derive from the fields
// below, computed once here so every caller reads the same answer.
const fullPrune = prune.stopReason !== 'skipped-simplify-unstable'
const edited = allChanges.length > 0 || globalSeen.size > 1 || (fullPrune && (prune.removed > 0 || prune.distinctTreeStates > 0))
const editPossible = stopReason === 'hash-unavailable' || (fullPrune && prune.stopReason === 'hash-unavailable')
const verificationLost = (s) => s === 'baseline-failed' || s === 'fixup-died'
const unverified = (fullPrune && verificationLost(prune.verificationStatus))
  || (verificationLost(simplifyVerification) && !(fullPrune && prune.verificationStatus === 'ran'))
const noCheck = simplifyVerification === 'not-configured' && (edited || editPossible)

const summary = {}
for (const group of GROUPS) summary[group] = []
for (const change of allChanges) {
  const group = GROUPS.includes(change.group) ? change.group : 'Code simplifications'
  summary[group].push({ description: change.description, files: change.files })
}

return {
  scope: input.scope,
  iterations,
  sweeps,
  stopReason,
  distinctTreeStates: globalSeen.size - 1,
  findingsProposed: proposedTotal,
  findingsApproved: approvedTotal,
  rejectedFindings: allRejected,
  changesApplied: allChanges.length,
  undeclaredFiles,
  unanalyzedFiles,
  abandonedAfterProgress,
  discoveryFailed,
  unresolvedCheckFailures: outstandingFailures,
  verificationStatus: simplifyVerification,
  // A pre-existing failure is never attributed to the run, so an empty
  // `unresolvedCheckFailures` cannot say the check passes when the baseline
  // was already failing.
  checkBaselineFailing: baselineFailures.length > 0 || baselineFailing,
  prune,
  reportFlags: { fullPrune, edited, editPossible, unverified, noCheck },
  summary,
}
