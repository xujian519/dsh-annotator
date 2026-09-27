/**
 * Negative control for the coverage gate.
 *
 * The gate is vitest's own per-file threshold: every source file must reach 100%
 * on every metric. These assertions keep the scope from being narrowed and the
 * thresholds from being lowered, which are the two edits that would make a
 * per-file gate look healthy while measuring less.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import vitestConfig from '../../vitest.config'

/** Metrics every threshold is stated for. */
const METRICS = ['lines', 'statements', 'branches', 'functions'] as const

/** The coverage slice of the test configuration. */
interface CoverageShape {
  readonly include?: readonly string[]
  readonly reporter?: readonly string[]
  readonly thresholds?: Record<string, unknown>
}

/** Read the coverage configuration the gate actually runs under. */
function coverageConfig(): CoverageShape {
  const config = vitestConfig as unknown as { test?: { coverage?: CoverageShape; passWithNoTests?: boolean } }
  return config.test?.coverage ?? {}
}

/** Read the package's script table. */
function scripts(): Record<string, string> {
  const manifest = JSON.parse(readFileSync('package.json', 'utf8')) as { scripts?: Record<string, string> }
  return manifest.scripts ?? {}
}

describe('coverage gate', () => {
  it('measures every source file, without narrowing the scope', () => {
    // Excluding the files that are hard to cover is the one edit that would make
    // a per-file gate look healthy while measuring nothing.
    expect(coverageConfig().include).toEqual(['src/**/*.ts', 'src/**/*.tsx'])
  })

  it('holds every file to every metric, in full', () => {
    const thresholds = coverageConfig().thresholds ?? {}
    expect(thresholds['perFile']).toBe(true)
    for (const metric of METRICS) expect(thresholds[metric], metric).toBe(100)
  })

  it('fails on a test run that found no tests at all', () => {
    const config = vitestConfig as unknown as { test?: { passWithNoTests?: boolean } }
    expect(config.test?.passWithNoTests).not.toBe(true)
  })

  it('reaches the gate from one command', () => {
    expect(scripts()['test:coverage']).toContain('--coverage')
    const check = scripts()['check'] ?? ''
    for (const gate of ['typecheck', 'lint', 'test:coverage']) expect(check, gate).toContain(gate)
  })
})
