// Shortcut REST API v3, called from the worker with `fetch` (workers have the network, panels do not).
// Pure parsers are exported for tests; `ShortcutClient` does the I/O.
// Reference: https://developer.shortcut.com/api/rest/v3
import type { PriorityField, StateOption, Story, StoryDetail, StoryOptions, StoryPatch } from './protocol'

const BASE = 'https://api.app.shortcut.com/api/v3'
const TIMEOUT_MS = 20000
/** Shortcut accepts up to 250 per page; one page keeps the panel and its 512 KiB render budget small. */
export const PAGE_SIZE = 100
/** A longer description is cut: the expanded card is a preview, Shortcut has the rest. */
export const DESCRIPTION_LIMIT = 20000
const COMMENT_LIMIT = 4000
/** Shortcut's default scale, when the workspace does not send its own. */
export const DEFAULT_ESTIMATE_SCALE = [0, 1, 2, 4, 8]

export class ShortcutError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

export type StateInfo = { name: string; type: string | null }
export type Workflows = {
  states: Map<number, StateInfo>
  order: string[]
  /** The states of each workflow, in workflow order. */
  byWorkflow: Record<number, StateOption[]>
}

type RawState = { id?: number; name?: string; type?: string; position?: number }
type RawWorkflow = { id?: number; states?: RawState[] }
type RawStory = {
  id?: number
  name?: string
  app_url?: string
  story_type?: string
  workflow_id?: number
  workflow_state_id?: number
  labels?: { name?: string }[]
  estimate?: number | null
  formatted_vcs_branch_name?: string | null
  branches?: { name?: string; deleted?: boolean; updated_at?: string }[]
  archived?: boolean
  epic_id?: number | null
  iteration_id?: number | null
  requested_by_id?: string | null
  owner_ids?: string[]
  custom_fields?: RawCustomValue[]
  blocked?: boolean
}
type RawCustomValue = { field_id?: string; value_id?: string }

/** Every workflow state by id, and the state names in workflow order without duplicates. */
export function parseWorkflows(json: unknown): Workflows {
  const states = new Map<number, StateInfo>()
  const order: string[] = []
  const byWorkflow: Record<number, StateOption[]> = {}
  for (const workflow of (Array.isArray(json) ? json : []) as RawWorkflow[]) {
    const sorted = [...(workflow.states ?? [])].sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    const options: StateOption[] = []
    for (const state of sorted) {
      if (typeof state.id !== 'number' || !state.name) {
        continue
      }
      states.set(state.id, { name: state.name, type: state.type ?? null })
      options.push({ id: state.id, name: state.name, type: state.type ?? null })
      if (!order.includes(state.name)) {
        order.push(state.name)
      }
    }
    if (typeof workflow.id === 'number') {
      byWorkflow[workflow.id] = options
    }
  }
  return { states, order, byWorkflow }
}

/** The stories of a search page, with their state names resolved. */
export function parseStories(
  json: unknown,
  workflows: Workflows,
  priority: PriorityField | null = null
): { stories: Story[]; total: number } {
  const page = (json ?? {}) as { data?: RawStory[]; total?: number }
  const stories = (page.data ?? []).flatMap((raw): Story[] => {
    if (typeof raw.id !== 'number' || !raw.name || !raw.app_url || raw.archived) {
      return []
    }
    const state = raw.workflow_state_id === undefined ? undefined : workflows.states.get(raw.workflow_state_id)
    return [
      {
        id: raw.id,
        name: raw.name,
        url: raw.app_url,
        type: raw.story_type ?? 'feature',
        state: state?.name ?? null,
        stateType: state?.type ?? null,
        workflowId: typeof raw.workflow_id === 'number' ? raw.workflow_id : null,
        stateId: state ? (raw.workflow_state_id as number) : null,
        labels: (raw.labels ?? []).flatMap((l) => (l.name ? [l.name] : [])),
        estimate: typeof raw.estimate === 'number' ? raw.estimate : null,
        epicId: typeof raw.epic_id === 'number' ? raw.epic_id : null,
        iterationId: typeof raw.iteration_id === 'number' ? raw.iteration_id : null,
        requesterId: raw.requested_by_id || null,
        ownerIds: (raw.owner_ids ?? []).filter((id) => typeof id === 'string'),
        priorityId: (priority && raw.custom_fields?.find((c) => c.field_id === priority.fieldId)?.value_id) || null,
        blocked: raw.blocked === true,
        branch: raw.formatted_vcs_branch_name || null,
        existingBranches: [...(raw.branches ?? [])]
          .filter((b) => b.name && !b.deleted)
          .sort((a, b) => (b.updated_at ?? '').localeCompare(a.updated_at ?? ''))
          .map((b) => b.name as string)
          .filter((name, i, all) => all.indexOf(name) === i)
      }
    ]
  })
  return { stories, total: typeof page.total === 'number' ? page.total : stories.length }
}

const cut = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}\n\n…` : text)

type RawComment = { author_id?: string; text?: string; created_at?: string; deleted?: boolean }

/** A story's description and live comments, authors resolved through `members` (id → mention name). */
type RawTask = { id?: number; description?: string; complete?: boolean; position?: number }
type RawLink = { verb?: string; subject_id?: number; object_id?: number }

/** A story's link, from one of the same workspace: its own `app_url` with another id. */
export const storyUrl = (appUrl: string, id: number): string => appUrl.replace(/\/story\/\d+.*$/, `/story/${id}`)

export function parseDetail(json: unknown, members: Map<string, string>): StoryDetail {
  const story = (json ?? {}) as {
    id?: number
    app_url?: string
    description?: string
    comments?: RawComment[]
    tasks?: RawTask[]
    story_links?: RawLink[]
  }
  return {
    tasks: [...(story.tasks ?? [])]
      .filter((t): t is RawTask & { id: number; description: string } => typeof t.id === 'number' && Boolean(t.description))
      .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
      .map((t) => ({ id: t.id, description: t.description, complete: t.complete === true })),
    blockers: (story.story_links ?? [])
      .filter((l) => l.verb === 'blocks' && l.object_id === story.id && typeof l.subject_id === 'number')
      .map((l) => ({ id: l.subject_id as number, url: storyUrl(story.app_url ?? '', l.subject_id as number) })),
    description: cut(story.description ?? '', DESCRIPTION_LIMIT),
    comments: (story.comments ?? [])
      .filter((c) => !c.deleted && c.text)
      .sort((a, b) => (a.created_at ?? '').localeCompare(b.created_at ?? ''))
      .map((c) => ({
        author: (c.author_id && members.get(c.author_id)) || 'someone',
        text: cut(c.text as string, COMMENT_LIMIT),
        at: c.created_at ?? ''
      }))
  }
}

type RawMember = { id?: string; disabled?: boolean; profile?: { mention_name?: string; deactivated?: boolean } }
export type Member = { id: string; mention: string; active: boolean }

/** Every member, disabled ones included: they still sign old comments. */
export function parseMembers(json: unknown): Member[] {
  return ((Array.isArray(json) ? json : []) as RawMember[]).flatMap((m) =>
    m.id && m.profile?.mention_name
      ? [{ id: m.id, mention: m.profile.mention_name, active: !m.disabled && !m.profile.deactivated }]
      : []
  )
}

export const mentionsById = (members: Member[]): Map<string, string> => new Map(members.map((m) => [m.id, m.mention]))

type RawField = { id?: string; canonical_name?: string; enabled?: boolean; values?: { id?: string; value?: string; enabled?: boolean; position?: number }[] }

/** The enabled Priority custom field, its enabled values in Shortcut's order. */
export function parsePriority(json: unknown): PriorityField | null {
  const field = ((Array.isArray(json) ? json : []) as RawField[]).find((f) => f.canonical_name === 'priority' && f.enabled !== false)
  if (!field?.id) {
    return null
  }
  const values = [...(field.values ?? [])]
    .filter((v) => v.id && v.value && v.enabled !== false)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((v) => ({ id: v.id as string, name: v.value as string }))
  return { fieldId: field.id, values }
}

/** Epics by name; a name used twice gets its id, so the picker tells them apart. */
export function parseEpics(json: unknown): StoryOptions['epics'] {
  const raw = ((json as { data?: { id?: number; name?: string; archived?: boolean }[] })?.data ?? []).filter(
    (e): e is { id: number; name: string } => typeof e.id === 'number' && Boolean(e.name)
  )
  const count = (name: string) => raw.filter((e) => e.name === name).length
  return raw
    .map((e) => ({ id: e.id, name: count(e.name) > 1 ? `${e.name} · #${e.id}` : e.name }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** Iterations by start date. Shortcut's `!is:done` search returns finished ones too: `status` decides. */
export function parseIterations(json: unknown): StoryOptions['iterations'] {
  return ((Array.isArray(json) ? json : []) as { id?: number; name?: string; status?: string; start_date?: string }[])
    .filter((i): i is { id: number; name: string; status?: string; start_date?: string } => typeof i.id === 'number' && Boolean(i.name))
    .sort((a, b) => (a.start_date ?? '').localeCompare(b.start_date ?? ''))
    .map((i) => ({ id: i.id, name: i.name, done: i.status === 'done' }))
}

/**
 * The PUT body for a patch. Shortcut replaces a story's whole `custom_fields` set, so a priority
 * change sends the story's other custom field values back unchanged.
 */
export function updateBody(patch: StoryPatch, current: RawCustomValue[] | null, priority: PriorityField | null): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (patch.stateId !== undefined) body.workflow_state_id = patch.stateId
  if (patch.estimate !== undefined) body.estimate = patch.estimate
  if (patch.type !== undefined) body.story_type = patch.type
  if (patch.epicId !== undefined) body.epic_id = patch.epicId
  if (patch.iterationId !== undefined) body.iteration_id = patch.iterationId
  if (patch.requesterId !== undefined) body.requested_by_id = patch.requesterId
  if (patch.ownerIds !== undefined) body.owner_ids = patch.ownerIds
  if (patch.priorityId !== undefined) {
    if (!priority || current === null) {
      throw new ShortcutError('This workspace has no Priority field.', null)
    }
    const others = current
      .filter((c) => c.field_id && c.value_id && c.field_id !== priority.fieldId)
      .map((c) => ({ field_id: c.field_id, value_id: c.value_id }))
    body.custom_fields = patch.priorityId === null ? others : [...others, { field_id: priority.fieldId, value_id: patch.priorityId }]
  }
  return body
}

/** `{{me}}` in a saved search becomes the token member's mention name. */
export const renderQuery = (query: string, me: string): string => query.replaceAll('{{me}}', me).trim()

/** A message the panel can show for a failed call. */
export function errorMessage(error: unknown): string {
  if (error instanceof ShortcutError) {
    if (error.status === 401 || error.status === 403) {
      return 'Shortcut refused the token. Check it in Shortcut → Settings → API Tokens, then set it again.'
    }
    if (error.status === 429) {
      return 'Shortcut rate limit reached (200 requests a minute). Try again in a minute.'
    }
    if (error.status === 400 || error.status === 422) {
      return `Shortcut did not accept the search: ${error.message}`
    }
    return `Shortcut answered ${error.status ?? 'nothing'}: ${error.message}`
  }
  return `Could not reach Shortcut: ${(error as Error)?.message ?? 'unknown error'}`
}

export class ShortcutClient {
  constructor(
    private readonly token: string,
    private readonly fetcher: Fetch = (url, init) => fetch(url, init)
  ) {}

  private get(path: string, params?: Record<string, string>): Promise<unknown> {
    return this.call('GET', `${path}${params ? `?${new URLSearchParams(params)}` : ''}`)
  }

  private async call(method: 'GET' | 'PUT' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response
    try {
      response = await this.fetcher(`${BASE}${path}`, {
        method,
        headers: { 'Shortcut-Token': this.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
    } catch (error) {
      throw new ShortcutError((error as Error).message, null)
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '')
      let message = body.slice(0, 300)
      try {
        const parsed = JSON.parse(body) as { message?: string; errors?: unknown }
        message = parsed.message ?? (parsed.errors ? JSON.stringify(parsed.errors) : message)
      } catch {
        // Not JSON: keep the text.
      }
      throw new ShortcutError(message || response.statusText, response.status)
    }
    return response.json()
  }

  /** The token member's mention name, the `{{me}}` of searches. */
  async me(): Promise<string> {
    return (await this.member()).me
  }

  /** The mention name and id, and the workspace's estimate scale. */
  async member(): Promise<{ me: string; meId: string; estimateScale: number[] }> {
    const member = (await this.get('/member')) as { id?: string; mention_name?: string; workspace2?: { estimate_scale?: unknown } }
    if (!member.mention_name) {
      throw new ShortcutError('Shortcut did not return the member.', null)
    }
    const scale = member.workspace2?.estimate_scale
    const numbers = Array.isArray(scale) ? scale.filter((n): n is number => typeof n === 'number') : []
    return { me: member.mention_name, meId: member.id ?? '', estimateScale: numbers.length ? numbers : DEFAULT_ESTIMATE_SCALE }
  }

  async workflows(): Promise<Workflows> {
    return parseWorkflows(await this.get('/workflows'))
  }

  async search(query: string, workflows: Workflows, priority: PriorityField | null = null): Promise<{ stories: Story[]; total: number }> {
    // `full`: `slim` references branches by id only, and the panel shows existing branch names.
    const page = await this.get('/search/stories', { query, page_size: String(PAGE_SIZE), detail: 'full' })
    return parseStories(page, workflows, priority)
  }

  async members(): Promise<Member[]> {
    return parseMembers(await this.get('/members'))
  }

  async priority(): Promise<PriorityField | null> {
    return parsePriority(await this.get('/custom-fields'))
  }

  async epics(): Promise<StoryOptions['epics']> {
    return parseEpics(await this.get('/search/epics', { query: '!is:done !is:archived', page_size: '100', detail: 'slim' }))
  }

  async iterations(): Promise<StoryOptions['iterations']> {
    return parseIterations(await this.get('/iterations'))
  }

  /** Posts a comment; Shortcut signs it with the token's member. */
  async comment(storyId: number, text: string): Promise<{ text: string; at: string }> {
    const made = (await this.call('POST', `/stories/${storyId}/comments`, { text })) as { text?: string; created_at?: string }
    return { text: made.text ?? text, at: made.created_at ?? new Date().toISOString() }
  }

  async setTask(storyId: number, taskId: number, complete: boolean): Promise<void> {
    await this.call('PUT', `/stories/${storyId}/tasks/${taskId}`, { complete })
  }

  /** Applies a patch; a priority change first reads the story's custom fields to keep the others. */
  async update(storyId: number, patch: StoryPatch, priority: PriorityField | null): Promise<void> {
    const current =
      patch.priorityId === undefined
        ? null
        : (((await this.get(`/stories/${storyId}`)) as { custom_fields?: RawCustomValue[] }).custom_fields ?? [])
    await this.call('PUT', `/stories/${storyId}`, updateBody(patch, current, priority))
  }

  async detail(storyId: number, members: Map<string, string>): Promise<StoryDetail> {
    return parseDetail(await this.get(`/stories/${storyId}`), members)
  }


}
