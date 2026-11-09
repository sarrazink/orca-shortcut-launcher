// Pure reads of the `orca` CLI output, the preferences, and the worktree create command a Start
// runs. The worker does the I/O; everything here is testable without it.
// Adapted from rr235/orca-task-launcher (MIT).
import {
  DEFAULT_PREFS,
  DEFAULT_START_STATE,
  DETAIL_VARIABLES,
  type Prefs,
  type ProjectRef,
  type Session,
  type StartState,
  type StateOption,
  type Story,
  type StoryDetail
} from './protocol'

type WorktreeRow = { id?: string; projectId?: string; displayName?: string; branch?: string | null; isArchived?: boolean }
type PsRow = { worktreeId?: string; isActive?: boolean; agents?: { agentType?: string | null }[] }
type Project = { id?: string; displayName?: string; sourceRepoIds?: string[] }

const worktreeRows = (listJson: string): WorktreeRow[] =>
  (JSON.parse(listJson) as { result?: { worktrees?: WorktreeRow[] } }).result?.worktrees ?? []
const psRows = (psJson: string): PsRow[] =>
  (JSON.parse(psJson) as { result?: { worktrees?: PsRow[] } }).result?.worktrees ?? []

/** Each project's Orca repo ids, for `orca repo search-refs`. */
export function projectRepoIds(json: string): Record<string, string[]> {
  const projects = (JSON.parse(json) as { result?: { projects?: Project[] } }).result?.projects ?? []
  return Object.fromEntries(projects.flatMap((p) => (p.id ? [[p.id, (p.sourceRepoIds ?? []).filter(Boolean)]] : [])))
}

/** A repo's path from `orca repo list --json`. */
export function repoPath(json: string, repoId: string): string | null {
  const repos = (JSON.parse(json) as { result?: { repos?: { id?: string; path?: string }[] } }).result?.repos ?? []
  return repos.find((r) => r.id === repoId)?.path ?? null
}

/** A branch Start can take up: in this clone already (`local`), or only on the remote. */
export type ExistingBranch = { name: string; local: boolean }

/**
 * The branch a Start should take up instead of making one: of the story's branches Shortcut knows
 * (newest first) and the local ones `search-refs` finds, the first carrying the story's id. Local
 * branches win over the order, since they may hold unpushed work.
 */
export function existingBranch(story: Pick<Story, 'id' | 'existingBranches'>, refsJson: string): ExistingBranch | null {
  const refs = (JSON.parse(refsJson) as { result?: { refs?: string[] } }).result?.refs ?? []
  const local = refs.flatMap((r) => (r.startsWith('refs/heads/') ? [r.slice('refs/heads/'.length)] : []))
  const remote = refs.flatMap((r) => (r.startsWith('refs/remotes/origin/') ? [r.slice('refs/remotes/origin/'.length)] : []))
  const ours = (name: string) => storyIdOf(name) === story.id && name !== 'HEAD'
  const known = [...story.existingBranches, ...remote].filter(ours)
  const pick = [...known.filter((n) => local.includes(n)), ...local.filter(ours), ...known][0]
  return pick ? { name: pick, local: local.includes(pick) } : null
}

/** Every Orca project from `orca project list --json`, whatever hosts its repo, sorted by name. */
export function parseProjectList(json: string): ProjectRef[] {
  const projects = (JSON.parse(json) as { result?: { projects?: Project[] } }).result?.projects ?? []
  return projects
    .flatMap((p) => (p.id && p.displayName ? [{ id: p.id, name: p.displayName }] : []))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Orca's project id for the worktree selected in the sidebar, or null when none is selected. */
export function activeProjectId(psJson: string, listJson: string): string | null {
  const active = psRows(psJson).find((row) => row.isActive)?.worktreeId
  if (!active) {
    return null
  }
  return worktreeRows(listJson).find((row) => row.id === active)?.projectId ?? null
}

/** The story id a branch carries, Shortcut's own convention: `sc-123` as a path or dash segment. */
export function storyIdOf(branch: string | null | undefined): number | null {
  const match = /(?:^|[/_-])sc-(\d+)(?=$|[/_-])/i.exec((branch ?? '').replace(/^refs\/heads\//, ''))
  return match ? Number(match[1]) : null
}

/** The live worktree of each story in the project, found by its branch, with the agent running in it.
 *  Worktrees made by hand on an `sc-<id>` branch count too. */
export function sessionsFor(projectId: string, listJson: string, psJson: string): Record<number, Session> {
  const agents = new Map(psRows(psJson).map((row) => [row.worktreeId, row.agents?.[0]?.agentType ?? null]))
  const sessions: Record<number, Session> = {}
  for (const row of worktreeRows(listJson)) {
    const storyId = storyIdOf(row.branch)
    if (row.projectId !== projectId || row.isArchived || !row.id || storyId === null || sessions[storyId]) {
      continue
    }
    sessions[storyId] = { worktreeId: row.id, name: row.displayName ?? `sc-${storyId}`, agent: agents.get(row.id) ?? null }
  }
  return sessions
}

/** Stored preferences, or the defaults when storage is empty or holds another shape. */
export function readPrefs(value: unknown): Prefs {
  const stored = value as Partial<Prefs> | null
  if (!stored || typeof stored !== 'object') {
    return DEFAULT_PREFS
  }
  const projects: Prefs['projects'] = {}
  for (const [id, p] of Object.entries(stored.projects ?? {})) {
    if (p && typeof p === 'object') {
      projects[id] = {
        ...(typeof p.query === 'string' ? { query: p.query } : {}),
        ...(typeof p.template === 'string' ? { template: p.template } : {})
      }
    }
  }
  for (const [id, p] of Object.entries(stored.projects ?? {})) {
    const start = (p as { startState?: unknown } | null)?.startState
    if (projects[id] && isStartState(start)) {
      projects[id].startState = start
    }
  }
  return {
    query: typeof stored.query === 'string' ? stored.query : DEFAULT_PREFS.query,
    template: typeof stored.template === 'string' ? stored.template : DEFAULT_PREFS.template,
    projects
  }
}

/** The project's own search or prompt when it has a non-blank one, else the default. */
export function prefFor(prefs: Prefs, projectId: string, key: 'query' | 'template'): string {
  return prefs.projects[projectId]?.[key]?.trim() || prefs[key].trim() || DEFAULT_PREFS[key]
}

const isStartState = (value: unknown): value is StartState =>
  value === 'first-started' || value === 'none' || (typeof value === 'string' && value.startsWith('=') && value.length > 1)

export const startStateFor = (prefs: Prefs, projectId: string): StartState =>
  prefs.projects[projectId]?.startState ?? DEFAULT_START_STATE

/**
 * The state Start moves the story to: only a story not started yet moves, within its own workflow.
 * `first-started` is the workflow's first state of type started.
 */
export function startTarget(story: Pick<Story, 'stateType' | 'stateId'>, states: StateOption[], choice: StartState): StateOption | null {
  if (choice === 'none' || story.stateType !== 'unstarted') {
    return null
  }
  const target = choice === 'first-started' ? states.find((s) => s.type === 'started') : states.find((s) => s.name === choice.slice(1))
  return target && target.id !== story.stateId ? target : null
}

export const usesDetail = (template: string): boolean => DETAIL_VARIABLES.some((v) => template.includes(v))

/** `story` fills the story variables; `detail`, when fetched, its description, tasks and comments. */
export function renderTemplate(template: string, story: Story, detail: StoryDetail | null = null, branch = branchFor(story)): string {
  const tasks = detail?.tasks.length
    ? ['Tasks:', ...detail.tasks.map((t) => `- [${t.complete ? 'x' : ' '}] ${t.description}`)].join('\n')
    : ''
  const comments = detail?.comments.length
    ? ['Comments:', ...detail.comments.map((c) => `- @${c.author}: ${c.text.replace(/\s*\n\s*/g, ' ')}`)].join('\n')
    : ''
  return template
    .replaceAll('{{story_url}}', story.url)
    .replaceAll('{{story_id}}', String(story.id))
    .replaceAll('{{story_name}}', story.name)
    .replaceAll('{{branch}}', branch)
    .replaceAll('{{story_description}}', detail?.description.trim() ?? '')
    .replaceAll('{{story_tasks}}', tasks)
    .replaceAll('{{story_comments}}', comments)
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Shortcut's formatted branch name, or `sc-<id>-<first words>` when the workspace gives none.
 *  Either way it carries `sc-<id>`, which links the branch and its merge request to the story. */
export function branchFor(story: Pick<Story, 'id' | 'name' | 'branch'>): string {
  if (story.branch && storyIdOf(story.branch) === story.id) {
    return story.branch
  }
  return `sc-${story.id}-${slug(story.name, 5)}`.replace(/-$/, '')
}

/** `sc-<id>-<first four words>`, the worktree's display name. */
export function worktreeName(story: Pick<Story, 'id' | 'name'>): string {
  return `sc-${story.id}-${slug(story.name, 4)}`.replace(/-$/, '')
}

function slug(text: string, words: number): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .split('-')
    .filter(Boolean)
    .slice(0, words)
    .join('-')
}

/**
 * Arguments for `orca worktree create`: a top-level worktree on the story's new branch, or, with
 * `base`, a worktree started from an existing branch (Orca names its own branch; the worker then
 * switches to the existing one).
 */
export function createArgs(input: { projectId: string; story: Story; agent: string | null; prompt: string; base?: string }): string[] {
  const args = [
    'worktree',
    'create',
    '--project',
    input.projectId,
    '--name',
    worktreeName(input.story),
    ...(input.base ? ['--base-branch', input.base] : ['--branch', branchFor(input.story)]),
    '--comment',
    input.story.url,
    '--no-parent',
    '--json'
  ]
  return input.agent ? [...args, '--agent', input.agent, '--prompt', input.prompt] : args
}

/** The new worktree's path and branch from `orca worktree create --json`. */
export function createdWorktree(json: string): { path: string; branch: string | null } | null {
  const worktree = (JSON.parse(json) as { result?: { worktree?: { path?: string; branch?: string | null } } }).result?.worktree
  return worktree?.path ? { path: worktree.path, branch: worktree.branch?.replace(/^refs\/heads\//, '') ?? null } : null
}

const AGENT_LABELS: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode', gemini: 'Gemini' }
export const agentLabel = (agent: string): string => AGENT_LABELS[agent] ?? agent.charAt(0).toUpperCase() + agent.slice(1)
