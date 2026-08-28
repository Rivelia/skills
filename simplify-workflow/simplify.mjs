export const meta = {
  name: 'simplify-converge',
  description: 'Loop find→judge→apply simplification rounds over a scope until fresh finders come up empty; optionally prune non-useful comments once converged',
  phases: [
    { title: 'Find', detail: 'read-only agents propose simplifications per batch', model: 'opus' },
    { title: 'Judge', detail: 'independent gatekeepers strike proposals that are not genuine improvements', model: 'opus' },
    { title: 'Apply', detail: 'implement the approved findings per batch', model: 'opus' },
    { title: 'Hash', detail: 'deterministic tree hash after each round', model: 'sonnet' },
    { title: 'Discover', detail: 'list untracked files the appliers did not declare', model: 'sonnet' },
    { title: 'Verify', detail: 'project check command — baseline, then a fix-up agent after each editing phase', model: 'opus' },
    { title: 'Classify', detail: 'flag comment removal candidates per file batch', model: 'opus' },
    { title: 'Remove', detail: 'delete confirmed candidates per batch', model: 'opus' },
  ],
}

const FOCUS = {
  uncommitted: 'Focus on the uncommitted changes.',
  branch: 'Focus on the full working-tree diff against the base branch.',
  unpushed: 'Focus on the unpushed work: the full working-tree diff against the remote-tracking base, covering unpushed commits and uncommitted changes.',
  codebase: 'Focus on the entire codebase.',
}

// Tolerate args arriving as a JSON-encoded string instead of an object.
const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !FOCUS[input.scope] || !input.hashCmd || !input.baselineHash || !Array.isArray(input.files) || !Array.isArray(input.untrackedBaseline)) {
  throw new Error('args must be {scope: "uncommitted"|"branch"|"unpushed"|"codebase", hashCmd: string, baselineHash: string, files: string[], untrackedBaseline: string[], base?: string (required unless scope is "codebase"), model?: string, effort?: string}')
}

// An empty scope has nothing to converge.
if (input.files.length === 0) {
  throw new Error('files must not be empty — nothing is in scope')
}

// Every non-codebase scope is diff-bounded, so agents need the base ref to know
// which parts of a file the scope actually covers.
if (input.scope !== 'codebase' && !input.base) {
  throw new Error('uncommitted/branch/unpushed scope requires base (a git ref bounding the diff)')
}

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
if (input.model && !EFFORTS.includes(input.effort)) {
  throw new Error(`when model is overridden, effort must also be chosen: one of ${EFFORTS.join(', ')}`)
}

if (input.prune) {
  // Two empty lists are a legitimate launch — a diff that adds no comment and no
  // untracked source still leaves the comments the simplify phase itself writes
  // to classify. An absent key is a different thing: an orchestrator that
  // computed candidates and failed to pass them would silently narrow the audit
  // to the files the run touched.
  for (const key of ['pruneFiles', 'pruneUntrackedFiles']) {
    if (input[key] === undefined) throw new Error(`prune requires ${key}: string[] — pass [] for a list with no candidates`)
    if (!Array.isArray(input[key])) throw new Error(`${key} must be string[] when given`)
  }
  // Files that appear mid-run are not in either candidate list, so the script
  // needs the orchestrator's own extension filter to judge them by. Inferring
  // it from the candidates would under-cover: a scope whose candidates are all
  // .ts would silently skip a .svelte file a pass created.
  if (!Array.isArray(input.pruneExts) || input.pruneExts.length === 0) {
    throw new Error('prune requires pruneExts: string[] — the extensions the candidate lists were filtered on, e.g. [".ts", ".js", ".svelte"]')
  }
  if (!input.root) throw new Error('prune requires root: absolute project root path')
}

// Batches keep every agent's file list bounded; grouping by top-level directory
// keeps each batch coherent enough to judge cross-file structure.
const BATCH_SIZE = 15
// The only hard cap. Convergence is otherwise decided by fresh agents:
// a batch retires when its finder proposes nothing or its judge approves
// nothing, and the loop ends when a full confirmation sweep applies nothing.
const MAX_ROUNDS = 100

// Finder and apply agents default to opus at high effort: judgment work needs
// opus. A model override must bring its own effort — the pairing is the
// user's call. Judge and verify/fix agents are pinned to opus/high regardless
// of the override (gatekeeping and failure attribution are judgment work);
// hash agents stay on sonnet — purely mechanical work.
const simplifyOpts = input.model
  ? { model: input.model, effort: input.effort }
  : { model: 'opus', effort: 'high' }
const judgeOpts = { model: 'opus', effort: 'high' }

const GROUPS = ['Performance improvements', 'Code simplifications', 'Bug fixes']

// Finder brief for the find → judge → apply loop; $ARGUMENTS is filled per
// batch. Self-contained on purpose — this workflow must not depend on
// ~/.claude/skills/simplify/SKILL.md.
const SIMPLIFY = `You are the FINDER in an automated find → judge → apply code-simplification loop. Read the code in scope and return every refinement worth making as a finding. Do not edit any files; separate agents apply the findings. An independent judge rejects any finding that is not a genuine improvement, and only approved findings are applied.

Propose refinements that:

1. **Preserve functionality**: change only how the code does something, never what it does. All original features, outputs, and behaviors must remain intact.

2. **Follow project standards**: apply the coding standards from CLAUDE.md/AGENTS.md and the docs they reference: naming, imports, error handling, everything they establish.

3. **Improve clarity**:

   - Reduce unnecessary complexity and nesting
   - Eliminate redundant code and abstractions
   - Improve readability through clear variable and function names
   - Consolidate related logic
   - Remove comments that restate obvious code
   - Prefer switch statements or if/else chains over nested ternaries
   - Choose clarity over brevity; explicit code is often better than overly compact code

4. **Keep the balance**: readable and maintainable beats clever and compact. Do not propose refinements that:

   - Combine too many concerns into a single function or component
   - Remove helpful abstractions that improve code organization
   - Trade readability for fewer lines (nested ternaries, dense one-liners)
   - Make the code harder to debug or extend

5. **Scope**: $ARGUMENTS

Each finding names the group it belongs to (${GROUPS.join(', ')}), the files involved, and a description concrete enough for another agent to implement without seeing your reasoning: name the construct and state exactly what to change and how. A finding may involve creating a new file when extracting shared logic genuinely simplifies the code.

The same files are re-examined by fresh agents every round until a round finds nothing; only then can the process finish. Returning ZERO findings is the expected, successful terminal state for code that is already in good shape, not a failure to contribute. Marginal, cosmetic, or judgment-call refinements never clear the bar: renaming an already-clear identifier, extracting a single-use helper, restructuring code that is already readable. If you find yourself weighing whether a particular change is worth proposing, drop that change and report only the ones you are sure of.`

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

// Built per call rather than as a constant so the index can be bounded by the
// batch's own proposal count: a judge that answers 1-based satisfies any
// unbounded schema, and every verdict would then land on a neighbouring
// finding, applying a change no judge approved.
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

const CHECK_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    failures: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['file', 'message'],
      },
    },
  },
  required: ['passed', 'failures'],
}

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['file', 'message'],
      },
    },
  },
  required: ['passed', 'fixed', 'remaining'],
}

// Comment-pruning rules and prompts, carried over verbatim from the
// prune-comments workflow this phase replaces.
const SCOPE_INSTRUCTIONS = {
  uncommitted: (base) => `First run \`git diff ${base} -- <file>\` to see the uncommitted changes, then Read the current file. Classify ONLY comments added or modified by those changes (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  branch: (base) => `First run \`git diff ${base} -- <file>\` to see what this branch changed, then Read the current file. Classify ONLY comments added or modified by this branch (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  unpushed: (base) => `First run \`git diff ${base} -- <file>\` to see the unpushed changes (unpushed commits plus uncommitted work), then Read the current file. Classify ONLY comments added or modified by those changes (lines inside the diff hunks, current working-tree state). Comments outside the changed hunks are out of scope.`,
  codebase: () => `Read the current file. Classify EVERY comment in it.`,
}

const RULES = `The ONLY allowed comments are:
1. JSDoc comments documenting a function/type/module API.
2. Comments adding context that CANNOT be inferred by reading the code (external constraints, protocol quirks, security rationale, non-obvious invariants, links to specs/bugs). Rule 2 has a second, equally mandatory half: the context must be needed to read, change or debug the code that is ACTUALLY THERE. Apply this test to every rule-2 candidate: "which line would a reader misread, or break on their next edit, if this comment were gone?" Name that line. If you cannot name one, rule 2 does not apply and the comment is a removal candidate.

Everything else is a removal candidate, especially:
- Comments explaining what the code does (restating the code).
- Comments referring to the past ("previously...", "used to...", "no longer...") or to removed code.
- Comments justifying why the code does NOT do something, or defending the current design against an alternative that is absent from the file. These describe a decision, not the code. Present-tense phrasing does not exempt them: "X is a Y, not a Z" is change-log content whenever no Z exists in the file, however timeless it sounds. A comment can be true, well written and impossible to infer, and still be a removal candidate under this bullet; it belongs in the commit message or an ADR, not beside the result. Distrust your instinct to keep these; it is the single most common way a useless comment survives a pass.
- Section markers / narration / change-log style comments.

Maintaining comments AND code is a burden; the sole truth should be the code itself.`

const CLASSIFY_SCHEMA = {
  type: 'object',
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        required: ['file', 'line', 'comment', 'reason'],
        properties: {
          file: { type: 'string' },
          line: { type: 'number' },
          comment: { type: 'string', description: 'exact comment text' },
          reason: { type: 'string' },
        },
      },
    },
  },
}

const PRUNE_RESULT_SCHEMA = {
  type: 'object',
  required: ['removed', 'skipped'],
  properties: {
    removed: { type: 'number' },
    skipped: { type: 'array', items: { type: 'string' } },
  },
}

const FIND_SWEEP_NOTE = `\n\nThis is a confirmation sweep: every part of the scope has settled and this pass exists to confirm nothing was missed. The expected outcome is ZERO findings. Report only a clear defect or a cross-file inconsistency left by earlier rounds, never a preference.`

function fileListBlock(files) {
  return files.map(f => `- ${f}`).join('\n')
}

// Keeps fix-up prompts bounded on codebase-wide runs.
function touchedBlock(files) {
  const shown = files.slice(0, 100)
  const extra = files.length - shown.length
  return fileListBlock(shown) + (extra > 0 ? `\n…and ${extra} more` : '')
}

function hashAgentPrompt(cmd) {
  return `Run exactly this shell command via Bash, unmodified, from the project root:

${cmd}

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
  // Null rather than a throw: every caller sits at the top level of the script,
  // where a throw would discard the whole report of a run whose agents have
  // already rewritten files.
  return null
}

// An empty discovery result from a dead agent reads exactly like a run that
// created nothing, so the caller gets this flag to tell the two apart.
let discoveryFailed = false

// Appliers declare what they create, but one that forgets leaves a file no
// later phase can see. Listing the untracked tree and subtracting the baseline
// captured before launch isolates exactly what appeared during the run;
// everything the appliers did declare is already in `known`. Path quoting is
// off because a quoted non-ASCII path names no file the later phases can open,
// and the orchestrator captures the baseline with the same flag — turning it on
// for one side of the subtraction alone would fabricate new files.
async function discoverUntracked() {
  let result = null
  // agent() throws once a user-set token budget is exhausted; this call sits at
  // the top level, after the appliers have edited, so the throw is folded into
  // the dead-agent path rather than discarding the run's whole report.
  try {
    result = await agent(
      `Run exactly this shell command via Bash, unmodified, from the project root:

git -c core.quotePath=false ls-files -o --exclude-standard

Return every path it prints, verbatim, as \`untracked\`, relative to the project root with no leading './'. Returning an empty array is a normal outcome. Do not read, review, or edit any project files.`,
      { label: 'discover:untracked', phase: 'Discover', schema: UNTRACKED_SCHEMA, model: 'sonnet', effort: 'low' },
    )
  } catch {
    result = null
  }
  // A dead discovery agent costs coverage, not correctness: the run proceeds
  // with the declared creations alone, exactly as it did before.
  if (!result) {
    discoveryFailed = true
    log('discovery agent died — undeclared new files, if any, will not be pruned or verified')
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
      `Run exactly this shell command via Bash, unmodified, from the project root:

${input.checkCmd}

Report whether it passed. For every failure it reports (type error, test failure, lint error), return the implicated file path and a concise one-line message. The path must be relative to the project root, with no leading './' and never absolute. Do not edit any project files and do not attempt any fixes.`,
      // Attributing failures to the right files is a judgment call — opus.
      { label, phase: 'Verify', schema: CHECK_SCHEMA, ...judgeOpts },
    )
    // Null when the verifier agent dies; each caller decides what that means.
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

// Baseline check: failures that exist before any pass are not this run's to
// fix and must never be attributed to it.
let baselineFailures = []
// A check that fails while naming no file — a compiler rejecting its own
// options, a suite aborting in global setup — is honestly reported as a failing
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
    log('verification disabled: baseline check failed 3 times — no check failures will be attributed to this run')
  } else {
    baselineFailures = baseline.failures
    baselineFailing = !baseline.passed
    if (baselineFailing) {
      log(baselineFailures.length
        ? `baseline check already failing: ${baselineFailures.length} pre-existing failure(s) will be ignored`
        : 'baseline check already failing but named no file — no check failure will be attributed to this run')
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
    // Without this the agent is told nothing about the pre-existing failure and
    // spends its three rounds of edits chasing a failure that predates the run.
    baselineNote = `\n\nThis command ALREADY exited non-zero BEFORE the run, and the baseline could not tie that failure to any file. It is NOT yours to fix and the command will still exit non-zero at the end. Report passed=true unless you can tie a specific failure to the edits this run made; do not list a failure you cannot tie to them in \`remaining\`. \`passed\` means "no run-caused failures remain", not "the command exits 0".`
  }
  // The last fix-up of the run re-runs the check on the final tree, so it is the
  // one agent placed to adjudicate what an earlier fix-up left broken.
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
      `Run exactly this shell command via Bash from the project root:

${input.checkCmd}

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

// ---------------------------------------------------------------------------
// Simplify loop: find → judge → apply per batch, retire batches that come up
// empty, confirm with a full sweep of fresh finders.
// ---------------------------------------------------------------------------

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
  log(`warning: ${batches.length} batches — the 1000-agent lifetime cap may end this run before convergence`)
}

const known = new Set(input.files)

// A batch nobody could ever analyse is dropped rather than retried forever, so
// its files leave no trace anywhere else in the result: this is the only record
// that they were in scope and never looked at. A batch a finder did reach, or
// an applier was dispatched against, is not one of those — it was looked at,
// and `abandonedAfterProgress` is where it is recorded; listing it here would
// bury the never-looked-at files under ordinary transient agent flake.
const unanalyzedFiles = []

// The confirmation sweep is what `converged` speaks for, and it skips abandoned
// batches — so a batch dropped after earlier rounds had already worked on it
// leaves files whose settled state no fresh finder ever confirmed, with nothing
// in `unanalyzedFiles` to say so.
const abandonedAfterProgress = []

// Diff-bounded scopes must say so, or the finder treats whole files as fair game.
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
  return SIMPLIFY.replace('$ARGUMENTS', () => focus) + (isSweep ? FIND_SWEEP_NOTE : visitNote)
}

function judgePrompt(findings, isSweep) {
  // A sweep proposal that gets approved reactivates a settled batch. The
  // judge gets that context and what an approval costs, but the standard
  // stays the same — the verdict is the judge's, not the prompt's.
  const sweepNote = isSweep
    ? `\n\nContext: these proposals come from a confirmation sweep. Earlier rounds already refined this scope and every batch had settled, and an approval reopens it for another round. Judge each proposal on the same standard as any other. The sweep exists to catch what earlier rounds genuinely missed, not to relitigate choices they already made.`
    : ''
  return `You are the independent gatekeeper in an automated code-simplification loop. A finder agent proposed the simplifications below. For each one, read the current code it targets and decide whether applying it would GENUINELY improve the codebase.

Proposals (JSON, judge each by its array index, starting at 0):
${JSON.stringify(findings, null, 2)}

Approve a proposal only when it clearly preserves behavior AND leaves the code easier to read or maintain by a margin that justifies touching settled code. Reject:
- cosmetic and preference-level changes: renaming an already-clear identifier, reshuffling already-readable code, style churn;
- anything with any risk of changing behavior;
- abstractions or extractions that do not remove real duplication;
- proposals too vague to implement safely exactly as described.
When in doubt, reject.${sweepNote}

The scope of this loop is ${input.scope === 'codebase' ? 'the entire codebase' : `code changed relative to ${input.base}`}; reject proposals reaching beyond it as out of scope.

Do not edit any files. Other agents are working elsewhere in this project concurrently, so do not run project-wide commands (typecheck, build, lint, test suite). Return one verdict per proposal: its index, approved true/false, and a one-line reason.`
}

function applyPrompt(approved) {
  return `Implement the following code-simplification findings exactly as described. Each was proposed by a finder agent and validated by an independent judge; your job is faithful application, not invention. Make no improvements beyond these findings.

Findings (JSON):
${JSON.stringify(approved, null, 2)}

Preserve behavior exactly. Create a new file only when a finding calls for it. If a finding proves unsafe or impossible as described once you see the code, skip it and record it in \`failed\` with a reason instead of improvising an alternative.

Other agents are editing other parts of this project concurrently, so project-wide commands (typecheck, build, lint, test suite) would see a half-edited tree, so do not run them. Verify your edits by reading the code.

Report every change you actually made in \`applied\`, each classified as one of: ${GROUPS.join(', ')}, with the files it touched; every file you created in \`createdFiles\`; and every finding you skipped in \`failed\`. Every path must be relative to the project root, with no leading './' and never absolute. For files you edited, use exactly the paths as they appear in the findings above.`
}

// A new file joins the batch owning its top-level directory so the next round
// reviews it next to its neighbors.
function assignNewFile(path) {
  const dir = topDir(path)
  // An abandoned batch is never visited again, so a file homed into one would
  // silently leave the scope.
  const target = batches.find(b => b.group === dir && !b.abandoned && b.files.length < BATCH_SIZE)
  if (target) {
    target.files.push(path)
    target.active = true
    log(`new file ${path} → batch ${target.name}`)
  } else {
    const existing = batches.filter(b => b.group === dir).length
    const name = existing ? `${dir}#${existing + 1}` : dir
    batches.push({ name, group: dir, files: [path], active: true, visits: 0 })
    log(`new file ${path} → new batch ${name}`)
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
    // Confirmation sweep: every batch — including every retired one — gets a
    // fresh finder before convergence is declared, catching cross-batch
    // fallout and prematurely retired work without dependency tracking.
    // Abandoned batches stay out: their agents would die again and the resulting
    // `roundHadDead` would block the sweep from ever confirming convergence.
    targets = batches.filter(b => !b.abandoned)
    // A sweep over nothing applies nothing and leaves the hash where it was,
    // which is exactly the shape of convergence — so a run where every batch was
    // abandoned would report the most reassuring stop reason for the worst
    // possible outcome. The two abandonment stories get their own stop reasons:
    // a scope no finder ever reached is a different report from one earlier
    // rounds did analyse before their agents started dying.
    if (targets.length === 0) {
      const everAnalysed = batches.some(b => b.visits > 0 || b.analysed) || treeEdited
      stopReason = everAnalysed ? 'all-batches-abandoned-after-progress' : 'all-batches-abandoned'
      log(everAnalysed
        ? (treeEdited
            ? 'every remaining batch was abandoned after repeated agent deaths — earlier rounds analysed part of the scope and an applier was dispatched, so the summary covers the work done so far'
            : 'every remaining batch was abandoned after repeated agent deaths — earlier rounds analysed part of the scope without recording any change')
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
      const verdictFor = i => prev.verdicts.verdicts.find(v => v.index === i)
      const approved = prev.findings.filter((f, i) => verdictFor(i)?.approved)
      const rejected = prev.findings
        .map((f, i) => ({ ...f, reason: verdictFor(i)?.reason ?? 'no verdict returned' }))
        .filter((f, i) => !verdictFor(i)?.approved)
      if (approved.length === 0) return { status: 'all-rejected', proposed: prev.findings.length, rejected }
      // Recorded at dispatch, not from the report: an applier that edits and
      // then dies — or whose stage throws on an exhausted budget — returns
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
        ...simplifyOpts,
      }).then(r => ({ status: 'applied', proposed: prev.findings.length, approved: approved.length, rejected, report: r }))
    },
  )

  const newFiles = []
  let roundApplied = 0
  let roundHadDead = false
  for (let i = 0; i < targets.length; i++) {
    const batch = targets[i]
    const r = results[i]
    // agent() resolves to null rather than throwing, so a dead finder, judge,
    // or applier surfaces here: the batch was not (fully) processed — keep it
    // active for a fresh attempt and block this round from confirming
    // convergence.
    if (!r || r.status === 'finder-dead' || r.status === 'judge-dead' || (r.status === 'applied' && !r.report)) {
      batch.active = true
      roundHadDead = true
      // Fresh attempts, but a bounded number: a batch whose agents keep dying —
      // or that the user skips every round — would otherwise stay active
      // forever, so no sweep could ever run and convergence would be
      // unreachable for the whole scope.
      batch.deadAttempts = (batch.deadAttempts ?? 0) + 1
      if (batch.deadAttempts >= 2) {
        batch.active = false
        batch.abandoned = true
        if (!batch.analysed && !batch.applierDispatched) {
          unanalyzedFiles.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents — its files were never analysed`)
        } else if (batch.applierDispatched) {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents — an applier was dispatched to it, so its files may have been edited without being reported`)
        } else {
          abandonedAfterProgress.push(...batch.files)
          log(`batch ${batch.name} abandoned after ${batch.deadAttempts} dead agents — a finder did read its files, so they are not listed as unanalysed`)
        }
      }
      if (r?.proposed) proposedTotal += r.proposed
      if (r?.approved) approvedTotal += r.approved
      if (r?.rejected) allRejected.push(...r.rejected)
      continue
    }
    // Powers the "this is visit N" prompt context only — not a budget.
    if (!isSweep) batch.visits++
    // Only back-to-back failures mean a batch is hopeless; without this reset,
    // two unrelated agent deaths rounds apart would abandon a batch that has
    // been analysed successfully in between.
    batch.deadAttempts = 0
    if (r.status === 'clean') {
      // The finder found nothing: the batch retires until a sweep or a
      // cross-batch edit revives it.
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
    // A batch that actually changed stays active so a fresh finder re-examines
    // the new state; a batch whose applier applied nothing (every approved
    // finding failed) has an unchanged tree and retires — the sweep re-looks.
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
        // instead of waiting for the sweep. An abandoned owner is skipped —
        // reviving it would only spend two more rounds re-abandoning it.
        const owner = batches.find(b => b !== batch && !b.abandoned && b.files.includes(f))
        if (owner && !owner.active) owner.active = true
      }
    }
    allChanges.push(...applied)
  }
  for (const f of newFiles) assignNewFile(f)
  filesCreatedDuringRun.push(...newFiles)

  // The tree hash is the ground truth behind the appliers' self-reports: the
  // loop may only converge on a sweep that applied nothing AND landed on an
  // already-seen tree state, so unreported edits can never end the loop early.
  const treeHash = await runHash(input.hashCmd, `hash:tree@${iterations}`)
  if (!treeHash) {
    stopReason = 'hash-unavailable'
    log(`round ${iterations}: hash agent could not return a hash — convergence cannot be confirmed; stopping and reporting the work done so far`)
    break
  }
  lastTreeHash = treeHash
  if (globalSeen.has(treeHash)) {
    if (isSweep && roundApplied === 0 && !roundHadDead) {
      stopReason = 'converged'
      log(`round ${iterations}: sweep confirms convergence — no findings survived judging`)
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
let undeclaredFiles = []
if (globalSeen.size > 1 || (treeEdited && stopReason === 'hash-unavailable')) {
  undeclaredFiles = await discoverUntracked()
  if (undeclaredFiles.length) {
    for (const f of undeclaredFiles) known.add(f)
    filesCreatedDuringRun.push(...undeclaredFiles)
    // They arrive too late for the loop to simplify them — reopening it here
    // would restart convergence — but the later phases still reach them: the
    // fix-up verifies them whenever it runs, and the prune phase classifies them
    // when it runs and their extension is one it was given.
    log(`${undeclaredFiles.length} file(s) appeared during the run without being declared: ${touchedBlock(undeclaredFiles)}`)
  }
}

// Loop agents never run project-wide commands, so this quiet point is where
// the project gets verified — and repaired — regardless of how the loop ended.
// Gated as discovery is: an unmoved tree has nothing to verify, and a dispatched
// applier only speaks for a run whose hash never came back.
if (input.checkCmd && !checkDisabled && (globalSeen.size > 1 || (treeEdited && stopReason === 'hash-unavailable'))) {
  // Same `known` gate as the loop on the dispatched targets: an out-of-scope
  // path there is a proposal this run never owned. A path in `allChanges` is a
  // report of a real edit — in scope or not, it is where breakage may be.
  const touched = [...new Set([
    ...allChanges.flatMap(c => c.files ?? []),
    ...[...possiblyEditedFiles].filter(f => known.has(f)),
    ...filesCreatedDuringRun,
  ])]
  const fix = await runFix('fix:simplify', touched, 'code-simplification')
  if (!fix) {
    simplifyVerification = 'fixup-died'
    log('fix-up agent died — project state unverified')
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
  // consumer of the refreshed value, so runs without one skip the agent. A
  // failed hash keeps the pre-fix seed: it costs one extra prune pass, where an
  // unseeded set would let the first pass look settled.
  const fixLeftTreeIntact = fix && fix.passed && !fix.fixed.length && !fix.remaining.length
  if (input.prune && stopReason === 'converged' && !fixLeftTreeIntact) {
    const postFixHash = await runHash(input.hashCmd, 'hash:tree@postfix')
    if (postFixHash) {
      lastTreeHash = postFixHash
    } else {
      log('hash agent could not return a hash after the fix-up — the prune phase seeds from the pre-fix tree state')
    }
  }
}

// ---------------------------------------------------------------------------
// Comment-pruning phase: starts only once simplification has converged, so
// classify agents never audit comments in code a later pass would rewrite.
// ---------------------------------------------------------------------------
let prune = null
if (input.prune && stopReason === 'converged') {
  // Extension comes from the basename only: a dotted directory name must not
  // supply an extension.
  function extOf(f) {
    const base = f.slice(f.lastIndexOf('/') + 1)
    const i = base.lastIndexOf('.')
    return i > 0 ? base.slice(i) : ''
  }
  // Files that appeared during the run — declared creations and undeclared
  // ones alike — join the untracked candidates when their extension is one the
  // orchestrator filtered its own candidate lists on.
  const trackedPruneFiles = input.pruneFiles ?? []
  const untrackedPruneFiles = input.pruneUntrackedFiles ?? []
  const alreadyListed = new Set([...trackedPruneFiles, ...untrackedPruneFiles])
  const pruneExts = new Set(input.pruneExts.map(e => (e.startsWith('.') ? e : `.${e}`)))
  const createdPruneFiles = filesCreatedDuringRun.filter(f => pruneExts.has(extOf(f)) && !alreadyListed.has(f))
  // The tracked candidate list was frozen before launch from the pre-run diff, so
  // a file that carried no comment then is absent from it even after an applier
  // wrote one into it — including an applier that died before reporting, which is
  // why the files it was merely dispatched against count too. A file it turned out
  // not to touch costs one classify pass that returns nothing. Same `known` gate as
  // the loop: a path outside the scope is an out-of-scope edit, not a reason to
  // widen the audit.
  const editedTracked = [...new Set([...allChanges.flatMap(c => c.files ?? []), ...possiblyEditedFiles])]
    .filter(f => known.has(f) && pruneExts.has(extOf(f)) && !alreadyListed.has(f) && !filesCreatedDuringRun.includes(f))
  // A file that was already untracked at launch has no diff against the base, so
  // a diff-bounded instruction would classify nothing in it and retire its batch
  // as clean — reporting a comment as audited that no agent was asked to read.
  const editedFresh = editedTracked.filter(f => wholeFile.has(f))
  const editedDiffBounded = editedTracked.filter(f => !wholeFile.has(f))
  const wholeFilePruneFiles = [...untrackedPruneFiles, ...createdPruneFiles, ...editedFresh]
  const pruneList = [...trackedPruneFiles, ...editedDiffBounded, ...wholeFilePruneFiles]

  const BATCH = 5
  let activeBatches = []
  // An untracked file has no diff against the base, so a diff-bounded scope
  // instruction would classify nothing in it: untracked and created files batch
  // separately and always get the whole-file instruction.
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
      (batch) =>
        agent(
          `You are auditing comments in the repo at ${input.root}.

For each of these files: ${batch.instruction}

Files:
${batch.files.join('\n')}

${RULES}

Do NOT edit anything. Return the candidates with exact file, approximate line number, exact comment text, and a one-line reason. Returning zero candidates is a normal, successful outcome; do not flag borderline comments to justify the pass.`,
          { label: `classify:${iteration}.batch${batch.id}`, phase: 'Classify', schema: CLASSIFY_SCHEMA, ...simplifyOpts },
        ).then((res) => ({ batch, res })),
      ({ batch, res }) => {
        // agent() resolves to null rather than throwing, so a dead or skipped
        // classifier is indistinguishable from an empty candidate list unless
        // the two are split here — and retiring it as clean would report files
        // as audited that no agent ever read.
        if (!res) {
          log(`prune: classify agent for batch ${batch.id} did not answer — its files are unaudited so far`)
          return { batch, removed: 0, skipped: [], clean: false, dead: true }
        }
        if (res.candidates.length === 0) return { batch, removed: 0, skipped: [], clean: true }
        // Recorded at dispatch, not from the report: a remover that edits and
        // then dies — or whose stage throws on an exhausted budget — reports no
        // removals, and the fix-up gate must still open for the broken syntax it
        // may have left behind.
        pruneEdited = true
        return agent(
          `In repo ${input.root}, remove the following comments, which were classified as non-useful (they restate code or describe stale history). Use Read + Edit. Remove ONLY the comment (and its now-empty line); never touch code. Skip a comment only if it is valid JSDoc, or context a reader needs to correctly read or change a specific nearby line, and name that line in the reason. List every skip in "skipped" as "<comment>: <reason>". Do NOT skip a comment just because it is true, well written, or impossible to infer: a comment that justifies why the code does NOT do something, or defends the design against an alternative absent from the file, is change-log content and must go. Verify each edit leaves valid syntax.

Candidates (JSON):
${JSON.stringify(res.candidates, null, 2)}`,
          { label: `remove:${iteration}.batch${batch.id}`, phase: 'Remove', schema: PRUNE_RESULT_SCHEMA, ...simplifyOpts },
        ).then((r) => ({ batch, removed: r?.removed || 0, skipped: r?.skipped || [], clean: false, deadRemove: !r }))
      },
    )
  }

  const pruneSeen = new Set([lastTreeHash])
  let removed = 0
  let skipped = []
  const unauditedFiles = []
  let batchesDone = 0
  let stable = 0
  let pruneIterations = 0
  let pruneStop = 'converged'
  let incompleteRetries = 0
  // Same reason as `treeEdited` in the simplify phase: the fix-up is gated on
  // the tree having moved, and a dead hash agent leaves no other trace of it.
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
    // A batch whose classifier or remover died left candidates unactioned, and
    // an exhausted token budget makes its stage throw, dropping the batch from
    // `ok` entirely. Neither is a pass that found nothing left to do, so
    // neither may confirm a still tree.
    const incomplete = ok.length < attempted || ok.some((r) => r.dead || r.deadRemove)
    // The retry allowance below bounds a failure that keeps repeating, not the
    // phase's lifetime: a pass in which every agent answered proves the earlier
    // death was transient, so the phase must not end on the next isolated one.
    if (!incomplete) incompleteRetries = 0
    // A skip never moves the tree, so accumulating skips only on the branch
    // where the hash moved would lose every skip reason from the pass that ends
    // the loop — usually the pass whose agents defended everything they saw.
    skipped.push(...ok.flatMap((r) => r.skipped))

    // A batch whose classifier keeps dying gets fresh attempts, but only a
    // bounded number: a user who skips the same agent every pass would
    // otherwise keep the loop alive until the round backstop. Only back-to-back
    // deaths mean a batch is unreachable, so a classifier that answered clears
    // the tally — without the reset, two flakes passes apart would drop a batch
    // that has been classified and pruned in between.
    for (const r of ok) {
      if (!r.dead) {
        r.batch.deadAttempts = 0
        continue
      }
      r.batch.deadAttempts = (r.batch.deadAttempts ?? 0) + 1
      if (r.batch.deadAttempts >= 2) {
        unauditedFiles.push(...r.batch.files)
        log(`prune: batch ${r.batch.id} abandoned after ${r.batch.deadAttempts} consecutive classify agents died — it never produced a clean pass, so its comments may not be fully audited`)
      }
    }
    const abandonedIds = new Set(ok.filter((r) => r.dead && r.batch.deadAttempts >= 2).map((r) => r.batch.id))

    // Retire batches that produced no candidates. Re-classifying a settled
    // batch every pass invites agents to justify the visit by flagging
    // borderline comments, so the tree keeps changing and the hash never
    // repeats.
    const cleanIds = new Set(ok.filter((r) => r.clean).map((r) => r.batch.id))
    activeBatches = activeBatches.filter((b) => !cleanIds.has(b.id) && !abandonedIds.has(b.id))
    batchesDone += cleanIds.size

    const hash = await runHash(input.hashCmd, `hash:prune@${pruneIterations}`)
    if (!hash) {
      pruneStop = 'hash-unavailable'
      // Same reason as the skips above: the removals of the pass that ends the
      // loop are real, and counting them only where the hash moved would report
      // an edited tree as one nothing was removed from.
      removed += passRemoved
      log(`prune ${pruneIterations}: hash agent could not return a hash — a settled tree cannot be confirmed; stopping and reporting the work done so far`)
      break
    }
    if (pruneSeen.has(hash)) {
      // One more attempt for the batches an agent left unfinished, then out: a
      // failure that keeps repeating — a user skipping every remove agent, an
      // exhausted budget — would otherwise re-run it until the round backstop.
      if (incomplete && activeBatches.length && incompleteRetries < 1) {
        incompleteRetries++
        log(`prune ${pruneIterations}: no new tree state, but an agent died with candidates outstanding — retrying its batch`)
        continue
      }
      if (incomplete) {
        pruneStop = 'incomplete-dead-agent'
        log(`prune ${pruneIterations}: agents kept dying with candidates outstanding — stopping with batches unfinished`)
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

  // Removal agents edit in parallel and never run project-wide commands, so
  // one fix-up on the settled tree is the safety net for broken syntax. Every
  // remover is awaited before its pass's hash, so a phase that never left the
  // seed state proves nothing moved; only a phase that ended with no hash at
  // all has to fall back on a remover having been dispatched.
  if (input.checkCmd && !checkDisabled && (pruneSeen.size > 1 || (pruneEdited && pruneStop === 'hash-unavailable'))) {
    // This fix-up runs last on the final tree, so it adjudicates what the
    // simplify fix-up left broken too — otherwise its verdict would replace a
    // failure it was never told about.
    const carried = outstandingFailures
    const touched = [...new Set([...pruneList, ...carried.map((f) => f.file).filter((f) => f !== UNATTRIBUTED)])]
    const fix = await runFix('fix:prune', touched, 'comment-pruning', carried)
    if (!fix) {
      pruneVerification = 'fixup-died'
      log('prune fix-up agent died — project state unverified')
    } else {
      pruneVerification = 'ran'
      outstandingFailures = fixFailures(fix, 'comment-pruning')
      if (fix.fixed.length) log(`prune fix-up repaired ${fix.fixed.length} issue(s)`)
      if (fix.remaining.length) log(`prune fix-up leaves ${fix.remaining.length} failure(s) unresolved`)
    }
  }

  // A batch re-classified across passes can report the same skip more than once.
  // A remover that edits and then dies reports no removal, so `removed` alone
  // cannot say the tree moved; the pass hashes can, though a pre-fix seed
  // leaves the first of them counting the simplify fix-up's edits.
  prune = { iterations: pruneIterations, stopReason: pruneStop, distinctTreeStates: pruneSeen.size - 1, removed, skipped: [...new Set(skipped)], batchesDone, batchesTotal, unauditedFiles, verificationStatus: pruneVerification }
} else if (input.prune) {
  prune = { stopReason: 'skipped-simplify-unstable' }
}

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
  summary,
}
