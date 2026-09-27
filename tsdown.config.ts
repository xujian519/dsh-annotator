/**
 * Build faces for dsh-annotator.
 *
 * The Host half is an ordinary ESM Node library (`lib/index.js`) that the
 * profile's Loader imports.
 *
 * The Client half must match the DSH dynamic-client contract: a CommonJS file at
 * `lib/client.js` whose only side effect is
 * `window.__ModuleLoader__.load({ id, factory })`, plus one package-local chunk
 * (`lib/client.pdf.js`) that the same loader fetches on demand. The factory
 * receives the shell's module-table `require`, so React stays the shell's shared
 * instance and nothing else may be imported from DSH packages (types only).
 *
 * The PDF chunk carries the whole rendering stack — PDF.js, its worker source
 * and the CMap/font/wasm data it reads — because the shell's on-demand route
 * serves only the artifact, and a preview must render offline. PDF.js is
 * Apache-2.0, so its notices travel in the chunk's banner; the chunk is fetched
 * only when a PDF is opened, which is what keeps startup unaffected.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { defineConfig, type UserConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-annotator'

/** Module-table specifiers the shell shares; everything else is inlined. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

/** Package-local chunk name the shell's on-demand route accepts. */
const CHUNK_FILE = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/u

/** The lazy PDF renderer chunk, named after its entry module. */
const PDF_CHUNK = 'client.pdf.js'

/** PDF.js's own worker, imported as text so the chunk can start it from a Blob URL. */
const WORKER_SPECIFIER = 'pdfjs-dist/build/pdf.worker.min.mjs?raw'

/** Virtual id the worker-source plugin answers with. */
const WORKER_MODULE = '\0dsh-annotator/pdf-worker'

/** PDF.js data directories inlined beside its runtime, and the getDocument option each feeds. */
const ASSET_KINDS: readonly (readonly [string, string])[] = [
  ['cMapUrl', 'cmaps'],
  ['standardFontDataUrl', 'standard_fonts'],
  ['wasmUrl', 'wasm'],
]

const require = createRequire(import.meta.url)

/** The installed PDF.js package root. */
function pdfRoot(): string {
  return dirname(require.resolve('pdfjs-dist/package.json'))
}

/** Third-party code bundled into the client chunk, whose licences travel with it. */
const BUNDLED_PACKAGES = [
  'pdf-lib',
  '@pdf-lib/standard-fonts',
  '@pdf-lib/upng',
  'pako',
  'tslib',
] as const

/** Names a bundled package's licence file may carry. */
const LICENCE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENSE-MIT', 'license'] as const

/** License files of PDF.js and of the data embedded beside it. */
function pdfLicenceFiles(root: string): string[] {
  return ['LICENSE', ...ASSET_KINDS.flatMap(([, directory]) =>
    readdirSync(join(root, directory))
      .filter(name => name.startsWith('LICENSE'))
      .sort()
      .map(name => `${directory}/${name}`),
  )]
}

/** Keep every bundled licence visible in the published artifact. */
function licenceBanner(): string {
  const root = pdfRoot()
  const notices = pdfLicenceFiles(root)
    .map(name => `${name}\n\n${readFileSync(join(root, name), 'utf8').trimEnd()}`)
    .join('\n\n')
  const all = [notices, bundledLicenceBanner()].join('\n\n')
  return ['//! Bundled third-party licence notices', ...all.split('\n').map(line => `// ${line}`)].join('\n')
}

/**
 * The directory one installed package lives in.
 *
 * Its own `package.json` is the shortest way in; a package that hides it behind an
 * `exports` map is found through its entry file instead. Resolution starts inside
 * the bundle's dependency tree as well as this project's, because pnpm keeps a
 * transitive dependency out of the root `node_modules`.
 *
 * @param name - package name.
 * @returns the absolute package directory.
 * @throws {Error} when the package cannot be located at all.
 */
function packageDirectory(name: string): string {
  const roots = [require, createRequire(require.resolve('pdf-lib/package.json'))]
  for (const root of roots) {
    try {
      return dirname(root.resolve(`${name}/package.json`))
    } catch {
      // An `exports` map that hides package.json; the entry file still resolves.
      try {
        return dirname(root.resolve(name))
      } catch {
        // Not in this tree: try the next one.
      }
    }
  }
  throw new Error(`client bundle: cannot locate ${name} to carry its licence along`)
}

/**
 * Licence notices of the third-party code the chunk bundles.
 *
 * A package that ships no licence file fails the build: the notice has to travel
 * with the copy of its code, and a missing one is not something to discover after
 * publishing.
 *
 * @returns the banner text.
 */
function bundledLicenceBanner(): string {
  const blocks = BUNDLED_PACKAGES.map((name) => {
    const directory = packageDirectory(name)
    const file = readdirSync(directory).find(entry => (LICENCE_NAMES as readonly string[]).includes(entry))
    if (file === undefined) throw new Error(`client bundle: ${name} ships no licence file to carry along`)
    return `${name}\n\n${readFileSync(join(directory, file), 'utf8').trimEnd()}`
  })
  return blocks.join('\n\n')
}

/** Base64 of every CMap, standard font and wasm module, keyed by the option that reads it. */
function pdfAssets(): string {
  const root = pdfRoot()
  return JSON.stringify(Object.fromEntries(ASSET_KINDS.map(([kind, directory]) => [kind, Object.fromEntries(
    readdirSync(join(root, directory))
      .filter(name => !name.startsWith('LICENSE'))
      .sort()
      .map(name => [name, readFileSync(join(root, directory, name)).toString('base64')]),
  )])))
}

/** Answer the worker specifier with its source text, so the chunk owns the worker it starts. */
function pdfWorkerSource(): NonNullable<UserConfig['plugins']>[] {
  return [{
    name: 'dsh-annotator/pdf-worker-source',
    resolveId(source: string) {
      return source === WORKER_SPECIFIER ? WORKER_MODULE : null
    },
    load(id: string) {
      if (id !== WORKER_MODULE) return null
      const path = require.resolve('pdfjs-dist/build/pdf.worker.min.mjs')
      this.addWatchFile(path)
      return `export default ${JSON.stringify(readFileSync(path, 'utf8'))};`
    },
  }]
}

/** Escape one literal for a RegExp source. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/**
 * Route package-local chunks through the Client module loader's asynchronous
 * operation, and refuse a bundle whose chunks share code with the entry.
 *
 * Rolldown emits a chunk behind `Promise.resolve().then(() => require(…))`, which
 * the factory's `require` cannot resolve in a browser; the loader exposes
 * `require.async` for exactly this fetch. A chunk whose dependency graph carries
 * side effects — anything without `sideEffects: false`, which is most packages —
 * is *also* preloaded with a bare `require(…)` at the top of the entry, which no
 * browser factory can resolve either: that statement is removed for the same
 * reason. Either shape changing must fail the build rather than ship a chunk
 * nothing can load, so the entry is checked for leftovers.
 *
 * A chunk that shares a module with the entry is the other way this breaks: the
 * entry would `require` a sibling file statically, which the browser factory
 * cannot resolve either. The rule that keeps this from happening is that a chunk
 * imports nothing from the entry bundle; this check is what enforces it.
 */
function asyncChunkRequire(): NonNullable<UserConfig['plugins']>[] {
  return [{
    name: 'dsh-annotator/async-chunk-require',
    renderChunk(code: string, chunk: { readonly dynamicImports: readonly string[] }, outputOptions: { readonly format?: string }) {
      if (outputOptions.format !== 'cjs') return null
      let rewritten = code
      for (const dynamicImport of chunk.dynamicImports) {
        const fileName = dynamicImport.startsWith('./') ? dynamicImport.slice(2) : dynamicImport
        if (!CHUNK_FILE.test(fileName)) continue
        const literal = escapeLiteral(`./${fileName}`)
        const call = new RegExp(`Promise\\.resolve\\(\\)\\.then\\(\\(\\)\\s*=>\\s*require\\((['"])${literal}\\1\\)\\)`, 'gu')
        const matches = [...rewritten.matchAll(call)]
        if (matches.length === 0) {
          throw new Error(`client bundle: dynamic chunk ${JSON.stringify(fileName)} has no generated import expression`)
        }
        rewritten = rewritten.replace(call, `require.async(${JSON.stringify(`./${fileName}`)})`)
        // The eager preload: rolldown fetches a chunk's dependencies up front when
        // they look like they carry side effects, which leaves the entry holding a
        // synchronous `require` of it. A browser factory cannot resolve that, and the
        // chunk's own code runs when `require.async` fetches it, so the statement goes
        // — unless the alias it binds is used anywhere else, which would be a real
        // dependency on the eager load and must fail the build instead.
        const preload = new RegExp(`^const (require_[A-Za-z0-9_$]*) = require\\((['"])${literal}\\2\\);\\n`, 'gmu')
        for (const match of [...rewritten.matchAll(preload)]) {
          const alias = match[1] ?? ''
          const without = rewritten.replace(match[0], '')
          if (new RegExp(`\\b${escapeLiteral(alias)}\\b`, 'gu').test(without)) {
            throw new Error(`client bundle: chunk ${JSON.stringify(fileName)} is preloaded as ${alias}, which a browser factory cannot resolve`)
          }
          rewritten = without
        }
      }
      const leftover = /require\((['"])\.\/client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js\1\)/u.exec(rewritten)
      if (leftover !== null) {
        throw new Error(`client bundle: ${leftover[0]} would not resolve in the browser; only require.async loads a chunk`)
      }
      return rewritten === code ? null : rewritten
    },
    generateBundle(_options: unknown, bundle: Record<string, { readonly type: string; readonly fileName: string; readonly isEntry?: boolean; readonly isDynamicEntry?: boolean }>) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk' || output.isEntry === true || output.isDynamicEntry === true) continue
        throw new Error(
          `client bundle: ${output.fileName} is a shared chunk — a chunk must not share modules with the entry, `
          + 'because the browser factory can only fetch chunks it loads itself',
        )
      }
    },
  }]
}

export default defineConfig([
  {
    name: PACKAGE_NAME,
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      neverBundle: [/^node:/],
      alwaysBundle: () => false,
    },
  },
  {
    name: `${PACKAGE_NAME}/client`,
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    fixedExtension: false,
    dts: false,
    clean: false,
    sourcemap: false,
    deps: {
      neverBundle: (specifier: string) => CLIENT_EXTERNALS.includes(specifier),
      alwaysBundle: (specifier: string) => !CLIENT_EXTERNALS.includes(specifier),
      // The two options above decide what is bundled; the default hint about a
      // bundled declared dependency is noise here, since PDF.js is bundled by
      // design and the client bundle is its only consumer.
      onlyBundle: false,
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
      // One identifier, one literal: the asset map is megabytes of base64 and is
      // read only by the PDF chunk, which is where the reference lives.
      __DSH_ANNOTATOR_PDF_ASSETS__: pdfAssets(),
    },
    plugins: [...pdfWorkerSource(), ...asyncChunkRequire()],
    outputOptions: {
      entryFileNames: 'client.js',
      // A dynamic import's source basename becomes the published chunk name.
      chunkFileNames: 'client.[name].js',
      banner: (chunk) => {
        const registration = `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, `
          + `${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`
        return chunk.fileName === PDF_CHUNK ? `${licenceBanner()}\n${registration}` : registration
      },
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
