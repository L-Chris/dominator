import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

function stripExports(): Plugin {
  return {
    name: 'strip-exports',
    renderChunk(code) {
      return code.replace(/^export\s*\{\s*\};?\s*$/gm, '')
    },
  }
}

const alias = { '@': resolve(import.meta.dirname, 'src') }
const entry = process.env.VITE_ENTRY || 'content'
const isDevReload = process.env.VITE_EXTENSION_DEV_RELOAD === 'true'
const outDir = process.env.VITE_OUT_DIR || (isDevReload ? 'dist-dev' : 'dist')
const emptyDir = entry === 'content' && !isDevReload

export default defineConfig(() => {
  if (entry === 'sidepanel') {
    return {
      base: '',
      plugins: [react()],
      build: {
        outDir,
        emptyOutDir: false,
        sourcemap: false,
        rollupOptions: {
          input: { [entry]: resolve(import.meta.dirname, `${entry}.html`) },
          output: {
            entryFileNames: '[name].js',
            chunkFileNames: '[name].js',
          },
        },
      },
      resolve: { alias },
    }
  }

  return {
    plugins: [react(), stripExports()],
    build: {
      outDir,
      emptyOutDir: emptyDir,
      sourcemap: false,
      rollupOptions: {
        input: { [entry]: resolve(import.meta.dirname, `src/${entry}/index.${entry === 'background' ? 'ts' : 'tsx'}`) },
        output: {
          entryFileNames: '[name].js',
          codeSplitting: false,
        },
      },
    },
    resolve: { alias },
  }
})
