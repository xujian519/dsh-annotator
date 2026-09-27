/**
 * Build faces for dsh-annotator.
 *
 * The Host half is an ordinary ESM Node library (`lib/index.js`) that the
 * profile's Loader imports.
 *
 * The Client half must match the DSH dynamic-client contract exactly: a single
 * CommonJS file at `lib/client.js` whose only side effect is
 * `window.__ModuleLoader__.load({ id, factory })`. The factory receives the
 * shell's module-table `require`, so React stays the shell's shared instance and
 * nothing else may be imported from DSH packages (types only).
 */
import { defineConfig } from 'tsdown'

const PACKAGE_NAME = 'dsh-annotator'

/** Module-table specifiers the shell shares; everything else is inlined. */
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime', 'react-dom', 'react-dom/client']

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
    },
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
      'import.meta.env': JSON.stringify({ MODE: 'production' }),
    },
    outputOptions: {
      entryFileNames: 'client.js',
      banner: (chunk) =>
        `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_NAME)}, `
        + `${chunk.isEntry ? '' : `chunk: ${JSON.stringify(chunk.fileName)}, `}factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
