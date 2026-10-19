const { test } = require('node:test')
const assert = require('node:assert/strict')
const { readFileSync } = require('node:fs')
const { join } = require('node:path')

const root = join(__dirname, '..')
const read = (path) => readFileSync(join(root, path), 'utf8')

function constant(path, name) {
  const source = read(path)
  const declaration = `\nconst ${name} = `
  const at = source.indexOf(declaration)
  assert.notEqual(at, -1, `${path} declares no ${name}`)
  const start = at + declaration.length
  const quote = source[start]
  assert.ok(quote === "'" || quote === '`', `${path}: ${name} is not a plain string literal`)
  let end = start + 1
  while (end < source.length && source[end] !== quote) end += source[end] === '\\' ? 2 : 1
  assert.ok(end < source.length, `${path}: ${name} is not a plain string literal`)
  const literal = source.slice(start, end + 1)
  assert.match(source.slice(end + 1), /^[ \t]*(\r?\n|$)/, `${path}: ${name} continues past its first string literal`)
  assert.ok(!literal.includes('${'), `${path}: ${name} interpolates, so it cannot be compared verbatim`)
  return Function(`return ${literal}`)()
}

test('no-comments.mjs embeds the Comment Sicko prompt of no-comments/SKILL.md verbatim', () => {
  const fenced = /\n````markdown\n([\s\S]*?)\n````\n/.exec(read('no-comments/SKILL.md'))
  assert.ok(fenced, 'no-comments/SKILL.md has no fenced Comment Sicko prompt')
  assert.equal(constant('no-comments/no-comments.mjs', 'SICKO_PROMPT'), fenced[1])
})

test('no-comments.mjs embeds the intro, the tracing rule and steps 2 to 4 of no-comments/SKILL.md verbatim', () => {
  const skillLines = read('no-comments/SKILL.md').split('\n')
  const prefixes = {
    SKILL_INTRO: 'Spawn Comment Sicko.',
    TRACING: 'Some steps below say to trace',
    STEP_2: '2. ',
    STEP_3: '3. ',
    STEP_4: '4. ',
  }
  for (const [name, prefix] of Object.entries(prefixes)) {
    const matches = skillLines.filter((line) => line.startsWith(prefix))
    assert.equal(matches.length, 1, `no-comments/SKILL.md has ${matches.length} lines starting with ${JSON.stringify(prefix)}`)
    assert.equal(constant('no-comments/no-comments.mjs', name), matches[0], `${name} differs from its line of no-comments/SKILL.md`)
  }
})

test('merge-ready.mjs and simplify.mjs share one default exclusion pattern', () => {
  assert.equal(
    constant('merge-ready-workflow/merge-ready.mjs', 'DEFAULT_EXCLUDE'),
    constant('simplify-workflow/simplify.mjs', 'DEFAULT_EXCLUDE'),
  )
})

test('merge-ready.mjs and simplify.mjs share one comment token pattern', () => {
  assert.equal(
    constant('merge-ready-workflow/merge-ready.mjs', 'COMMENT_TOKEN'),
    constant('simplify-workflow/simplify.mjs', 'COMMENT_TOKEN'),
  )
})
