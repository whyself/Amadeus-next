import { build } from 'esbuild'
import { writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client.tsx'],
  write: false,
  loader: { '.png': 'dataurl' },
  bundle: true,
  platform: 'browser',
  format: 'cjs',
  target: 'es2022',
  external: ['react', 'react-dom', 'react/jsx-runtime', '@deepseek-ai/*'],
  define: { 'process.env.NODE_ENV': '"production"' },
})
const output = result.outputFiles[0]
if (!output) throw new Error('Editor client bundle was not generated')
await writeFile('lib/client.js', `window.__ModuleLoader__.load({id:"@amadeus-dsh/editor",factory:(require)=>{const module={exports:{}};const exports=module.exports;\n${output.text}\nreturn module.exports;}});\n`)
