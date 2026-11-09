// Serves the Shortcut Launcher panel. Orca transpiles this file when it loads: no build step.
// Plugins have no host method for projects or worktree creation, so the worker asks the `orca`
// CLI, which runs as the same user; Shortcut is called over HTTPS with the token from secrets.
// Adapted from rr235/orca-task-launcher (MIT).
import type { OrcaWorkerApi } from 'orca/worker'
import {
  activeProjectId,
  createArgs,
  createdWorktree,
  existingBranch,
  parseProjectList,
  prefFor,
  projectRepoIds,
  readPrefs,
  renderTemplate,
  repoPath,
  sessionsFor,
  startStateFor,
  startTarget,
  usesDetail,
  type ExistingBranch
} from './board'
import { run } from './cli'
import {
  PREFS_KEY,
  TOKEN_KEY,
  type Board,
  type PriorityField,
  type ProjectRef,
  type StartResult,
  type StateOption,
  type Story,
  type StoryDetail,
  type StoryOptions,
  type TokenResult
} from './protocol'
import { readDefaultAgent } from './settings'
import { errorMessage, mentionsById, renderQuery, ShortcutClient, ShortcutError, type Member, type Workflows } from './shortcut'

const CREATE_TIMEOUT_MS = 110000
const RETRY_AFTER_TIMEOUT_MS = 5 * 60 * 1000
const PROJECTS_CACHE_MS = 5 * 60 * 1000
// Workflows and the member rarely change: one fetch per worker run and token, refreshed hourly.
const SHORTCUT_CACHE_MS = 60 * 60 * 1000
// Epics, iterations and members change more often (a new sprint, a new epic).
const OPTIONS_CACHE_MS = 5 * 60 * 1000

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export default function activate(orca: OrcaWorkerApi): void {
  // Read `fetch` at call time, so tests can stub the global.
  const fetcher: Fetch = (url, init) => fetch(url, init)
  const log = (message: string) => orca.log(message)

  let projectsCache: { at: number; projects: ProjectRef[] } | null = null
  async function listProjects(refresh = false): Promise<ProjectRef[]> {
    if (!refresh && projectsCache && Date.now() - projectsCache.at < PROJECTS_CACHE_MS) {
      return projectsCache.projects
    }
    projectsCache = { at: Date.now(), projects: parseProjectList(await run('orca', ['project', 'list', '--json'])) }
    return projectsCache.projects
  }

  type Cached = { me: string; meId: string; estimateScale: number[]; workflows: Workflows; priority: PriorityField | null }
  let shortcutCache: ({ at: number; token: string } & Cached) | null = null
  async function shortcut(token: string): Promise<{ client: ShortcutClient } & Cached> {
    const client = new ShortcutClient(token, fetcher)
    if (!shortcutCache || shortcutCache.token !== token || Date.now() - shortcutCache.at > SHORTCUT_CACHE_MS) {
      const [member, workflows, priority] = await Promise.all([client.member(), client.workflows(), client.priority()])
      shortcutCache = { at: Date.now(), token, ...member, workflows, priority }
    }
    const { me, meId, estimateScale, workflows, priority } = shortcutCache
    return { client, me, meId, estimateScale, workflows, priority }
  }

  async function activeProject(): Promise<ProjectRef | null> {
    const [psJson, listJson] = await Promise.all([
      run('orca', ['worktree', 'ps', '--json']),
      run('orca', ['worktree', 'list', '--json'])
    ])
    const projectId = activeProjectId(psJson, listJson)
    if (!projectId) {
      return null
    }
    return (
      (await listProjects()).find((p) => p.id === projectId) ??
      (await listProjects(true)).find((p) => p.id === projectId) ??
      null
    )
  }

  // Members (comment authors, owners), epics and iterations: fetched when a card opens.
  let membersCache: { at: number; token: string; members: Member[] } | null = null
  async function members(client: ShortcutClient, token: string): Promise<Member[]> {
    if (!membersCache || membersCache.token !== token || Date.now() - membersCache.at > OPTIONS_CACHE_MS) {
      membersCache = { at: Date.now(), token, members: await client.members() }
    }
    return membersCache.members
  }
  let optionsCache: { at: number; token: string; options: StoryOptions } | null = null
  async function storyOptions(client: ShortcutClient, token: string): Promise<StoryOptions> {
    if (!optionsCache || optionsCache.token !== token || Date.now() - optionsCache.at > OPTIONS_CACHE_MS) {
      const [epics, iterations, all] = await Promise.all([client.epics(), client.iterations(), members(client, token)])
      const active = all.filter((m) => m.active).map(({ id, mention }) => ({ id, mention }))
      optionsCache = { at: Date.now(), token, options: { epics, iterations, members: active.sort((a, b) => a.mention.localeCompare(b.mention)) } }
    }
    return optionsCache.options
  }

  /** Runs a Shortcut call with the stored token, turning failures into a message the panel shows. */
  async function withShortcut<T>(what: string, call: (client: ShortcutClient, token: string) => Promise<T>): Promise<T> {
    const token = await orca.secrets.get(TOKEN_KEY)
    if (!token) {
      throw new Error('Connect Shortcut first.')
    }
    try {
      return await call(new ShortcutClient(token, fetcher), token)
    } catch (error) {
      log(`${what}: shortcut failed: ${(error as Error).message}`)
      const status = error instanceof ShortcutError ? error.status : null
      throw new Error(
        status === 400 || status === 422 ? `Shortcut refused the change: ${(error as Error).message}` : errorMessage(error)
      )
    }
  }

  async function loadBoard({ projectId }: { projectId: string }): Promise<Board> {
    const token = await orca.secrets.get(TOKEN_KEY)
    if (!token) {
      return { kind: 'no-token' }
    }
    let project: ProjectRef | undefined, psJson: string, listJson: string
    try {
      const [projects, ps, list] = await Promise.all([
        listProjects(),
        run('orca', ['worktree', 'ps', '--json']),
        run('orca', ['worktree', 'list', '--json'])
      ])
      project = projects.find((p) => p.id === projectId)
      psJson = ps
      listJson = list
    } catch (error) {
      log(`board.load: orca failed: ${(error as Error).message}`)
      return { kind: 'error', message: 'Could not read Orca worktrees. Is Orca running?' }
    }
    if (!project) {
      return { kind: 'no-project' }
    }
    try {
      const { client, me, meId, estimateScale, workflows, priority } = await shortcut(token)
      const query = renderQuery(prefFor(readPrefs(await orca.storage.get(PREFS_KEY)), project.id, 'query'), me)
      const { stories, total } = await client.search(query, workflows, priority)
      return {
        kind: 'ready',
        project,
        query,
        stories,
        truncated: total > stories.length,
        sessions: sessionsFor(project.id, listJson, psJson),
        states: workflows.order,
        workflowStates: workflows.byWorkflow,
        estimateScale,
        priority,
        viewerId: meId,
        viewer: me
      }
    } catch (error) {
      log(`board.load: shortcut failed: ${(error as Error).message}`)
      return { kind: 'error', message: errorMessage(error) }
    }
  }

  const starts = new Map<string, Promise<StartResult>>()
  // When a create timed out, keyed by story: Orca may still finish it, so a retry waits.
  const timedOut = new Map<string, number>()

  /** The story's detail for the prompt, or null when Shortcut cannot give it: Start goes on without. */
  async function detailForPrompt(story: Story): Promise<StoryDetail | null> {
    try {
      return await withShortcut('story.start detail', async (client, token) =>
        client.detail(story.id, mentionsById(await members(client, token)))
      )
    } catch {
      return null
    }
  }

  /** A branch of the story already in the repo or on its remote, found by its `sc-<id>`. */
  async function findExisting(projectId: string, story: Story): Promise<{ branch: ExistingBranch; repoPath: string } | null> {
    const repoIds = projectRepoIds(await run('orca', ['project', 'list', '--json']))[projectId] ?? []
    const repoId = repoIds[0]
    if (!repoId) {
      return null
    }
    const refs = await run('orca', ['repo', 'search-refs', '--repo', `id:${repoId}`, '--query', `sc-${story.id}`, '--limit', '50', '--json'])
    const branch = existingBranch(story, refs)
    const path = branch ? repoPath(await run('orca', ['repo', 'list', '--json']), repoId) : null
    return branch && path ? { branch, repoPath: path } : null
  }

  /**
   * Takes up an existing branch: Orca makes the worktree from it on a branch of its own naming, then
   * the worktree switches to the existing branch (a remote one gets a local tracking branch) and drops
   * Orca's. The CLI cannot create a worktree on a branch that already exists.
   */
  async function createOnExisting(input: { projectId: string; story: Story }, found: { branch: ExistingBranch; repoPath: string }, agent: string | null, prompt: string): Promise<void> {
    const { name, local } = found.branch
    const made = createdWorktree(
      await run('orca', createArgs({ ...input, agent: null, prompt, base: local ? name : `origin/${name}` }), CREATE_TIMEOUT_MS)
    )
    if (!made) {
      throw new Error('Orca did not say where it made the worktree.')
    }
    try {
      await run('git', ['-C', made.path, 'checkout', local ? name : '--track', ...(local ? [] : [`origin/${name}`])])
    } catch (error) {
      throw new Error(`The worktree is at ${made.path}, but it could not switch to ${name}: ${(error as Error).message}`)
    }
    if (made.branch && made.branch !== name) {
      await run('git', ['-C', made.path, 'branch', '-D', made.branch]).catch((error: Error) => log(`story.start: kept ${made.branch}: ${error.message}`))
    }
    if (agent) {
      await run('orca', ['agent', 'launch', '--worktree', `path:${made.path}`, '--agent', agent, '--prompt', prompt, '--json'], 30000)
    }
  }

  /** Moves a story not started yet to the project's Start state; a failure only warns. */
  async function moveOnStart(projectId: string, story: Story): Promise<{ moved: StateOption | null; warning: string | null }> {
    const token = await orca.secrets.get(TOKEN_KEY)
    if (!token || story.workflowId === null) {
      return { moved: null, warning: null }
    }
    const { client, workflows } = await shortcut(token)
    const target = startTarget(story, workflows.byWorkflow[story.workflowId] ?? [], startStateFor(readPrefs(await orca.storage.get(PREFS_KEY)), projectId))
    if (!target) {
      return { moved: null, warning: null }
    }
    try {
      await client.update(story.id, { stateId: target.id }, null)
      return { moved: target, warning: null }
    } catch (error) {
      log(`story.start: could not move sc-${story.id}: ${(error as Error).message}`)
      return { moved: null, warning: `Started, but Shortcut did not move the story to ${target.name}: ${errorMessage(error)}` }
    }
  }

  async function create(input: { projectId: string; story: Story }): Promise<StartResult> {
    const listJson = await run('orca', ['worktree', 'list', '--json'])
    if (sessionsFor(input.projectId, listJson, '{}')[input.story.id]) {
      return { reused: null, moved: null, warning: null }
    }
    const key = `${input.projectId}#${input.story.id}`
    if (Date.now() - (timedOut.get(key) ?? 0) < RETRY_AFTER_TIMEOUT_MS) {
      throw new Error('The last Start for this story timed out and may still finish. Try again in a few minutes.')
    }
    const template = prefFor(readPrefs(await orca.storage.get(PREFS_KEY)), input.projectId, 'template')
    let [detail, found, agent] = await Promise.all([
      usesDetail(template) ? detailForPrompt(input.story) : null,
      findExisting(input.projectId, input.story).catch((error: Error) => {
        log(`story.start: branch lookup failed, making a new branch: ${error.message}`)
        return null
      }),
      readDefaultAgent(log)
    ])
    // Shortcut lists a story's branches from every repository: one may live in another repo than this
    // project's. A remote branch is fetched first; when the fetch fails, Start makes a new branch.
    if (found && !found.branch.local) {
      const { name } = found.branch
      try {
        await run('git', ['-C', found.repoPath, 'fetch', 'origin', `${name}:refs/remotes/origin/${name}`], 30000)
      } catch (error) {
        log(`story.start: ${name} is not on this project's remote, making a new branch: ${(error as Error).message}`)
        found = null
      }
    }
    const prompt = renderTemplate(template, input.story, detail, found?.branch.name)
    try {
      if (found) {
        await createOnExisting(input, found, agent, prompt)
      } else {
        await run('orca', createArgs({ projectId: input.projectId, story: input.story, agent, prompt }), CREATE_TIMEOUT_MS)
      }
    } catch (error) {
      if ((error as { timedOut?: boolean }).timedOut) {
        timedOut.set(key, Date.now())
      }
      log(`story.start: failed: ${(error as Error).message}`)
      throw error
    }
    const { moved, warning } = await moveOnStart(input.projectId, input.story).catch((error: Error) => ({
      moved: null,
      warning: `Started, but the story was not moved: ${error.message}`
    }))
    return { reused: found?.branch.name ?? null, moved, warning }
  }

  async function setToken({ token }: { token: string }): Promise<TokenResult> {
    const trimmed = token.trim()
    if (!trimmed) {
      return { ok: false, message: 'Paste a token first.' }
    }
    try {
      const me = await new ShortcutClient(trimmed, fetcher).me()
      await orca.secrets.set(TOKEN_KEY, trimmed)
      shortcutCache = null
      return { ok: true, viewer: me }
    } catch (error) {
      return { ok: false, message: errorMessage(error) }
    }
  }

  orca.panels.handle('project.active', () => activeProject())
  orca.panels.handle('board.load', loadBoard)
  orca.panels.handle('story.start', (input) => {
    const key = `${input.projectId}#${input.story.id}`
    const existing = starts.get(key)
    if (existing) {
      return existing
    }
    const pending = create(input).finally(() => starts.delete(key))
    starts.set(key, pending)
    return pending
  })
  orca.panels.handle('story.detail', ({ storyId }) =>
    withShortcut('story.detail', async (client, token) => client.detail(storyId, mentionsById(await members(client, token))))
  )
  orca.panels.handle('story.comment', ({ storyId, text }) =>
    withShortcut('story.comment', async (client, token) => {
      if (!text.trim()) {
        throw new Error('Write something first.')
      }
      const made = await client.comment(storyId, text.trim())
      return { author: (await shortcut(token)).me, ...made }
    })
  )
  orca.panels.handle('story.task', ({ storyId, taskId, complete }) =>
    withShortcut('story.task', async (client) => {
      await client.setTask(storyId, taskId, complete)
      return null
    })
  )
  orca.panels.handle('story.options', () => withShortcut('story.options', (client, token) => storyOptions(client, token)))
  // Edits to one story run one after another: a priority change reads, then writes, its custom fields.
  const updates = new Map<number, Promise<unknown>>()
  orca.panels.handle('story.update', ({ storyId, patch }) => {
    const run = (updates.get(storyId) ?? Promise.resolve())
      .catch(() => {})
      .then(() =>
        withShortcut('story.update', async (client, token) => {
          // The Priority field id comes with the board's cached workspace data; only a priority change needs it.
          await client.update(storyId, patch, patch.priorityId === undefined ? null : (await shortcut(token)).priority)
          return null
        })
      )
    updates.set(storyId, run)
    return run.finally(() => {
      if (updates.get(storyId) === run) {
        updates.delete(storyId)
      }
    })
  })
  // The CLI has no command to reveal an existing worktree; the host's workspace.open does it.
  // Its workspace ids are matched to the CLI's worktree id, or failing that to its path.
  orca.panels.handle('worktree.open', async ({ worktreeId }) => {
    const { workspaces } = await orca.host.call('workspace.list')
    const path = worktreeId.includes('::') ? worktreeId.slice(worktreeId.indexOf('::') + 2) : null
    const match = workspaces.find((w) => w.id === worktreeId) ?? workspaces.find((w) => path !== null && w.path === path)
    if (!match) {
      log(`worktree.open: no workspace for ${worktreeId}`)
      throw new Error('This worktree is not in Orca any more.')
    }
    await orca.host.call('workspace.open', { workspaceId: match.id })
    return null
  })
  orca.panels.handle('token.set', setToken)
  orca.panels.handle('token.clear', async () => {
    await orca.secrets.delete(TOKEN_KEY)
    shortcutCache = null
    membersCache = null
    optionsCache = null
    return null
  })
}
