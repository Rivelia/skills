export const meta = {
  name: 'no-comments',
  description: 'Strip comments over a file list with Comment Sicko and audit each batch; then fix what the accepted flags name and encode the claimed constraints (full), return them as seeds (flags), or only report them (delete-only); commits what it changed',
  phases: [
    { title: 'Baseline', detail: 'full mode with a check command: Haiku runs it once before any edit', model: 'haiku' },
    { title: 'Sicko', detail: 'Comment Sicko, its prompt verbatim, per batch of files', model: 'opus' },
    { title: 'Audit', detail: 'the no-comments review step, verbatim, per batch; a rejected batch is reverted and rerun once', model: 'opus' },
    { title: 'Fix', detail: 'full mode: the no-comments fix and encoding steps over every accepted flag' },
    { title: 'Verify', detail: 'full mode: one Opus fix-up running the check command', model: 'opus' },
    { title: 'Commit', detail: 'Sonnet commits the pass', model: 'sonnet' },
  ],
}

const MODES = ['full', 'flags', 'delete-only']

const input = typeof args === 'string' ? JSON.parse(args) : args

if (!input || !MODES.includes(input.mode)) {
  throw new Error(`args.mode must be one of ${MODES.join(', ')}`)
}
if (typeof input.root !== 'string' || !input.root.startsWith('/')) {
  throw new Error('args.root: the absolute project root is required')
}
if (input.base !== undefined && (typeof input.base !== 'string' || !/^[0-9a-f]{7,64}$/.test(input.base))) {
  throw new Error('args.base: the hex commit bounding the diff whose comments are in scope; omit it to audit every comment in the files')
}
if (!Array.isArray(input.files) || input.files.some((f) => typeof f !== 'string' || !f.trim())) {
  throw new Error('args.files: string[] of the repo-relative files to audit is required')
}
for (const key of ['context', 'checks', 'checkCmd', 'model', 'tag']) {
  if (input[key] !== undefined && (typeof input[key] !== 'string' || !input[key].trim())) {
    throw new Error(`args.${key}: a non-empty string when given; omit it otherwise`)
  }
}
if (input.lines !== undefined && (!input.lines || typeof input.lines !== 'object' || Array.isArray(input.lines)
  || Object.values(input.lines).some((n) => !Number.isInteger(n) || n < 0))) {
  throw new Error('args.lines: an object mapping a file to its line count when given; omit it otherwise')
}

const ROOT = input.root
const BASE = input.base || null
const MODE = input.mode
const FILES = [...new Set(input.files.map((f) => f.trim()))]
const CHECKS = input.checks ? input.checks.trim() : null
const CHECK_CMD = MODE === 'full' && input.checkCmd ? input.checkCmd.trim() : null
const TAG = input.tag ? `@${input.tag.trim()}` : ''
const LINES = input.lines || {}
const BATCH_LINES = 2000
const BATCH_FILES_MAX = 15
const UNKNOWN_FILE_LINES = BATCH_LINES / 5
const FIX_GROUP_MAX = 20

const SICKO_OPTS = { model: 'opus', effort: 'high' }
const AUDIT_OPTS = { model: 'opus', effort: 'high' }
const FIX_OPTS = { model: input.model ? input.model.trim() : 'opus', effort: 'high' }
const FIXUP_OPTS = { model: 'opus', effort: 'high' }
const CHECK_OPTS = { model: 'haiku', effort: 'low' }
const COMMIT_OPTS = { model: 'sonnet', effort: 'low' }
const REVERT_OPTS = { model: 'haiku', effort: 'low' }

const shellQuote = (s) => `'${s.replace(/'/g, `'\\''`)}'`
const REPO = `Repository (the project root): ${ROOT}. Run every command from there; every relative path is relative to it.`
const RUN_CHECK = CHECK_CMD && `Run exactly this command:

cd ${shellQuote(ROOT)} && (
${CHECK_CMD}
)`
const CONTEXT = input.context ? `${REPO}\n${input.context.trim()}` : REPO
const CONVENTION = input.context
  ? "the project's commit convention (from the context above)"
  : "the project's commit convention (read `git log --format=%s -n 20` and CLAUDE.md or AGENTS.md)"
const NO_COMMENTS_LINE = 'Write no comments. When code needs one to be understood, reshape the code instead.'
const PATHS_LINE = "Report every path relative to the project root, with no leading './'."
const NO_COMMIT = 'Commit nothing; the workflow commits the pass.'

const SICKO_PROMPT = `# Comment Sicko

My first output when spawned is exactly this.

Yes... Ha ha ha... Yes!

I hate comments. Feed me the scoped files or diff below. If none is given, feed me the current diff against \`main\`. Narration, banners, commented-out corpses, workaround sermons. I want them all.

Only these exceptions get to crawl away.

- Legal or license headers.
- Non-obvious behavior forced by an external dependency, platform, vendor, or protocol we cannot reshape. Surprises in our own code are meat. Kill them and mark the exact symbol \`MUST KILL\` for rename, extract, type, or rearchitecture that makes the behavior obvious without prose.
- \`// prettier-ignore\`. Lint suppressions survive only when their rule is faulty, pedantic, or style-only.
- Doc comments that define a public API contract.
- Issue or RFC links that explain a constraint code cannot express.
- Comments a tool reads and acts on: shebangs, compiler, build, or runtime directives, encoding and magic comments, test-environment pragmas, and annotations such as \`//go:build\`, \`# -*- coding: utf-8 -*-\`, \`@vitest-environment\`, \`/*#__PURE__*/\`, or \`// @ts-check\`.

That list is my only leash. When I am not sure a keep clause applies, the comment dies. Everything else is meat.

\`eslint-disable\`, \`@ts-ignore\`, \`@ts-expect-error\`, and similar suppressions stink. Look up the rule. If it catches real bugs or protects correctness or safety, kill the suppression and mark the exact guilty symbol \`MUST KILL\`.

\`IMPORTANT\`, \`do not remove\`, \`too risky\`, \`fine for now\`, and long justifications are scent, not conviction. Before judging, I read nearby code. If its claim is not obvious there, I trace the named symbol or call: its definition and live callers, then \`git log -L\` or \`git blame\` on the comment and the commit that added it. Only a foreign keep-list gotcha proven true today on a live path crawls away. Our-code surprises die with the reshape flag above. Doubt after the hunt is meat.

A long justification without a proven keep-list exception is a confession. Kill it. Never polish meat into a shorter alibi. Mark the exact guilty symbol \`MUST KILL\`. My kill ends there. I do not touch the code.

Every flag names code inside the scope and tells the truth. I invent nothing. I delete comments and identify refactor targets. I never write application code.

Report only. Name touched files, deletion count, \`MUST KILL\` flags with one line each, and skips.`

const SKILL_INTRO = 'Spawn Comment Sicko. Act on accepted findings. Defer to its fresh perspective: it has none of your context, which is the point.'

const TRACING = 'Some steps below say to trace a symbol. Read its definition and live callers, then `git log -L` or `git blame` the comment and read the commit that added it. A claim holds only if that evidence shows it is true today on a live path.'

const STEP_2 = '2. Inspect its report and diff. Reject application-code edits, scope escapes, deletions the exception list protects, misstated `MUST KILL` reasons, and flags that treat kept intentional code as guilty. Reshape flags on surprises in our own code stay actionable; do not restore those comments. A keep survives only with proof it is about something we cannot change. Audit lint and TypeScript suppressions in scope that it missed; correctness or safety suppressions stay actionable `MUST KILL`s. Restore a deletion only when it fits an exception exactly and the proof is in scope. Before accepting a kill or keep that rests on a thin `IMPORTANT` or `do not remove`, trace its symbol. If a kill is ambiguous, do not restore. If a keep is refuted or still ambiguous, delete it. On a rejected report, revert its diff and rerun once with the failure named. Reject a second, report it open, and stop.'

const STEP_3 = '3. Fix trivial accepted flags directly: delete the dead path, drop the parameter, use the real API. If any fix needs a new shape, sketch the shape for the whole accepted set and its surrounding code before writing any of it.'

const STEP_4 = '4. Implement the smallest root-cause fix in scope. Remove every named workaround; never bolt on symptom guards. If the root cause is out of scope, land the smallest in-scope fix and report the rest open. Do not widen the scope or fix instances outside it.'

const STEP_5 = '5. Encode each constraint with the cheapest in-scope enforcement, without asking: a type; else a lint rule; else a test; and a runtime check only when none of those can express the constraint. When no enforcement fits in scope, leave the comment deleted and report the constraint in `unenforced`.'

const SICKO_SCHEMA = {
  type: 'object',
  properties: {
    touchedFiles: { type: 'array', items: { type: 'string' } },
    deletions: { type: 'integer' },
    mustKills: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          symbol: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'symbol', 'reason'],
      },
    },
    skips: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          comment: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['file', 'comment', 'reason'],
      },
    },
  },
  required: ['touchedFiles', 'deletions', 'mustKills', 'skips'],
}

const FLAG_ITEMS = {
  type: 'array',
  items: {
    type: 'object',
    properties: {
      file: { type: 'string' },
      symbol: { type: 'string' },
      reason: { type: 'string', description: 'One line: the surprise the reshape removes, or the correctness the suppression guards.' },
    },
    required: ['file', 'symbol', 'reason'],
  },
}

const AUDIT_SCHEMA = {
  type: 'object',
  properties: {
    verdict: { type: 'string', enum: ['accept', 'reject'] },
    failure: { type: 'string', description: 'For reject: the failure, named in one sentence. Empty for accept.' },
    restored: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          comment: { type: 'string' },
          reason: { type: 'string', description: 'The exception it fits and the proof.' },
        },
        required: ['file', 'comment', 'reason'],
      },
    },
    deletedKeeps: { type: 'integer', description: 'How many refuted or ambiguous keeps you deleted.' },
    mustKills: { ...FLAG_ITEMS, description: 'Every accepted MUST KILL flag, Sicko\'s and the suppressions you added.' },
    constraints: {
      type: 'array',
      description: 'Every deleted constraint comment (`do not remove`, `do not change wording`, `talk to X before changing`) about something we can change.',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          symbol: { type: 'string' },
          constraint: { type: 'string', description: 'The constraint the comment claimed, quoted or restated exactly.' },
        },
        required: ['file', 'symbol', 'constraint'],
      },
    },
  },
  required: ['verdict', 'failure', 'restored', 'deletedKeeps', 'mustKills', 'constraints'],
}

const CHANGED_FILES = { type: 'array', items: { type: 'string' }, description: 'Every file you changed or created.' }

const FIX_SCHEMA = {
  type: 'object',
  properties: {
    shapeSketch: { type: 'string', description: 'The shape sketched for the accepted set; empty when every fix was trivial.' },
    fixes: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          symbol: { type: 'string' },
          description: { type: 'string', description: 'One sentence: what changed.' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['symbol', 'description', 'files'],
      },
    },
    encodings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          constraint: { type: 'string' },
          kind: { type: 'string', enum: ['type', 'lint', 'test', 'runtime-check'] },
          where: { type: 'string', description: 'The symbol, rule or test that now enforces it.' },
          files: { type: 'array', items: { type: 'string' } },
        },
        required: ['constraint', 'kind', 'where', 'files'],
      },
    },
    unenforced: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          constraint: { type: 'string' },
          file: { type: 'string' },
          sketch: { type: 'string', description: 'The out-of-scope work that would enforce it.' },
        },
        required: ['constraint', 'file', 'sketch'],
      },
    },
    open: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          item: { type: 'string' },
          reason: { type: 'string' },
        },
        required: ['item', 'reason'],
      },
    },
    files: CHANGED_FILES,
  },
  required: ['shapeSketch', 'fixes', 'encodings', 'unenforced', 'open', 'files'],
}

const FAILURE_LIST_SCHEMA = {
  type: 'array',
  items: {
    type: 'object',
    properties: { file: { type: 'string' }, message: { type: 'string' } },
    required: ['file', 'message'],
  },
}

const CHECK_SCHEMA = {
  type: 'object',
  properties: { passed: { type: 'boolean' }, failures: FAILURE_LIST_SCHEMA },
  required: ['passed', 'failures'],
}

const FIXUP_SCHEMA = {
  type: 'object',
  properties: {
    passed: { type: 'boolean' },
    fixed: { type: 'array', items: { type: 'string' } },
    remaining: FAILURE_LIST_SCHEMA,
    files: CHANGED_FILES,
  },
  required: ['passed', 'fixed', 'remaining', 'files'],
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

const REVERT_SCHEMA = {
  type: 'object',
  properties: { done: { type: 'boolean' } },
  required: ['done'],
}

function scopeBlock(files, failure) {
  const bound = BASE
    ? `The scoped diff is \`git --literal-pathspecs diff -U0 ${BASE} HEAD -- <file>\` for each file: only the comments inside its hunks, as HEAD holds them, are in scope.`
    : 'Every comment in these files is in scope.'
  const keepGuards = MODE === 'full'
    ? ''
    : '\n\nNothing in this pass reshapes the code or runs the project checks, so a suppression whose rule catches real bugs or protects correctness or safety stays in place, restored if it was deleted, with its exact symbol marked `MUST KILL`.'
  const rerun = failure
    ? `\n\nAn earlier Comment Sicko pass over these files was rejected and reverted: ${failure}`
    : ''
  return `## Scope

Files:
${files.map((f) => `- ${f}`).join('\n')}

${bound} Other agents work on other files at the same time: touch only these files.${keepGuards}${rerun}`
}

function fixScopeBlock() {
  return `## Scope

The flags and constraints below, not just their files: a fix extends to the callers of a flagged symbol wherever they live, and an encoding to the test or lint-config file it needs.`
}

function sickoPrompt(batch, failure) {
  return `${REPO}

${SICKO_PROMPT}

${scopeBlock(batch, failure)}`
}

function auditPrompt(batch, sicko) {
  return `${CONTEXT}

You are the orchestrator of the no-comments skill. ${SKILL_INTRO}

Comment Sicko has just run over the files below; the tree was committed before it ran, so \`git --literal-pathspecs diff HEAD -- <files>\` is its diff over them. A path outside them in its \`touchedFiles\` is a scope escape.

${scopeBlock(batch)}

Its report (JSON):
${JSON.stringify(sicko)}

## Tracing a claim

${TRACING}

## Your step

${STEP_2}

How that step runs here: make the restorations and the deletions of refuted keeps yourself, editing only comment lines. The workflow, not you, reruns Comment Sicko. On verdict=reject it reverts with git the paths HEAD tracks among these files and the scope escapes outside every batch, so first edit back by hand, never with git, any edit Sicko made in a path HEAD does not track.`
}

function fixPrompt(flags, constraints, split) {
  const splitBlock = split
    ? `\n\nThe accepted set is split by file into ${split.count} groups worked one after another; yours is group ${split.index + 1}, the items above. Act only on those, but sketch the shape against the whole accepted set below, consistent with the earlier groups' sketches; their edits are already in the working tree.\n\nThe whole accepted set (JSON):\n${JSON.stringify({ flags: split.flags, constraints: split.constraints })}\n\nShape sketches of the earlier groups:\n${split.sketches.length ? split.sketches.join('\n\n') : '(none)'}`
    : ''
  const checks = CHECKS
    ? `Then run the project checks relevant to what you touched:\n${CHECKS}\nFix what they flag without going beyond the flags. A flag whose fix cannot pass them that way: undo your own hunks for it and report it in \`open\`.`
    : 'Then run the existing tests that cover the files you touched.'
  return `${CONTEXT}

You are the orchestrator of the no-comments skill. ${SKILL_INTRO} Comment Sicko stripped the comments of the scope below and you accepted its flags.

${fixScopeBlock()}

Accepted \`MUST KILL\` flags (JSON):
${JSON.stringify(flags)}

Deleted constraint comments about things we can change (JSON):
${JSON.stringify(constraints)}${splitBlock}

## Your steps

${STEP_3}
${STEP_4}
${STEP_5}

${checks}

${NO_COMMENTS_LINE} ${NO_COMMIT} ${PATHS_LINE}`
}

function checkPrompt() {
  return `${RUN_CHECK}

For every failure it reports, give the implicated file and a one-line message. ${PATHS_LINE} Edit nothing.`
}

function fixupPrompt(baseline, touched) {
  const baselineNote = baseline && !baseline.passed
    ? `\n\nThe command already failed BEFORE this pass${baseline.failures.length ? ', with these failures, which are not yours to fix or list in `remaining`:\n' + baseline.failures.map((f) => `- ${f.file}: ${f.message}`).join('\n') : ', without naming a file; do not list a failure you cannot tie to this pass\'s edits'}. Report passed=true when only those remain.`
    : ''
  return `${REPO}

${RUN_CHECK}

A comment pass has just stripped comments and reshaped code in this project. If the command fails, fix the failures the pass caused, then re-run it, repeating until it passes or you have made three rounds of fixes. Keep every fix minimal and behaviour-preserving. ${NO_COMMENTS_LINE} ${NO_COMMIT}${baselineNote}

Files the pass touched:
${touched.map((f) => `- ${f}`).join('\n')}

${PATHS_LINE}`
}

function restoreCommand(files) {
  return `git --literal-pathspecs ls-files -z -- ${files.map(shellQuote).join(' ')} | xargs -0 -r git --literal-pathspecs checkout HEAD --`
}

function revertPrompt(files) {
  return `Run exactly this command:

cd ${shellQuote(ROOT)} && ${restoreCommand(files)}

Other batches run git at the same time: if it fails because \`.git/index.lock\` exists, wait a few seconds and run it again, up to five runs in all; never delete the lock file. Report done=true once a run exits 0. Do nothing else.`
}

function commitPrompt(summary, ranChecks) {
  const checkOutputs = ranChecks.length
    ? `, except outputs of these check commands, which ran in this tree:\n\n${ranChecks.join('\n\n')}\n\nAn untracked path those commands wrote, rather than a file the pass created, is not the pass's: delete it before staging. Stage everything else`
    : '. Stage them all'
  return `${CONTEXT}

A comment pass has just edited this repository, which was clean before it ran, so every path \`git status --porcelain --untracked-files=all\` lists is the pass's own${checkOutputs} with \`git add -A\` and \`git commit\` with a message in ${CONVENTION}, with no attribution lines or trailers. The subject says comments were stripped${MODE === 'full' ? ', and code reshaped or constraints encoded when the summary below lists any' : ''}; the body may list:
${summary}

Make sure nothing remains dirty.`
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

function batchesOf(list, size) {
  const out = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

function fixGroups(flags, constraints) {
  const items = [...flags.map((f) => ({ kind: 'flag', item: f })), ...constraints.map((c) => ({ kind: 'constraint', item: c }))]
  if (items.length <= FIX_GROUP_MAX) return [items]
  const byFile = new Map()
  for (const it of items) {
    if (!byFile.has(it.item.file)) byFile.set(it.item.file, [])
    byFile.get(it.item.file).push(it)
  }
  const groups = []
  let current = []
  const lists = [...byFile.values()].flatMap((list) => batchesOf(list, FIX_GROUP_MAX))
  for (const list of lists) {
    if (current.length && current.length + list.length > FIX_GROUP_MAX) {
      groups.push(current)
      current = []
    }
    current.push(...list)
  }
  if (current.length) groups.push(current)
  return groups
}

const empty = (extra = {}) => ({
  mode: MODE,
  batches: 0,
  deletions: 0,
  restored: [],
  reruns: 0,
  revertedBatches: [],
  deadBatches: [],
  mustKills: { applied: [], reported: [] },
  seeds: [],
  shapeSketch: [],
  encodings: [],
  unenforced: [],
  open: [],
  fixFiles: [],
  checkFailures: [],
  verification: 'not-configured',
  commit: null,
  head: null,
  ...extra,
})

if (FILES.length === 0) {
  log(`no-comments${TAG}: no file to audit`)
  return empty()
}

let baseline = null
let verification = CHECK_CMD ? 'no-changes' : 'not-configured'
if (CHECK_CMD) {
  phase('Baseline')
  for (let attempt = 1; attempt <= 2 && !baseline; attempt++) {
    baseline = await run(checkPrompt(), { label: `check:baseline${TAG}.${attempt}`, phase: 'Baseline', schema: CHECK_SCHEMA, ...CHECK_OPTS })
  }
  if (!baseline) {
    verification = 'baseline-failed'
    log(`no-comments${TAG}: the baseline check died twice; the fix-up will not run`)
  }
}

const batches = []
let batchLines = 0
for (const f of FILES) {
  const n = LINES[f] ?? UNKNOWN_FILE_LINES
  const last = batches[batches.length - 1]
  if (last && last.length < BATCH_FILES_MAX && batchLines + n <= BATCH_LINES) {
    last.push(f)
    batchLines += n
  } else {
    batches.push([f])
    batchLines = n
  }
}
log(`no-comments${TAG} (${MODE}): ${FILES.length} file(s) in ${batches.length} batch(es)${BASE ? `, comments in the diff against ${BASE.slice(0, 8)}` : ', every comment'}`)

async function revert(batch, why) {
  const r = await run(revertPrompt(batch), { label: `revert${TAG}:${batch[0]}`, phase: 'Audit', schema: REVERT_SCHEMA, ...REVERT_OPTS })
  if (!r?.done) log(`no-comments${TAG}: could not revert the batch starting at ${batch[0]} after ${why}; its unaudited edits stay in the tree`)
  return !!r?.done
}

// A Sicko report that deletes, flags and keeps nothing leaves the auditor no
// deletion to restore and no keep to refute.
const NOTHING_TO_AUDIT = { verdict: 'accept', failure: '', restored: [], deletedKeeps: 0, mustKills: [], constraints: [] }

async function runBatch(batch) {
  let failure = null
  let reruns = 0
  for (let attempt = 1; attempt <= 2; attempt++) {
    const label = `${batch[0]}${batch.length > 1 ? ` +${batch.length - 1}` : ''}${TAG}${attempt > 1 ? ' rerun' : ''}`
    const sicko = await run(sickoPrompt(batch, failure), { label: `sicko:${label}`, phase: 'Sicko', schema: SICKO_SCHEMA, ...SICKO_OPTS })
    if (!sicko) {
      const reverted = await revert(batch, 'a dead Comment Sicko')
      return { batch, status: 'dead', at: 'Comment Sicko', reverted, reruns }
    }
    if (!sicko.deletions && !sicko.touchedFiles.length && !sicko.mustKills.length && !sicko.skips.length) {
      return { batch, status: 'accepted', sicko, audit: NOTHING_TO_AUDIT, reruns }
    }
    const touched = [...new Set([...batch, ...sicko.touchedFiles.filter((f) => !FILES.includes(f))])]
    const audit = await run(auditPrompt(batch, sicko), { label: `audit:${label}`, phase: 'Audit', schema: AUDIT_SCHEMA, ...AUDIT_OPTS })
    if (!audit) {
      const reverted = await revert(touched, 'a dead auditor')
      return { batch: touched, status: 'dead', at: 'auditor', reverted, reruns }
    }
    if (audit.verdict === 'accept') return { batch, status: 'accepted', sicko, audit, reruns }
    failure = audit.failure || 'the auditor named no failure'
    log(`no-comments${TAG}: batch ${batch[0]} rejected: ${failure}`)
    const reverted = await revert(touched, 'a rejected report')
    if (!reverted || attempt === 2) return { batch: touched, status: 'rejected', failure, reverted, reruns }
    reruns++
  }
}

phase('Sicko')
const results = (await pipeline(batches, (batch) => runBatch(batch))).map((r, i) => r || { batch: batches[i], status: 'dead', at: 'the batch stage', reverted: false, reruns: 0 })

const accepted = results.filter((r) => r.status === 'accepted')
const out = empty({
  batches: batches.length,
  deletions: accepted.reduce((n, r) => n + (r.sicko.deletions || 0) - r.audit.restored.length + (r.audit.deletedKeeps || 0), 0),
  restored: accepted.flatMap((r) => r.audit.restored),
  reruns: results.reduce((n, r) => n + r.reruns, 0),
  revertedBatches: results.filter((r) => r.status === 'rejected').map((r) => ({ files: r.batch, failure: r.failure, reverted: r.reverted })),
  deadBatches: results.filter((r) => r.status === 'dead').map((r) => ({ files: r.batch, at: r.at, reverted: r.reverted })),
})
const flags = accepted.flatMap((r) => r.audit.mustKills)
const constraints = accepted.flatMap((r) => r.audit.constraints)
log(`no-comments${TAG}: ${out.deletions} comment(s) deleted, ${out.restored.length} restored, ${flags.length} MUST KILL flag(s), ${constraints.length} constraint(s), ${out.revertedBatches.length} batch(es) rejected, ${out.deadBatches.length} dead`)

let fixAgentDied = false
let fixDispatched = false
if (MODE === 'flags') {
  out.seeds = [
    ...flags.map((f) => ({ kind: 'must-kill', file: f.file, symbol: f.symbol, description: f.reason })),
    ...constraints.map((c) => ({ kind: 'constraint', file: c.file, symbol: c.symbol, description: c.constraint })),
  ]
} else if (MODE === 'delete-only') {
  out.mustKills.reported = flags
  out.unenforced = constraints.map((c) => ({ constraint: c.constraint, file: c.file, sketch: '' }))
} else if (flags.length || constraints.length) {
  phase('Fix')
  const groups = fixGroups(flags, constraints)
  fixDispatched = true
  for (const [k, group] of groups.entries()) {
    const gFlags = group.filter((g) => g.kind === 'flag').map((g) => g.item)
    const gConstraints = group.filter((g) => g.kind === 'constraint').map((g) => g.item)
    const fix = await run(fixPrompt(gFlags, gConstraints, groups.length > 1 ? { index: k, count: groups.length, flags, constraints, sketches: out.shapeSketch } : null), { label: `fix${TAG}${groups.length > 1 ? `.${k + 1}` : ''}`, phase: 'Fix', schema: FIX_SCHEMA, ...FIX_OPTS })
    if (!fix) {
      log(`no-comments${TAG}: fix agent ${k + 1} died; its flags are reported open`)
      out.mustKills.reported.push(...gFlags)
      out.unenforced.push(...gConstraints.map((c) => ({ constraint: c.constraint, file: c.file, sketch: 'the fix agent died before encoding it' })))
      out.open.push({ item: `fix group ${k + 1}`, reason: 'the fix agent died; anything it edited before dying is in the commit unverified by it' })
      out.fixFiles.push(...gFlags.map((f) => f.file), ...gConstraints.map((c) => c.file))
      fixAgentDied = true
      continue
    }
    out.mustKills.applied.push(...fix.fixes)
    if (fix.shapeSketch && fix.shapeSketch.trim()) out.shapeSketch.push(fix.shapeSketch.trim())
    out.encodings.push(...fix.encodings)
    out.unenforced.push(...fix.unenforced)
    out.open.push(...fix.open)
    out.fixFiles.push(...fix.files)
  }
  out.fixFiles = [...new Set(out.fixFiles)]
}

const unrevertedFiles = [...out.deadBatches, ...out.revertedBatches].filter((d) => !d.reverted).flatMap((d) => d.files)
if (CHECK_CMD && baseline && (out.deletions > 0 || out.fixFiles.length > 0 || unrevertedFiles.length > 0)) {
  phase('Verify')
  const touched = [...new Set([...accepted.flatMap((r) => r.sicko.touchedFiles), ...out.fixFiles, ...unrevertedFiles])]
  const fixup = await run(fixupPrompt(baseline, touched), { label: `fixup${TAG}`, phase: 'Verify', schema: FIXUP_SCHEMA, ...FIXUP_OPTS })
  if (!fixup) {
    verification = 'fixup-died'
    log(`no-comments${TAG}: the fix-up died; the pass is unverified`)
  } else {
    verification = 'ran'
    out.fixFiles = [...new Set([...out.fixFiles, ...fixup.files])]
    out.checkFailures = fixup.passed ? [] : (fixup.remaining.length ? fixup.remaining : [{ file: '(unattributed)', message: 'the check still fails after the fix-up, which named no failure' }])
  }
}
out.verification = verification

phase('Commit')
const summary = [
  `- ${out.deletions} comment(s) deleted`,
  ...out.mustKills.applied.map((f) => `- ${f.symbol}: ${f.description}`),
  ...out.encodings.map((e) => `- enforced by a ${e.kind} (${e.where}): ${e.constraint}`),
].join('\n')
const commit = await run(commitPrompt(summary, [...new Set([fixDispatched && CHECKS, CHECK_CMD].filter(Boolean))]), { label: `commit${TAG}`, phase: 'Commit', schema: COMMIT_SCHEMA, ...COMMIT_OPTS })
out.commit = commit
  ? { committed: commit.committed === true, commitSha: commit.committed ? commit.commitSha : null, files: commit.files || [], discarded: commit.discarded || [], reason: commit.reason || null, clean: commit.clean === true }
  : { committed: false, commitSha: null, files: [], discarded: [], reason: 'the commit agent died', clean: false }
if (fixAgentDied) out.fixFiles = [...new Set([...out.fixFiles, ...out.commit.files])]
out.head = commit && /^[0-9a-f]{7,64}$/.test(commit.head || '') ? commit.head : null
log(out.commit.committed ? `no-comments${TAG}: committed as ${out.commit.commitSha}` : `no-comments${TAG}: nothing committed (${out.commit.reason})`)

return out
