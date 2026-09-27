/**
 * Negative control for the typecheck gate.
 *
 * The gate is only as strong as its switches: turning one off leaves `tsc` green
 * while the class of bug it caught goes unguarded. These assertions turn that
 * silent edit into a red suite.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/** The subset of `tsconfig.json` these assertions read. */
interface TsconfigShape {
  readonly compilerOptions?: Record<string, unknown>
  readonly include?: readonly string[]
}

/** Switches without which the typecheck gate is decorative. */
const REQUIRED_SWITCHES = [
  'strict',
  'noUncheckedIndexedAccess',
  'exactOptionalPropertyTypes',
  'noFallthroughCasesInSwitch',
  'noImplicitOverride',
] as const

/** Read the project's compiler configuration. */
function readTsconfig(): TsconfigShape {
  return JSON.parse(readFileSync('tsconfig.json', 'utf8')) as TsconfigShape
}

describe('typecheck gate', () => {
  it('keeps every strictness switch on', () => {
    const options = readTsconfig().compilerOptions ?? {}
    for (const name of REQUIRED_SWITCHES) expect(options[name], name).toBe(true)
  })

  it('typechecks the specs as well as the source', () => {
    // A spec outside the program is unchecked prose: it can reference removed
    // exports and still pass in CI.
    const include = readTsconfig().include ?? []
    expect(include).toContain('src/**/*.ts')
    expect(include).toContain('src/**/*.tsx')
    expect(include).toContain('tests/**/*.ts')
    expect(include).toContain('tests/**/*.tsx')
  })
})
