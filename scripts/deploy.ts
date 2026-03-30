import { readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { spawn } from 'node:child_process'

const ROOT_DIR = resolve(import.meta.dir, '..')
const CONFIG_DEST = join(ROOT_DIR, 'src', 'config.json')

function parseArgs(args: string[]): { configDir: string | null } {
  const idx = args.indexOf('--config')
  if (idx === -1 || idx + 1 >= args.length) return { configDir: null }
  return { configDir: resolve(args[idx + 1]!) }
}

function run(cmd: string, args: string[], cwd: string, env?: Record<string, string>): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, ...env } })
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} exited with code ${code}`))
    })
  })
}

function loadEnvFile(configDir: string): Record<string, string> {
  const vars: Record<string, string> = {}
  // Check config dir and its parent for .env
  for (const dir of [configDir, dirname(configDir)]) {
    const envPath = join(dir, '.env')
    if (!existsSync(envPath)) continue
    const content = require('fs').readFileSync(envPath, 'utf-8')
    for (const line of content.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith('#')) continue
      const eq = trimmed.indexOf('=')
      if (eq === -1) continue
      vars[trimmed.slice(0, eq)] = trimmed.slice(eq + 1)
    }
  }
  return vars
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

  // Load .env from config dir or its parent
  const envVars = loadEnvFile(configDir)

  // Save original config.json for restore
  const originalConfig = await readFile(CONFIG_DEST, 'utf-8')

  try {
    // Copy external config into src/
    const config = await readFile(externalConfig, 'utf-8')
    await writeFile(CONFIG_DEST, config)
    console.log('Copied config.json → src/config.json')

    // Deploy — pass entry point as positional arg so wrangler resolves it
    // relative to cwd (ROOT_DIR) rather than the external config file location
    await run('npx', ['wrangler', 'deploy', 'src/index.ts', '--minify', '--config', wranglerConfig], ROOT_DIR, envVars)
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
