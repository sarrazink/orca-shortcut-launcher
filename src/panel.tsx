// The Shortcut Launcher panel: the stories a saved search finds for the focused workspace's
// project, each with Start, plus the search and prompt template of that project. No build step:
// Orca strips the types and compiles the JSX when it loads. Edits save to the plugin's storage
// after a pause, where the worker reads them.
// Adapted from rr235/orca-task-launcher (MIT).
import {
  atom,
  Badge,
  Checkbox,
  Box,
  Button,
  Code,
  Collapsible,
  EmptyState,
  Field,
  Grid,
  IconButton,
  Input,
  Link,
  Markdown,
  on,
  plugin,
  read,
  Row,
  Select,
  Separator,
  set,
  Spinner,
  Stack,
  storage,
  Text,
  Textarea,
  update,
  type PanelContext
} from 'orca'
import { agentLabel, prefFor, readPrefs, startStateFor } from './board'
import {
  PREFS_KEY,
  type Board,
  type Prefs,
  type ProjectRef,
  type SortKey,
  type StartState,
  type Story,
  type StoryDetail,
  type StoryOptions,
  type StoryPatch
} from './protocol'

const SAVE_DELAY_MS = 600
const ANY = '*any'

type ReadyBoard = Extract<Board, { kind: 'ready' }>
type Filters = { state: string; type: string; label: string }
type Sections = { search: boolean; template: boolean; start?: boolean; filter: boolean }

const NO_FILTERS: Filters = { state: ANY, type: ANY, label: ANY }

// The last board of each project, kept across panel runs: reopening shows the project's own list
// at once while a fresh one loads, never another project's.
const cache = atom<Record<string, ReadyBoard>>('boards', {}, { persist: 'plugin', version: 1, migrate: () => ({}) })
const filters = atom<Filters>('filters', NO_FILTERS, { persist: 'plugin', version: 1, migrate: () => NO_FILTERS })
const sections = atom<Sections>('sections', { search: false, template: false, filter: false }, { persist: 'plugin' })
const board = atom<Board | null>(null)
const boardError = atom<string | null>(null)
const loading = atom(false)
const prefs = atom<Prefs | null>(null)
const tokenDraft = atom('')
const tokenError = atom<string | null>(null)
const tokenBusy = atom(false)
const starting = atom<Record<string, boolean>>({})
const startErrors = atom<Record<string, string>>({})
/** What a Start did besides the worktree, by start key: the branch it took up, a state move that failed. */
const startNotes = atom<Record<string, { text: string; warning: boolean }>>({})
const sortBy = atom<SortKey>('sort', 'shortcut', { persist: 'plugin' })
const commentDrafts = atom<Record<number, string>>({})
const commenting = atom<Record<number, boolean>>({})
const commentErrors = atom<Record<number, string>>({})
const taskBusy = atom<Record<number, boolean>>({})
// Opened cards and their fetched details, by story id; details live for the panel run only.
const expanded = atom<Record<number, boolean>>({})
const details = atom<Record<number, StoryDetail>>({})
const detailErrors = atom<Record<number, string>>({})
const pickerLists = atom<StoryOptions | null>(null)
const optionsError = atom<string | null>(null)
const moving = atom<Record<number, boolean>>({})
const moveErrors = atom<Record<number, string>>({})
const startKey = (project: ProjectRef, story: Story): string => `${project.id}#${story.id}`

let saveTimer: ReturnType<typeof setTimeout> | null = null
let loadSeq = 0
let saving: Promise<void> = Promise.resolve()
let pendingSaves = 0

async function loadBoard(): Promise<void> {
  const seq = ++loadSeq
  let project: ProjectRef | null = null
  set(loading, true)
  try {
    project = await plugin.request('project.active', undefined, { timeoutMs: 15000 })
    if (seq !== loadSeq) {
      return
    }
    if (!project) {
      set(board, { kind: 'no-project' })
      set(boardError, null)
      return
    }
    const shown = read(board)
    if (shown?.kind !== 'ready' || shown.project.id !== project.id) {
      set(board, read(cache)[project.id] ?? null)
    }
    const next = await plugin.request('board.load', { projectId: project.id }, { timeoutMs: 60000 })
    if (seq !== loadSeq) {
      return
    }
    if (next.kind === 'error') {
      set(boardError, next.message)
      return
    }
    set(board, next)
    set(boardError, null)
    if (next.kind === 'ready') {
      update(cache, (all) => ({ ...all, [next.project.id]: next }))
    }
  } catch {
    if (seq === loadSeq) {
      if (!project) {
        set(board, null)
      }
      set(boardError, 'Could not load the stories.')
    }
  } finally {
    if (seq === loadSeq) {
      set(loading, false)
    }
  }
}

async function loadPrefs(): Promise<void> {
  if (pendingSaves) {
    return
  }
  const before = read(prefs)
  const stored = await storage.get(PREFS_KEY)
  if (!pendingSaves && !saveTimer && read(prefs) === before) {
    set(prefs, readPrefs(stored))
  }
}

export function setup(ctx: PanelContext): () => void {
  ctx.subscriptions.push(
    on('workspace.changed', () => void loadBoard()),
    storage.onDidChange(({ key }) => {
      if (key === PREFS_KEY) {
        void loadPrefs()
      }
    })
  )
  void loadPrefs()
  void loadBoard()
  return () => {
    ++loadSeq
    if (saveTimer) {
      void savePrefs().catch(() => {})
    }
  }
}

const CHARS_PER_ROW = 48
const rowsFor = (text: string, min: number): number =>
  Math.min(24, Math.max(min, text.split('\n').reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / CHARS_PER_ROW)), 0) + 1))

/** What the project's field shows: its own value when set, else the default it inherits. */
const shownPref = (all: Prefs, project: ProjectRef, key: 'query' | 'template'): string =>
  all.projects[project.id]?.[key] ?? prefFor(all, project.id, key)

function editPref(project: ProjectRef, key: 'query' | 'template', value: string, reload: boolean): void {
  update(prefs, (all) =>
    all ? { ...all, projects: { ...all.projects, [project.id]: { ...all.projects[project.id], [key]: value } } } : all
  )
  if (saveTimer) {
    clearTimeout(saveTimer)
  }
  saveTimer = setTimeout(() => {
    void savePrefs()
      .then(() => (reload ? loadBoard() : undefined))
      .catch(() => set(boardError, 'Could not save the settings.'))
  }, SAVE_DELAY_MS)
}

/** Drops the project's own value, so it follows the default again. */
function resetPref(project: ProjectRef, key: 'query' | 'template'): void {
  update(prefs, (all) => {
    if (!all) {
      return all
    }
    const { [key]: _, ...rest } = all.projects[project.id] ?? {}
    return { ...all, projects: { ...all.projects, [project.id]: rest } }
  })
  void savePrefs().then(() => (key === 'query' ? loadBoard() : undefined))
}

async function savePrefs(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const next = read(prefs)
  if (next) {
    ++pendingSaves
    saving = saving.catch(() => {}).then(() => storage.set(PREFS_KEY, next))
    try {
      await saving
    } finally {
      --pendingSaves
    }
  }
}

async function saveToken(): Promise<void> {
  set(tokenBusy, true)
  set(tokenError, null)
  try {
    const result = await plugin.request('token.set', { token: read(tokenDraft) }, { timeoutMs: 30000 })
    if (result.ok) {
      set(tokenDraft, '')
      await loadBoard()
    } else {
      set(tokenError, result.message)
    }
  } catch {
    set(tokenError, 'Could not check the token.')
  } finally {
    set(tokenBusy, false)
  }
}

async function forgetToken(): Promise<void> {
  await plugin.request('token.clear')
  update(cache, () => ({}))
  await loadBoard()
}

const movedOnStart = new Map<number, Pick<Story, 'stateId' | 'state' | 'stateType'>>()

async function start(project: ProjectRef, story: Story): Promise<void> {
  const key = startKey(project, story)
  if (read(starting)[key]) {
    return
  }
  update(starting, (s) => ({ ...s, [key]: true }))
  update(startErrors, ({ [key]: _, ...rest }) => rest)
  update(startNotes, ({ [key]: _, ...rest }) => rest)
  let failed = false
  try {
    await savePrefs()
    const result = await plugin.request('story.start', { projectId: project.id, story }, { timeoutMs: 120000 })
    const note = result.warning
      ? { text: result.warning, warning: true }
      : result.reused
        ? { text: `On the existing branch ${result.reused}.`, warning: false }
        : null
    if (note) {
      update(startNotes, (n) => ({ ...n, [key]: note }))
    }
    if (result.moved) {
      const { id, name, type } = result.moved
      // Shortcut's search lags a few seconds: the reload below could still show the old state.
      update(cache, (all) => {
        const b = all[project.id]
        return b ? { ...all, [project.id]: { ...b, stories: b.stories.map((s) => (s.id === story.id ? { ...s, stateId: id, state: name, stateType: type } : s)) } } : all
      })
      movedOnStart.set(story.id, { stateId: id, state: name, stateType: type })
    }
  } catch {
    failed = true
  }
  // A create that timed out here can still finish in Orca, so the board decides what happened:
  // pressing Start again would make a second worktree.
  await loadBoard()
  const moved = movedOnStart.get(story.id)
  if (moved) {
    const patch = (b: ReadyBoard): ReadyBoard => ({
      ...b,
      stories: b.stories.map((s) => (s.id === story.id && s.stateType === 'unstarted' ? { ...s, ...moved } : s))
    })
    update(board, (b) => (b?.kind === 'ready' ? patch(b) : b))
    update(cache, (all) => (all[project.id] ? { ...all, [project.id]: patch(all[project.id]) } : all))
    movedOnStart.delete(story.id)
  }
  const current = read(board)
  const landed = current?.kind === 'ready' && current.project.id === project.id && Boolean(current.sessions[story.id])
  if (failed && !landed) {
    update(startErrors, (e) => ({ ...e, [key]: 'Could not confirm this start. Check Orca worktrees before retrying.' }))
  }
  update(starting, ({ [key]: _, ...rest }) => rest)
}

const without = <T,>(all: Record<number, T>, id: number): Record<number, T> => {
  const { [id]: _, ...rest } = all
  return rest
}
const messageOf = (error: unknown, fallback: string): string => (error as Error)?.message || fallback

async function loadDetail(story: Story): Promise<void> {
  update(detailErrors, (all) => without(all, story.id))
  try {
    const detail = await plugin.request('story.detail', { storyId: story.id }, { timeoutMs: 30000 })
    update(details, (all) => ({ ...all, [story.id]: detail }))
  } catch (error) {
    update(detailErrors, (all) => ({ ...all, [story.id]: messageOf(error, 'Could not load the story.') }))
  }
}

async function loadOptions(): Promise<void> {
  set(optionsError, null)
  try {
    set(pickerLists, await plugin.request('story.options', undefined, { timeoutMs: 30000 }))
  } catch (error) {
    set(optionsError, messageOf(error, 'Could not load epics, iterations and members.'))
  }
}

function toggleDetail(story: Story, open: boolean): void {
  update(expanded, (all) => ({ ...all, [story.id]: open }))
  if (open && !read(details)[story.id]) {
    void loadDetail(story)
  }
  // The worker caches the lists for a few minutes; asking on each open keeps a new sprint or epic in reach.
  if (open) {
    void loadOptions()
  }
}

/**
 * Saves a change in Shortcut, then shows it at once: search results lag a few seconds. A type
 * change reloads instead, since Shortcut then formats another branch name.
 */
async function changeStory(ready: ReadyBoard, story: Story, patch: StoryPatch, fields: Partial<Story>): Promise<void> {
  if (read(moving)[story.id]) {
    return
  }
  update(moving, (all) => ({ ...all, [story.id]: true }))
  update(moveErrors, (all) => without(all, story.id))
  try {
    await plugin.request('story.update', { storyId: story.id, patch }, { timeoutMs: 30000 })
    const apply = (b: ReadyBoard): ReadyBoard => ({
      ...b,
      stories: b.stories.map((s) => (s.id === story.id ? { ...s, ...fields } : s))
    })
    update(board, (b) => (b?.kind === 'ready' && b.project.id === ready.project.id ? apply(b) : b))
    update(cache, (all) => (all[ready.project.id] ? { ...all, [ready.project.id]: apply(all[ready.project.id]) } : all))
    if (patch.type !== undefined) {
      void loadBoard()
    }
  } catch (error) {
    update(moveErrors, (all) => ({ ...all, [story.id]: messageOf(error, 'Shortcut did not save the change.') }))
  } finally {
    update(moving, (all) => without(all, story.id))
  }
}

const NONE = 'none'
const idOrNull = (value: string): number | null => (value === NONE ? null : Number(value))

function moveStory(ready: ReadyBoard, story: Story, value: string): void {
  const stateId = Number(value)
  const target = (story.workflowId === null ? [] : ready.workflowStates[story.workflowId] ?? []).find((s) => s.id === stateId)
  if (target && stateId !== story.stateId) {
    void changeStory(ready, story, { stateId }, { state: target.name, stateType: target.type, stateId })
  }
}

function estimateStory(ready: ReadyBoard, story: Story, value: string): void {
  const estimate = idOrNull(value)
  if (estimate !== story.estimate && (estimate === null || Number.isFinite(estimate))) {
    void changeStory(ready, story, { estimate }, { estimate })
  }
}

const TYPES = ['feature', 'bug', 'chore'] as const

/** The workspace scale, plus the story's own estimate when it is off the scale. */
function estimateOptions(scale: number[], current: number | null): Option[] {
  const values = current === null || scale.includes(current) ? scale : [...scale, current].sort((a, b) => a - b)
  return [{ value: NONE, label: 'No estimate' }, ...values.map((n) => ({ value: String(n), label: n === 1 ? '1 point' : `${n} points` }))]
}

/** `list` as options, keeping `current` selectable when it is not in the list (a done epic, say). */
function withCurrent<T extends string | number>(list: { value: T; label: string }[], current: T | null, unknown: (v: T) => string): Option[] {
  const all = list.map((o) => ({ value: String(o.value), label: o.label }))
  return current === null || all.some((o) => o.value === String(current)) ? all : [...all, { value: String(current), label: unknown(current) }]
}

/** Who can be added as owner: active members not already owners, you first. */
function ownerCandidates(members: StoryOptions['members'], story: Story, viewerId: string): Option[] {
  const free = members.filter((m) => !story.ownerIds.includes(m.id))
  const ordered = [...free.filter((m) => m.id === viewerId), ...free.filter((m) => m.id !== viewerId)]
  return ordered.map((m) => ({ value: m.id, label: m.id === viewerId ? `@${m.mention} (you)` : `@${m.mention}` }))
}

const PRIORITY_TONES: Record<string, 'danger' | 'warning'> = { highest: 'danger', high: 'warning' }

/** Only the urgent priorities earn a badge on the card: the rest would be noise when scanning. */
function priorityBadge(ready: ReadyBoard, story: Story) {
  const name = ready.priority?.values.find((p) => p.id === story.priorityId)?.name
  const tone = name ? PRIORITY_TONES[name.toLowerCase()] : undefined
  return name && tone ? <Badge tone={tone}>{name}</Badge> : null
}

async function toggleTask(story: Story, taskId: number, complete: boolean): Promise<void> {
  const setTask = (value: boolean) =>
    update(details, (all) =>
      all[story.id] ? { ...all, [story.id]: { ...all[story.id], tasks: all[story.id].tasks.map((t) => (t.id === taskId ? { ...t, complete: value } : t)) } } : all
    )
  update(taskBusy, (all) => ({ ...all, [taskId]: true }))
  setTask(complete)
  try {
    await plugin.request('story.task', { storyId: story.id, taskId, complete }, { timeoutMs: 30000 })
  } catch (error) {
    setTask(!complete)
    update(detailErrors, (all) => ({ ...all, [story.id]: messageOf(error, 'Could not update the task.') }))
  } finally {
    update(taskBusy, (all) => without(all, taskId))
  }
}

async function sendComment(story: Story): Promise<void> {
  const text = (read(commentDrafts)[story.id] ?? '').trim()
  if (!text || read(commenting)[story.id]) {
    return
  }
  update(commenting, (all) => ({ ...all, [story.id]: true }))
  update(commentErrors, (all) => without(all, story.id))
  try {
    const comment = await plugin.request('story.comment', { storyId: story.id, text }, { timeoutMs: 30000 })
    update(details, (all) => (all[story.id] ? { ...all, [story.id]: { ...all[story.id], comments: [...all[story.id].comments, comment] } } : all))
    update(commentDrafts, (all) => without(all, story.id))
  } catch (error) {
    update(commentErrors, (all) => ({ ...all, [story.id]: messageOf(error, 'Could not post the comment.') }))
  } finally {
    update(commenting, (all) => without(all, story.id))
  }
}

function setStartState(project: ProjectRef, value: StartState): void {
  update(prefs, (all) => (all ? { ...all, projects: { ...all.projects, [project.id]: { ...all.projects[project.id], startState: value } } } : all))
  void savePrefs().catch(() => set(boardError, 'Could not save the settings.'))
}

const startLabel = (choice: StartState): string =>
  choice === 'none' ? "Don't move the story" : choice === 'first-started' ? 'First started state' : choice.slice(1)

const startSummary = (all: Prefs, project: ProjectRef, _ready: ReadyBoard): string => {
  const choice = startStateFor(all, project.id)
  return choice === 'none' ? 'Leaves the story where it is' : `Moves a story not started to ${startLabel(choice).replace('First started state', 'its first started state')}`
}

function StartControls({ all, project, current }: { all: Prefs; project: ProjectRef; current: ReadyBoard }) {
  const choice = startStateFor(all, project.id)
  const names = [...new Set(Object.values(current.workflowStates).flatMap((states) => states.filter((s) => s.type === 'started').map((s) => s.name)))]
  const values: StartState[] = ['first-started', ...names.map((n): StartState => `=${n}`), 'none']
  const options = (values.includes(choice) ? values : [...values, choice]).map((v) => ({ value: v, label: startLabel(v) }))
  return (
    <Stack gap="xs">
      <Select
        label="Move the story to"
        value={choice}
        onChange={(v) => {
          const next = values.find((x) => x === v)
          if (next) {
            setStartState(project, next)
          }
        }}
        options={options}
      />
      <Text size="sm" muted>
        Only a story not started yet moves. Start also takes up the story's branch when one exists, in this clone or on the remote.
      </Text>
    </Stack>
  )
}

function openWorktree(worktreeId: string): void {
  void plugin.request('worktree.open', { worktreeId }).catch(() => set(boardError, 'Could not open the worktree.'))
}

const TYPE_TONES: Record<string, 'accent' | 'danger' | 'neutral'> = { feature: 'accent', bug: 'danger', chore: 'neutral' }

function matches(story: Story, f: Filters): boolean {
  return (
    (f.state === ANY || story.state === f.state.slice(1)) &&
    (f.type === ANY || story.type === f.type.slice(1)) &&
    (f.label === ANY || story.labels.includes(f.label.slice(1)))
  )
}

type Option = { value: string; label: string }

/** The values present in the list as options, in `order` when given, plus the current value. */
function options(first: Option, values: (string | null)[], current: string, order?: string[]): Option[] {
  const present = [...new Set(values.filter((v): v is string => Boolean(v)))]
  const sorted = order ? order.filter((v) => present.includes(v)).concat(present.filter((v) => !order.includes(v))) : present.sort()
  const all = [first, ...sorted.map((v) => ({ value: `=${v}`, label: v }))]
  return all.some((o) => o.value === current) ? all : [...all, { value: current, label: current.slice(1) }]
}

/**
 * Story Markdown as the panel shows it: headings as bold lines (at panel width a story's `# Context`
 * would be the loudest thing on screen) and long links shortened. Fenced code is left alone.
 */
export function forPanel(markdown: string): string {
  let fenced = false
  return markdown
    .split('\n')
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced) {
        return line
      }
      const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
      return shortLinks(heading && heading[1] ? `**${heading[1]}**` : line)
    })
    .join('\n')
}

/** A path segment as words: `Acme-Billing-webhooks` → `Acme Billing webhooks`, cut at 40 characters. */
function titleOf(segment: string): string {
  let text = segment
  try {
    text = decodeURIComponent(segment)
  } catch {
    // Keep it encoded.
  }
  text = text.replace(/[-_]+/g, ' ').trim()
  return text.length > 40 ? `${text.slice(0, 39)}…` : text
}

/**
 * A short name for a URL, the way its host writes references: `api!838` for a GitLab merge
 * request, `repo#12` for an issue or pull request, `sc-123` for a Shortcut story, `Figma · File` or
 * `Notion · Page` from the name in the link, `Slack message`, else the host and the path's end.
 */
export function linkLabel(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  const parts = parsed.pathname.split('/').filter(Boolean)
  const dash = parts.indexOf('-')
  if (dash > 0 && parts[dash + 2]) {
    const kind = { merge_requests: '!', issues: '#' }[parts[dash + 1]]
    if (kind) {
      return `${parts[dash - 1]}${kind}${parts[dash + 2]}`
    }
  }
  if (parsed.hostname === 'github.com' && ['pull', 'issues'].includes(parts[2]) && parts[3]) {
    return `${parts[1]}#${parts[3]}`
  }
  const host = parsed.hostname.replace(/^www\./, '')
  // Figma: /design/<key>/<File-Name> (also file, proto, board for FigJam, slides, make).
  if (host === 'figma.com' && parts.length >= 2) {
    const name = parts[2] ? titleOf(parts[2]) : ''
    const app = parts[0] === 'board' ? 'FigJam' : 'Figma'
    return name ? `${app} · ${name}` : `${app} file`
  }
  // Notion: /<workspace>/<Page-Title-<32 hex id>>, or the id alone.
  if (host === 'notion.so' || host.endsWith('.notion.site')) {
    const page = parts[parts.length - 1] ?? ''
    const name = titleOf(page.replace(/-?[0-9a-f]{32}$/i, ''))
    return name ? `Notion · ${name}` : 'Notion page'
  }
  // Slack: /archives/<channel>[/p<ts>]; the link carries no channel name.
  if (host.endsWith('slack.com') && parts[0] === 'archives') {
    if (!parts[2]) {
      return 'Slack channel'
    }
    return parsed.searchParams.has('thread_ts') ? 'Slack thread' : 'Slack message'
  }
  const story = host.endsWith('shortcut.com') ? parts.indexOf('story') : -1
  if (story >= 0 && parts[story + 1]) {
    return `sc-${parts[story + 1]}`
  }
  const last = parts[parts.length - 1]
  return last ? `${host}/…/${last.length > 32 ? `${last.slice(0, 31)}…` : last}` : host
}

const BARE_URL = /(^|[\s(])(https?:\/\/[^\s<>()\]]+[^\s<>()\].,;:!?'"»])/g
const URL_AS_TEXT = /\[(https?:\/\/[^\]\s]+)\]\((https?:\/\/[^)\s]+)\)/g

/**
 * Bare URLs, and links whose text is their URL, get a short label: at panel width Orca draws a long
 * link as a wrapped, centered block. Code spans and fenced code are left alone.
 */
export function shortLinks(line: string): string {
  return line
    .split(/(`[^`]*`)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .replace(URL_AS_TEXT, (_m, text: string, href: string) => `[${text === href ? linkLabel(href) : text}](${href})`)
            .replace(BARE_URL, (m, before: string, url: string, offset: number, all: string) =>
              all.slice(Math.max(0, offset - 1), offset + before.length).endsWith('](') ? m : `${before}[${linkLabel(url)}](${url})`
            )
    )
    .join('')
}

const dateOf = (iso: string): string => (iso ? iso.slice(0, 10) : '')

/** The story's fields, in the order of Shortcut's own story sidebar. One save at a time per story. */
function StoryFields({ story, ready }: { story: Story; ready: ReadyBoard }) {
  const states = story.workflowId === null ? [] : ready.workflowStates[story.workflowId] ?? []
  const busy = Boolean(read(moving)[story.id])
  const lists = read(pickerLists)
  const listsError = read(optionsError)
  const mention = (id: string): string => `@${lists?.members.find((m) => m.id === id)?.mention ?? 'former member'}`
  const priority = ready.priority
  return (
    <Stack gap="sm">
      {states.length && story.stateId !== null ? (
        <Field label="State">
          <Select
            label={`State of sc-${story.id}`}
            labelHidden
            value={String(story.stateId)}
            disabled={busy}
            onChange={(v) => moveStory(ready, story, v)}
            options={states.map((s) => ({ value: String(s.id), label: s.name }))}
          />
        </Field>
      ) : null}
      <Grid columns={2} gap="sm">
        <Field label="Type">
          <Select
            label={`Type of sc-${story.id}`}
            labelHidden
            value={story.type}
            disabled={busy}
            onChange={(v) => {
              const type = TYPES.find((t) => t === v)
              if (type && type !== story.type) {
                void changeStory(ready, story, { type }, { type })
              }
            }}
            options={withCurrent(TYPES.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) })), story.type, (t) => String(t))}
          />
        </Field>
        {ready.estimateScale.length ? (
          <Field label="Estimate">
            <Select
              label={`Estimate of sc-${story.id}`}
              labelHidden
              value={story.estimate === null ? NONE : String(story.estimate)}
              disabled={busy}
              onChange={(v) => estimateStory(ready, story, v)}
              options={estimateOptions(ready.estimateScale, story.estimate)}
            />
          </Field>
        ) : null}
      </Grid>
      {priority ? (
        <Field label="Priority">
          <Select
            label={`Priority of sc-${story.id}`}
            labelHidden
            value={story.priorityId ?? NONE}
            disabled={busy}
            onChange={(v) => {
              const priorityId = v === NONE ? null : v
              if (priorityId !== story.priorityId) {
                void changeStory(ready, story, { priorityId }, { priorityId })
              }
            }}
            options={[
              { value: NONE, label: 'No priority' },
              ...withCurrent(priority.values.map((p) => ({ value: p.id, label: p.name })), story.priorityId, () => 'Disabled value')
            ]}
          />
        </Field>
      ) : null}
      {lists ? (
        <>
          <Field label="Epic">
            <Select
              label={`Epic of sc-${story.id}`}
              labelHidden
              value={story.epicId === null ? NONE : String(story.epicId)}
              disabled={busy}
              onChange={(v) => {
                const epicId = idOrNull(v)
                if (epicId !== story.epicId) {
                  void changeStory(ready, story, { epicId }, { epicId })
                }
              }}
              options={[
                { value: NONE, label: 'No epic' },
                ...withCurrent(lists.epics.map((e) => ({ value: e.id, label: e.name })), story.epicId, (id) => `Epic #${id} (done)`)
              ]}
            />
          </Field>
          <Field label="Iteration">
            <Select
              label={`Iteration of sc-${story.id}`}
              labelHidden
              value={story.iterationId === null ? NONE : String(story.iterationId)}
              disabled={busy}
              onChange={(v) => {
                const iterationId = idOrNull(v)
                if (iterationId !== story.iterationId) {
                  void changeStory(ready, story, { iterationId }, { iterationId })
                }
              }}
              options={[
                { value: NONE, label: 'No iteration' },
                ...withCurrent(
                  lists.iterations.filter((i) => !i.done || i.id === story.iterationId).map((i) => ({ value: i.id, label: i.done ? `${i.name} (done)` : i.name })),
                  story.iterationId,
                  (id) => `Iteration #${id}`
                )
              ]}
            />
          </Field>
          <Field label="Requester">
            <Select
              label={`Requester of sc-${story.id}`}
              labelHidden
              value={story.requesterId ?? ''}
              placeholder="Nobody"
              disabled={busy}
              onChange={(requesterId) => {
                if (requesterId && requesterId !== story.requesterId) {
                  void changeStory(ready, story, { requesterId }, { requesterId })
                }
              }}
              options={withCurrent(lists.members.map((m) => ({ value: m.id, label: `@${m.mention}` })), story.requesterId, mention)}
            />
          </Field>
        </>
      ) : null}
      {lists ? (
        <Field label="Owners">
          <Row gap="xs" align="center" wrap>
            {story.ownerIds.map((id) => (
              <Row gap="none" align="center">
                <Badge tone={id === ready.viewerId ? 'accent' : 'neutral'}>{mention(id)}</Badge>
                <IconButton
                  size="xs"
                  variant="ghost"
                  icon="close"
                  label={`Remove ${mention(id)} from sc-${story.id} owners`}
                  tooltip="Remove"
                  disabled={busy}
                  onPress={() => {
                    const ownerIds = story.ownerIds.filter((o) => o !== id)
                    void changeStory(ready, story, { ownerIds }, { ownerIds })
                  }}
                />
              </Row>
            ))}
            {ownerCandidates(lists.members, story, ready.viewerId).length ? (
              <Select
                label={`Add owner to sc-${story.id}`}
                labelHidden
                value=""
                placeholder={story.ownerIds.length ? 'Add owner…' : 'No owner. Add one…'}
                disabled={busy}
                onChange={(id) => {
                  if (id && !story.ownerIds.includes(id)) {
                    const ownerIds = [...story.ownerIds, id]
                    void changeStory(ready, story, { ownerIds }, { ownerIds })
                  }
                }}
                options={ownerCandidates(lists.members, story, ready.viewerId)}
              />
            ) : null}
          </Row>
        </Field>
      ) : listsError ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text size="sm" tone="danger">
            {listsError}
          </Text>
          <Button size="xs" variant="ghost" icon="refresh" onPress={loadOptions}>
            Try again
          </Button>
        </Row>
      ) : (
        <Spinner label="Loading epics, iterations and members" />
      )}
      {busy ? <Spinner label="Saving to Shortcut" /> : null}
    </Stack>
  )
}

function StoryDetails({ story, ready }: { story: Story; ready: ReadyBoard }) {
  const detail = read(details)[story.id]
  const error = read(detailErrors)[story.id]
  const moveError = read(moveErrors)[story.id]
  return (
    <Stack gap="md">
      <StoryFields story={story} ready={ready} />
      <Separator />
      {moveError ? (
        <Text size="sm" tone="danger">
          {moveError}
        </Text>
      ) : null}
      {error ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text size="sm" tone="danger">
            {error}
          </Text>
          <Button size="xs" variant="ghost" icon="refresh" onPress={() => loadDetail(story)}>
            Try again
          </Button>
        </Row>
      ) : !detail ? (
        <Spinner label="Loading the story" />
      ) : (
        <Stack gap="sm">
          {story.blocked && detail.blockers.length ? (
            <Row gap="xs" align="center" wrap>
              <Text size="sm" tone="danger">
                Blocked by
              </Text>
              {detail.blockers.map((b) => (
                <Text size="sm">
                  <Link href={b.url}>{`sc-${b.id}`}</Link>
                </Text>
              ))}
            </Row>
          ) : null}
          {detail.description.trim() ? (
            <Markdown content={forPanel(detail.description)} />
          ) : (
            <Text size="sm" muted>
              No description.
            </Text>
          )}
          {detail.tasks.length ? (
            <Stack gap="xs">
              <Text size="sm" weight="medium">
                {`Tasks ${detail.tasks.filter((t) => t.complete).length}/${detail.tasks.length}`}
              </Text>
              {detail.tasks.map((t) => (
                <Checkbox
                  label={t.description}
                  checked={t.complete}
                  disabled={Boolean(read(taskBusy)[t.id])}
                  onChange={(complete) => void toggleTask(story, t.id, complete)}
                />
              ))}
            </Stack>
          ) : null}
          {detail.comments.length ? (
            <Stack gap="xs">
              <Text size="sm" weight="medium">
                {detail.comments.length === 1 ? '1 comment' : `${detail.comments.length} comments`}
              </Text>
              {detail.comments.map((c) => (
                <Box border radius="sm" padding="xs">
                  <Stack gap="xs">
                    <Text size="xs" muted>
                      {`@${c.author} · ${dateOf(c.at)}`}
                    </Text>
                    <Markdown content={forPanel(c.text)} />
                  </Stack>
                </Box>
              ))}
            </Stack>
          ) : null}
          <CommentComposer story={story} />
        </Stack>
      )}
    </Stack>
  )
}

function CommentComposer({ story }: { story: Story }) {
  const draft = read(commentDrafts)[story.id] ?? ''
  const busy = Boolean(read(commenting)[story.id])
  const error = read(commentErrors)[story.id]
  return (
    <Stack gap="xs">
      <Textarea
        label={`Comment on sc-${story.id}`}
        labelHidden
        rows={2}
        placeholder="Write a comment… (Markdown)"
        value={draft}
        disabled={busy}
        onChange={(v) => update(commentDrafts, (all) => ({ ...all, [story.id]: v }))}
      />
      <Row gap="sm" align="center">
        <Button size="xs" variant="outline" disabled={busy || !draft.trim()} onPress={() => sendComment(story)}>
          Comment
        </Button>
        {busy ? <Spinner label="Posting the comment" labelHidden /> : null}
        {error ? (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        ) : null}
      </Row>
    </Stack>
  )
}

function StoryCard({ project, story, ready }: { project: ProjectRef; story: Story; ready: ReadyBoard }) {
  const session = ready.sessions[story.id]
  const busy = read(starting)[startKey(project, story)]
  const error = read(startErrors)[startKey(project, story)]
  const note = read(startNotes)[startKey(project, story)]
  return (
    <Box border radius="md" padding="sm">
      <Stack gap="xs">
        <Text size="sm">
          <Link href={story.url}>sc-{story.id}</Link> {story.name}
        </Text>
        <Row justify="between" align="center" gap="xs" wrap>
          <Row gap="xs" align="center" wrap>
            <Badge tone={TYPE_TONES[story.type] ?? 'neutral'}>{story.type}</Badge>
            {priorityBadge(ready, story)}
            {story.state ? <Badge tone={story.stateType === 'started' ? 'warning' : 'neutral'}>{story.state}</Badge> : null}
            {story.blocked ? <Badge tone="danger">Blocked</Badge> : null}
            {story.estimate !== null ? <Badge tone="neutral">{`${story.estimate} pt`}</Badge> : null}
            {story.labels.map((label) => (
              <Badge tone="neutral">{label}</Badge>
            ))}
          </Row>
          {session ? null : busy ? (
            <Spinner label={`Starting sc-${story.id}`} labelHidden />
          ) : (
            <IconButton
              size="xs"
              variant="solid"
              tone="accent"
              icon="play"
              label={`Start sc-${story.id}`}
              tooltip="Start in a new worktree"
              onPress={() => start(project, story)}
            />
          )}
        </Row>
        {session ? (
          <Row justify="between" align="center" gap="xs" wrap>
            <Row gap="xs" align="center">
              <IconButton
                size="xs"
                variant="ghost"
                icon="branch"
                label={`Open ${session.name}`}
                tooltip={`Open ${session.name}`}
                onPress={() => openWorktree(session.worktreeId)}
              />
              <Text size="sm">
                <Link onPress={() => openWorktree(session.worktreeId)}>{session.name}</Link>
              </Text>
            </Row>
            {session.agent ? <Badge tone="success">{agentLabel(session.agent)}</Badge> : null}
          </Row>
        ) : null}
        {!session && story.existingBranches.length ? (
          <Text size="xs" muted truncate>
            {`Existing branch: ${story.existingBranches[0]}`}
          </Text>
        ) : null}
        {error ? (
          <Text size="sm" tone="danger">
            {error}
          </Text>
        ) : null}
        {note ? (
          <Text size="sm" tone={note.warning ? 'warning' : undefined} muted={!note.warning}>
            {note.text}
          </Text>
        ) : null}
        <Collapsible title="Details" open={Boolean(read(expanded)[story.id])} onChange={(open) => toggleDetail(story, open)}>
          {read(expanded)[story.id] ? <StoryDetails story={story} ready={ready} /> : null}
        </Collapsible>
      </Stack>
    </Box>
  )
}

function TokenSetup() {
  const busy = read(tokenBusy)
  const error = read(tokenError)
  return (
    <Stack gap="sm">
      <EmptyState
        title="Connect Shortcut"
        description="Paste a Shortcut API token. It is checked against Shortcut, then kept in Orca's encrypted secrets."
        icon="plug"
      />
      <Input
        label="Shortcut API token"
        type="password"
        placeholder="Shortcut → Settings → API Tokens"
        value={read(tokenDraft)}
        disabled={busy}
        onChange={(value) => set(tokenDraft, value)}
        onSubmit={() => void saveToken()}
      />
      <Row gap="sm" align="center">
        <Button size="sm" variant="solid" tone="accent" icon="check" disabled={busy || !read(tokenDraft).trim()} onPress={saveToken}>
          Save token
        </Button>
        <Link href="https://app.shortcut.com/settings/account/api-tokens">Create a token</Link>
        {busy ? <Spinner label="Checking the token" labelHidden /> : null}
      </Row>
      {error ? (
        <Text size="sm" tone="danger">
          {error}
        </Text>
      ) : null}
    </Stack>
  )
}

const SORTS: Option[] = [
  { value: 'shortcut', label: 'Shortcut order' },
  { value: 'state', label: 'State' },
  { value: 'priority', label: 'Priority' },
  { value: 'estimate', label: 'Estimate' }
]

/** Stories in the chosen order; ties keep Shortcut's order. Unset values go last. */
function sorted(stories: Story[], key: SortKey, ready: ReadyBoard): Story[] {
  const rank = (story: Story): number => {
    if (key === 'state') {
      const i = story.state === null ? -1 : ready.states.indexOf(story.state)
      return i < 0 ? Infinity : i
    }
    if (key === 'priority') {
      const i = ready.priority?.values.findIndex((p) => p.id === story.priorityId) ?? -1
      return i < 0 ? Infinity : i
    }
    if (key === 'estimate') {
      return story.estimate ?? Infinity
    }
    return 0
  }
  return key === 'shortcut' ? stories : stories.map((s, i) => ({ s, i, r: rank(s) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.s)
}

function FilterControls({ current, applied }: { current: ReadyBoard; applied: number }) {
  const f = read(filters)
  const { stories } = current
  return (
    <Stack gap="sm">
      <Select
        label="Sort by"
        value={read(sortBy)}
        onChange={(v) => {
          const key = SORTS.find((o) => o.value === v)?.value as SortKey | undefined
          if (key) {
            set(sortBy, key)
          }
        }}
        options={SORTS.filter((o) => o.value !== 'priority' || current.priority)}
      />
      <Select
        label="State"
        value={f.state}
        onChange={(v) => update(filters, (x) => ({ ...x, state: v }))}
        options={options({ value: ANY, label: 'All states' }, stories.map((s) => s.state), f.state, current.states)}
      />
      <Select
        label="Type"
        value={f.type}
        onChange={(v) => update(filters, (x) => ({ ...x, type: v }))}
        options={options({ value: ANY, label: 'All types' }, stories.map((s) => s.type), f.type)}
      />
      <Select
        label="Label"
        value={f.label}
        onChange={(v) => update(filters, (x) => ({ ...x, label: v }))}
        options={options({ value: ANY, label: 'Any label' }, stories.flatMap((s) => s.labels), f.label)}
      />
      {applied ? (
        <Row>
          <Button size="xs" variant="ghost" icon="close" onPress={() => set(filters, NO_FILTERS)}>
            Clear all
          </Button>
        </Row>
      ) : null}
    </Stack>
  )
}

function PrefEditor({ all, project, kind }: { all: Prefs; project: ProjectRef; kind: 'query' | 'template' }) {
  const value = shownPref(all, project, kind)
  const own = all.projects[project.id]?.[kind] !== undefined
  return (
    <Stack gap="xs">
      <Textarea
        label={kind === 'query' ? `${project.name} Shortcut search` : `${project.name} prompt template`}
        labelHidden
        rows={rowsFor(value, kind === 'query' ? 2 : 4)}
        value={value}
        onChange={(v) => editPref(project, kind, v, kind === 'query')}
      />
      <Row justify="between" align="center" gap="xs" wrap>
        <Text size="sm" muted>
          {kind === 'query' ? (
            <>
              Shortcut search operators, e.g. <Code>team:Backend</Code> <Code>label:back</Code>. <Code>{'{{me}}'}</Code> is you.
            </>
          ) : (
            <>
              <Code>{'{{story_url}}'}</Code> <Code>{'{{story_id}}'}</Code> <Code>{'{{story_name}}'}</Code> <Code>{'{{branch}}'}</Code>{' '}
              <Code>{'{{story_description}}'}</Code> <Code>{'{{story_tasks}}'}</Code> <Code>{'{{story_comments}}'}</Code>
            </>
          )}
        </Text>
        {own ? (
          <Button size="xs" variant="ghost" icon="refresh" onPress={() => resetPref(project, kind)}>
            Use default
          </Button>
        ) : null}
      </Row>
    </Stack>
  )
}

export default function Panel() {
  const current = read(board)
  const problem = read(boardError)
  if (problem && !current) {
    return (
      <Stack gap="sm">
        <Text tone="danger">{problem}</Text>
        <Row>
          <Button size="sm" variant="outline" icon="refresh" onPress={loadBoard}>
            Try again
          </Button>
        </Row>
      </Stack>
    )
  }
  const all = read(prefs)
  if (!current || !all) {
    return <Spinner label="Loading stories" />
  }
  if (current.kind === 'no-token') {
    return <TokenSetup />
  }
  if (current.kind !== 'ready') {
    return <EmptyState title="No project selected" description="Select a workspace in Orca's sidebar." icon="branch" />
  }
  const { project, stories } = current
  const f = read(filters)
  const applied = (Object.keys(NO_FILTERS) as (keyof Filters)[]).filter((k) => f[k] !== ANY).length
  const visible = sorted(stories.filter((story) => matches(story, f)), read(sortBy), current)
  const open = read(sections)
  const toggle = (key: keyof Sections) => (value: boolean) => update(sections, (s) => ({ ...s, [key]: value }))
  return (
    <Stack gap="md">
      <Row justify="between" align="center" gap="xs">
        <Text size="sm" muted truncate>
          {`${project.name} · @${current.viewer}`}
        </Text>
        <Row gap="xs" align="center">
          {read(loading) ? <Spinner label="Refreshing" labelHidden /> : null}
          <IconButton size="xs" variant="ghost" icon="refresh" label="Refresh" tooltip="Refresh" onPress={loadBoard} />
        </Row>
      </Row>
      <Collapsible title="Search" description={current.query} open={open.search} onChange={toggle('search')}>
        <Stack gap="sm">
          <PrefEditor all={all} project={project} kind="query" />
          <Row>
            <Button size="xs" variant="ghost" icon="close" onPress={forgetToken}>
              Forget Shortcut token
            </Button>
          </Row>
        </Stack>
      </Collapsible>
      <Collapsible title="Prompt template" open={open.template} onChange={toggle('template')}>
        <PrefEditor all={all} project={project} kind="template" />
      </Collapsible>
      <Collapsible title="On Start" description={startSummary(all, project, current)} open={Boolean(open.start)} onChange={toggle('start')}>
        <StartControls all={all} project={project} current={current} />
      </Collapsible>
      <Collapsible title={applied ? `Filter (${applied})` : 'Filter'} open={open.filter} onChange={toggle('filter')}>
        <FilterControls current={current} applied={applied} />
      </Collapsible>
      {problem ? (
        <Row justify="between" align="center" gap="xs" wrap>
          <Text size="sm" tone="danger">
            {problem}
          </Text>
          <Button size="xs" variant="ghost" icon="refresh" onPress={loadBoard}>
            Try again
          </Button>
        </Row>
      ) : null}
      {stories.length === 0 ? (
        <EmptyState title="No stories" description="The search finds no story. Change it under Search." icon="check" />
      ) : visible.length === 0 ? (
        <Text size="sm" muted>
          No stories match these filters.
        </Text>
      ) : (
        <Stack gap="xs">
          {visible.map((story) => (
            <StoryCard project={project} story={story} ready={current} />
          ))}
          {current.truncated ? (
            <Text size="sm" muted>
              {`Showing the first ${stories.length} stories. Narrow the search to see the rest.`}
            </Text>
          ) : null}
        </Stack>
      )}
    </Stack>
  )
}
