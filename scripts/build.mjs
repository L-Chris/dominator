import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const outDirName = process.env.VITE_OUT_DIR || 'dist'
const dist = resolve(root, outDirName)
const vite = resolve(root, 'node_modules', 'vite', 'bin', 'vite.js')

function run(command, args, options = {}) {
  console.log(`> ${command} ${args.join(' ')}`)
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: 'inherit',
    shell: false,
    ...options,
  })

  if (result.error) {
    console.error(result.error)
  }

  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
}

for (const entry of ['content', 'background', 'popup']) {
  run(process.execPath, [vite, 'build'], {
    env: { ...process.env, VITE_ENTRY: entry, VITE_OUT_DIR: outDirName },
  })
}

rmSync(resolve(dist, 'dominator.zip'), { force: true })

if (process.platform === 'win32') {
  const command = 'Compress-Archive -Path * -DestinationPath dominator.zip -Force'
  run('powershell.exe', ['-NoProfile', '-Command', command], { cwd: dist })
} else {
  run('zip', ['-qr', 'dominator.zip', '.'], { cwd: dist })
}
