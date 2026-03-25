import { readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT_DIR = resolve(import.meta.dir, '..')
const CONFIG_DEST = join(ROOT_DIR, 'src', 'config.json')

function parseArgs(args: string[]): { configDir: string | null } {
  const idx = args.indexOf('--config')
  if (idx === -1 || idx + 1 >= args.length) return { configDir: null }
  return { configDir: resolve(args[idx + 1]!) }
}

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit' })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

async function main() {
  const { configDir } = parseArgs(process.argv.slice(2))

  if (!configDir) {
    console.log('Deploying with in-tree config...')
    await run('npx', ['wrangler', 'deploy', '--minify'], ROOT_DIR)
    return
  }

  console.log(`Deploying with external config: ${configDir}`)

  const wranglerConfig = join(configDir, 'wrangler.jsonc')
  const externalConfig = join(configDir, 'config.json')

  // Save original config.json for restore
  const originalConfig = await readFile(CONFIG_DEST, 'utf-8')

  try {
    // Copy external config into src/
    const config = await readFile(externalConfig, 'utf-8')
    await writeFile(CONFIG_DEST, config)
    console.log('Copied config.json → src/config.json')

    // Deploy — pass entry point as positional arg so wrangler resolves it
    // relative to cwd (ROOT_DIR) rather than the external config file location
    await run('npx', ['wrangler', 'deploy', 'src/index.ts', '--minify', '--config', wranglerConfig], ROOT_DIR)
    console.log('Deploy complete.')
  } finally {
    // Restore original
    await writeFile(CONFIG_DEST, originalConfig)
    console.log('Restored src/config.json')
  }
}

main().catch((err) => {
  console.error(err.message)
  process.exit(1)
})
