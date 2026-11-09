// The panel <-> worker contract and the stored preferences, read by both sides.

/** An Orca project: `id` is Orca's project id (`git:gitlab.com/...`, `github:...`), any provider. */
export type ProjectRef = { id: string; name: string }

/** The search and prompt a project uses; blank fields fall back to the defaults. */
export type ProjectPrefs = { query?: string; template?: string; startState?: StartState }
/** Where Start moves a story that is not started yet: Shortcut's first started state, none, or `=<state name>`. */
export type StartState = 'first-started' | 'none' | `=${string}`
export const DEFAULT_START_STATE: StartState = 'first-started'
export type Prefs = { query: string; template: string; projects: Record<string, ProjectPrefs> }

export const PREFS_KEY = 'prefs'
/** The Shortcut API token, in the plugin's encrypted secrets (secrets:own). */
export const TOKEN_KEY = 'shortcut-token'

export const DEFAULT_QUERY = 'owner:{{me}} !is:done !is:archived'
export const DEFAULT_TEMPLATE = [
  'Work on Shortcut story sc-{{story_id}}: {{story_name}}',
  '{{story_url}}',
  '',
  '{{story_description}}',
  '',
  '{{story_tasks}}',
  '',
  'Follow the repository instructions, run the relevant checks, and summarize your changes.'
].join('\n')
/** Template variables filled from the story's detail, fetched at Start only when the template uses one. */
export const DETAIL_VARIABLES = ['{{story_description}}', '{{story_comments}}', '{{story_tasks}}'] as const
export const DEFAULT_PREFS: Prefs = { query: DEFAULT_QUERY, template: DEFAULT_TEMPLATE, projects: {} }

/** A Shortcut story, with what the panel shows and filters by. */
export type Story = {
  id: number
  name: string
  url: string
  type: string
  /** Workflow state name, and its kind: unstarted, started or done. */
  state: string | null
  stateType: string | null
  /** The story's workflow and state ids, for moving it to another state. */
  workflowId: number | null
  stateId: number | null
  labels: string[]
  estimate: number | null
  epicId: number | null
  iterationId: number | null
  /** Member ids. */
  requesterId: string | null
  ownerIds: string[]
  /** The value id of the workspace's Priority field, when set. */
  priorityId: string | null
  /** Shortcut's flag: another story that is not done blocks this one. */
  blocked: boolean
  /** The branch name Shortcut formats from the workspace's VCS settings, e.g. `feature/sc-123/title`. */
  branch: string | null
  /** Branches already linked to the story in Shortcut (any repository), newest first. */
  existingBranches: string[]
}

/** A workflow state the story can move to. */
export type StateOption = { id: number; name: string; type: string | null }

/** The workspace's Priority custom field and its values, most urgent first. */
export type PriorityField = { fieldId: string; values: { id: string; name: string }[] }

/** What the Details pickers offer; fetched when a card opens, cached a few minutes by the worker. */
export type StoryOptions = {
  /** Epics not done, by name. */
  epics: { id: number; name: string }[]
  /** Every iteration by start date; `done` ones are offered only when a story is in one. */
  iterations: { id: number; name: string; done: boolean }[]
  /** Active members, by mention name. */
  members: { id: string; mention: string }[]
}

/** A change to a story; absent fields stay as they are, `null` clears. */
export type StoryPatch = {
  stateId?: number
  estimate?: number | null
  type?: 'feature' | 'bug' | 'chore'
  priorityId?: string | null
  epicId?: number | null
  iterationId?: number | null
  requesterId?: string
  ownerIds?: string[]
}

/** What the story's expanded card shows, fetched when it opens. */
export type StoryDetail = {
  /** Markdown, cut to `DESCRIPTION_LIMIT` characters. */
  description: string
  /** Oldest first, with the author's mention name. */
  comments: { author: string; text: string; at: string }[]
  /** The story's checklist, in Shortcut's order. */
  tasks: { id: number; description: string; complete: boolean }[]
  /** Stories linked as blocking this one. */
  blockers: { id: number; url: string }[]
}

export type SortKey = 'shortcut' | 'state' | 'priority' | 'estimate'

/** What Start did besides the worktree. */
export type StartResult = {
  /** The existing branch Start took up, when it did not create one. */
  reused: string | null
  /** The state the story moved to. */
  moved: StateOption | null
  /** Something that went wrong after the worktree was made, worth telling. */
  warning: string | null
}

/** The live Orca worktree whose branch carries a story's `sc-<id>`, and the agent running in it. */
export type Session = { worktreeId: string; name: string; agent: string | null }

/** What the panel shows: the focused workspace's project and the stories its search finds. */
export type Board =
  | { kind: 'no-project' }
  | { kind: 'no-token' }
  /** The board could not load; `message` says why and what to do. */
  | { kind: 'error'; message: string }
  | {
      kind: 'ready'
      project: ProjectRef
      /** The search as sent to Shortcut, with `{{me}}` filled in. */
      query: string
      stories: Story[]
      /** True when Shortcut found more stories than the panel shows. */
      truncated: boolean
      sessions: Record<number, Session>
      /** Every workflow state, in workflow order, for the state filter. */
      states: string[]
      /** The states of each workflow by workflow id, in workflow order. */
      workflowStates: Record<number, StateOption[]>
      /** The Priority field, or null when the workspace has none. */
      priority: PriorityField | null
      /** The member id of the token's member, offered first among owners. */
      viewerId: string
      /** The workspace's estimate scale, for the estimate picker. */
      estimateScale: number[]
      /** The mention name of the token's member. */
      viewer: string
    }

export type TokenResult = { ok: true; viewer: string } | { ok: false; message: string }

declare module 'orca' {
  interface PluginRequests {
    /** The project of the worktree selected in the sidebar, fast: no Shortcut call. */
    'project.active': { output: ProjectRef | null }
    /** The stories for the project of the focused workspace. */
    'board.load': { input: { projectId: string }; output: Board }
    /** Creates a worktree on the story's branch and starts the default agent on the rendered template. */
    'story.start': { input: { projectId: string; story: Story }; output: StartResult }
    /** The description and comments of a story. */
    'story.detail': { input: { storyId: number }; output: StoryDetail }
    /** Epics, iterations and members for the Details pickers. */
    'story.options': { output: StoryOptions }
    /** Changes a story's fields in Shortcut; other custom fields are kept. */
    'story.update': { input: { storyId: number; patch: StoryPatch }; output: null }
    /** Adds a comment to a story, signed by the token's member. */
    'story.comment': { input: { storyId: number; text: string }; output: { author: string; text: string; at: string } }
    /** Ticks or unticks a story task. */
    'story.task': { input: { storyId: number; taskId: number; complete: boolean }; output: null }
    /** Shows the worktree in Orca. */
    'worktree.open': { input: { worktreeId: string }; output: null }
    /** Checks a token against Shortcut and stores it when it works. */
    'token.set': { input: { token: string }; output: TokenResult }
    /** Forgets the stored token. */
    'token.clear': { output: null }
  }
}
