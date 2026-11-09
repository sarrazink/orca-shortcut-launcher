// Orca's default agent for new workspaces. Plugins have no host method for Orca's settings, so the
// worker reads them, read-only, where Orca keeps them: the active profile's `profile-state.db`, with
// the older `orca-data.json` as a fallback. Anything unreadable means Claude, so Start still works.
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const FALLBACK_AGENT = 'claude'
const DEFAULT_PROFILE = 'local-default'
const SETTINGS_QUERY = "SELECT payload FROM profile_state_documents WHERE domain = 'settings'"

type Env = Record<string, string | undefined>
type SqliteModule = {
  DatabaseSync: new (path: string, options: { readOnly: boolean }) => {
    prepare(sql: string): { get(): unknown }
    close(): void
  }
}

const pathsFor = (platform: string) => (platform === 'win32' ? win32 : posix)

/** Installed workers live under userData/plugins/<key>/<hash>/src; dev folders use platform defaults. */
export function orcaDataDir(platform: string, env: Env, home: string, moduleFile?: string): string {
  const path = pathsFor(platform)
  if (moduleFile && path.isAbsolute(moduleFile)) {
    const versionDir = path.dirname(path.dirname(moduleFile))
    const pluginDir = path.dirname(versionDir)
    const pluginsDir = path.dirname(pluginDir)
    // The host strips APPDATA and XDG_CONFIG_HOME from workers, so prefer the install location.
    if (path.basename(pluginsDir) === 'plugins' && path.basename(pluginDir).endsWith('.shortcut-launcher') &&
        /^(?:[0-9a-f]{32}|[0-9a-f]{64})$/.test(path.basename(versionDir))) {
      return path.dirname(pluginsDir)
    }
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'orca')
  }
  if (platform === 'win32') {
    return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'orca')
  }
  return path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'orca')
}

/** The active profile from `orca-profile-index.json`, or Orca's default profile. */
export function activeProfileId(indexJson: string | null, backupJson: string | null = null): string {
  for (const json of [indexJson, backupJson]) {
    try {
      const index = JSON.parse(json ?? '') as { activeProfileId?: unknown; profiles?: { id?: unknown }[] }
      const id = index.activeProfileId
      if (typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(id) && index.profiles?.some((p) => p?.id === id)) {
        return id
      }
    } catch {
      // A torn primary can still have a valid recovery index.
    }
  }
  return DEFAULT_PROFILE
}

/** `defaultTuiAgent` as Start uses it: `blank` means no agent, unset means Claude. */
export function agentSetting(value: unknown): string | null {
  if (value === 'blank') {
    return null
  }
  return typeof value === 'string' && value ? value : FALLBACK_AGENT
}

async function readText(file: string): Promise<string | null> {
  try {
    return await readFile(file, 'utf8')
  } catch {
    return null
  }
}

/** `defaultTuiAgent` from the profile's settings database, or undefined when it cannot be read. */
async function fromProfileState(file: string): Promise<{ value: unknown } | undefined> {
  const { DatabaseSync } = (await import('node:sqlite' as string)) as SqliteModule
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const row = db.prepare(SETTINGS_QUERY).get() as { payload?: unknown } | undefined
    if (typeof row?.payload !== 'string') {
      return undefined
    }
    return { value: (JSON.parse(row.payload) as { defaultTuiAgent?: unknown }).defaultTuiAgent }
  } finally {
    db.close()
  }
}

/** The agent Start launches, following Orca's default agent setting on every platform. */
export async function readDefaultAgent(
  log: (message: string) => void,
  platform: string = process.platform,
  env: Env = process.env,
  home: string = homedir()
): Promise<string | null> {
  const path = pathsFor(platform)
  const dataDir = orcaDataDir(platform, env, home, fileURLToPath(import.meta.url))
  const index = path.join(dataDir, 'orca-profile-index.json')
  const profileDir = path.join(dataDir, 'profiles', activeProfileId(await readText(index), await readText(`${index}.bak`)))
  try {
    const setting = await fromProfileState(path.join(profileDir, 'profile-state.db'))
    if (setting) {
      return agentSetting(setting.value)
    }
  } catch (error) {
    log(`could not read Orca settings: ${(error as Error).message}`)
  }
  const legacy = await readText(path.join(profileDir, 'orca-data.json'))
  if (legacy === null) {
    log('could not read Orca settings, so Start uses Claude')
    return FALLBACK_AGENT
  }
  try {
    return agentSetting((JSON.parse(legacy) as { settings?: { defaultTuiAgent?: unknown } }).settings?.defaultTuiAgent)
  } catch {
    log('could not read Orca settings, so Start uses Claude')
    return FALLBACK_AGENT
  }
}
