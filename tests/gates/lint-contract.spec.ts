/**
 * Negative control for the lint gate.
 *
 * A lint rule that is configured but never fires is worse than no rule: it reads
 * as protection while enforcing nothing. Each fixture below is code the rule must
 * reject, so deleting the rule or breaking its wiring turns the suite red.
 */
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

/** The project's own lint binary, so the spec cannot resolve a different one. */
const OXLINT = join('node_modules', '.bin', 'oxlint')

/** Rules the gate claims, and the fixture each must reject. */
const CONTRACT = [
  { rule: 'no-explicit-any', fixture: 'tests/gates/fixtures/any.ts' },
  { rule: 'no-floating-promises', fixture: 'tests/gates/fixtures/floating-promise.ts' },
  { rule: 'no-non-null-assertion', fixture: 'tests/gates/fixtures/assertions.ts' },
] as const

/** Run the real configuration over one file. */
function lint(file: string): { readonly status: number | null; readonly output: string } {
  const result = spawnSync(OXLINT, ['-c', '.oxlintrc.json', '--type-aware', file], { encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/** The gate's declared rule configuration. */
function lintConfig(): Record<string, unknown> {
  const parsed = JSON.parse(readFileSync('.oxlintrc.json', 'utf8')) as { rules?: Record<string, unknown> }
  return parsed.rules ?? {}
}

describe('lint gate', () => {
  it.each(CONTRACT)('rejects $rule with the project configuration', ({ rule, fixture }) => {
    const { status, output } = lint(fixture)
    expect(status, `${fixture} should fail the gate`).not.toBe(0)
    expect(output).toContain(rule)
  })

  it('declares every contract rule as an error', () => {
    const rules = lintConfig()
    for (const { rule } of CONTRACT) {
      const configured = rules[rule]
      const severity = Array.isArray(configured) ? (configured as readonly unknown[])[0] : configured
      expect(severity, rule).toBe('error')
    }
  })

  it('keeps the deliberately broken fixtures out of the project-wide run', () => {
    // Without the exclusion `pnpm run lint` could never be green, and a
    // permanently red gate is one people learn to ignore.
    const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
    expect(manifest.scripts?.['lint']).toContain('tests/gates/fixtures/**')
  })
})
