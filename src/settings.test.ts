// Reads Orca's default agent from real settings files laid out as Orca writes them.
import { afterEach, assert, test } from 'orca/testing'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { activeProfileId, agentSetting, orcaDataDir, readDefaultAgent } from './settings'

const quiet = () => {}
const homes: string[] = []
afterEach(() => {
  for (const dir of homes.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const dataDir = (dir: string) => join(dir, 'Library', 'Application Support', 'orca')
const databaseFile = (dir: string) => join(dataDir(dir), 'profiles', 'local-default', 'profile-state.db')

/** A macOS-style home with Orca's data folder, an active profile and the given settings files. */
function home(files: { profile?: string; index?: boolean; settings?: object | null; legacy?: object }): string {
  const dir = mkdtempSync(join(tmpdir(), 'shortcut-launcher-'))
  homes.push(dir)
  const data = dataDir(dir)
  const profile = files.profile ?? 'local-default'
  const profileDir = join(data, 'profiles', profile)
  mkdirSync(profileDir, { recursive: true })
  if (files.index !== false) {
    writeFileSync(join(data, 'orca-profile-index.json'), JSON.stringify({ activeProfileId: profile, profiles: [{ id: profile }] }))
  }
  if (files.settings !== undefined) {
    const db = new DatabaseSync(join(profileDir, 'profile-state.db'))
    db.exec('CREATE TABLE profile_state_documents (domain TEXT PRIMARY KEY NOT NULL, payload TEXT NOT NULL)')
    if (files.settings) {
      db.prepare('INSERT INTO profile_state_documents VALUES (?, ?)').run('settings', JSON.stringify(files.settings))
    }
    db.close()
  }
  if (files.legacy) {
    writeFileSync(join(profileDir, 'orca-data.json'), JSON.stringify(files.legacy))
  }
  return dir
}

const agentFor = (dir: string) => readDefaultAgent(quiet, 'darwin', {}, dir)

test('Orca data lives in Electron user data on each platform', () => {
  assert.equal(orcaDataDir('darwin', {}, '/Users/a'), '/Users/a/Library/Application Support/orca')
  assert.equal(orcaDataDir('linux', {}, '/home/a'), '/home/a/.config/orca')
  assert.equal(orcaDataDir('linux', { XDG_CONFIG_HOME: '/xdg' }, '/home/a'), '/xdg/orca')
  assert.equal(orcaDataDir('win32', { APPDATA: 'C:\\Users\\a\\AppData\\Roaming' }, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\orca')
  assert.equal(orcaDataDir('win32', {}, 'C:\\Users\\a'), 'C:\\Users\\a\\AppData\\Roaming\\orca')
})

test('the active profile comes from the profile index, else the default profile', () => {
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] })), 'work')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: 'gone', profiles: [{ id: 'work' }] })), 'local-default')
  assert.equal(activeProfileId(JSON.stringify({ activeProfileId: '../x', profiles: [{ id: '../x' }] })), 'local-default')
  assert.equal(activeProfileId(null), 'local-default')
})

test('blank means no agent, unset means Claude', () => {
  assert.equal(agentSetting('codex'), 'codex')
  assert.equal(agentSetting('blank'), null)
  assert.equal(agentSetting(null), 'claude')
  assert.equal(agentSetting(''), 'claude')
})

test('the live settings database wins over the older settings file', async () => {
  assert.equal(await agentFor(home({ settings: { defaultTuiAgent: 'codex' }, legacy: { settings: { defaultTuiAgent: 'gemini' } } })), 'codex')
  assert.equal(await agentFor(home({ settings: { defaultTuiAgent: 'blank' } })), null)
})

test('the active profile is the one read, not always the default profile', async () => {
  assert.equal(await agentFor(home({ profile: 'work', settings: { defaultTuiAgent: 'opencode' } })), 'opencode')
})

test('without settings in the database, the older settings file is used, then Claude', async () => {
  assert.equal(await agentFor(home({ settings: null, legacy: { settings: { defaultTuiAgent: 'gemini' } } })), 'gemini')
  assert.equal(await agentFor(home({ legacy: { settings: { defaultTuiAgent: 'codex' } } })), 'codex')
  assert.equal(await agentFor(home({ index: false })), 'claude')
})

test('a damaged primary profile index recovers the active profile from its backup', async () => {
  const dir = home({ profile: 'work', settings: { defaultTuiAgent: 'codex' } })
  const index = join(dataDir(dir), 'orca-profile-index.json')
  writeFileSync(`${index}.bak`, JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] }))
  for (const invalid of ['{', 'null', '{}', JSON.stringify({ activeProfileId: '../work', profiles: [] })]) {
    writeFileSync(index, invalid)
    assert.equal(await agentFor(dir), 'codex')
  }
  rmSync(index)
  assert.equal(await agentFor(dir), 'codex')
})

test('a valid primary index takes precedence over its backup', async () => {
  const dir = home({ settings: { defaultTuiAgent: 'blank' } })
  writeFileSync(join(dataDir(dir), 'orca-profile-index.json.bak'), JSON.stringify({ activeProfileId: 'work', profiles: [{ id: 'work' }] }))
  assert.equal(await agentFor(dir), null)
})

test('installed plugins locate their host data even when worker environment paths are stripped', () => {
  const hash = 'a'.repeat(64)
  assert.equal(orcaDataDir('linux', {}, '/home/a', `/custom/orca/plugins/sarrazink.shortcut-launcher/${hash}/src/settings.ts`), '/custom/orca')
  assert.equal(orcaDataDir('win32', {}, 'C:\\Users\\a', `D:\\Orca\\plugins\\sarrazink.shortcut-launcher\\${hash}\\src\\settings.ts`), 'D:\\Orca')
  assert.equal(orcaDataDir('darwin', {}, '/Users/a', `/custom/orca/plugins/local.shortcut-launcher/${'b'.repeat(32)}/src/settings.ts`), '/custom/orca')
  assert.equal(orcaDataDir('linux', {}, '/home/a', '/code/plugins/shortcut-launcher/src/settings.ts'), '/home/a/.config/orca')
})

test('the database stays authoritative when its agent setting is unset', async () => {
  assert.equal(await agentFor(home({ settings: {}, legacy: { settings: { defaultTuiAgent: 'codex' } } })), 'claude')
})

test('reads committed WAL settings while the host keeps a write transaction open', async () => {
  const dir = home({ settings: { defaultTuiAgent: 'codex' } })
  const writer = new DatabaseSync(databaseFile(dir))
  try {
    writer.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0')
    const update = writer.prepare("UPDATE profile_state_documents SET payload = ? WHERE domain = 'settings'")
    update.run(JSON.stringify({ defaultTuiAgent: 'opencode' }))
    writer.exec('BEGIN IMMEDIATE')
    update.run(JSON.stringify({ defaultTuiAgent: 'gemini' }))
    assert.equal(await agentFor(dir), 'opencode')
    writer.exec('COMMIT')
    assert.equal(await agentFor(dir), 'gemini')
  } finally {
    writer.close()
  }
})

test('missing databases are not created and corrupt settings fall back without rejecting', async () => {
  const dir = home({ legacy: { settings: { defaultTuiAgent: 'blank' } } })
  assert.equal(await agentFor(dir), null)
  assert.equal(existsSync(databaseFile(dir)), false)
  writeFileSync(databaseFile(dir), 'not sqlite')
  assert.equal(await agentFor(dir), null)
  writeFileSync(join(dataDir(dir), 'profiles', 'local-default', 'orca-data.json'), '{')
  assert.equal(await agentFor(dir), 'claude')
})

test('malformed database payload falls back to the legacy setting', async () => {
  const dir = home({ settings: {}, legacy: { settings: { defaultTuiAgent: 'gemini' } } })
  const db = new DatabaseSync(databaseFile(dir))
  try {
    for (const payload of ['{', 'null']) {
      db.prepare('UPDATE profile_state_documents SET payload = ?').run(payload)
      assert.equal(await agentFor(dir), 'gemini')
    }
  } finally {
    db.close()
  }
})
