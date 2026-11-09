// Boards shared by the panel test and `orca plugin check` scenarios.
import type { Board, PriorityField, Story, StoryDetail, StoryOptions } from './protocol'

export const PRIORITY: PriorityField = {
  fieldId: 'f-priority',
  values: [
    { id: 'p-highest', name: 'Highest' },
    { id: 'p-high', name: 'High' },
    { id: 'p-medium', name: 'Medium' }
  ]
}
export const OPTIONS: StoryOptions = {
  epics: [{ id: 100, name: 'Acme Billing' }, { id: 101, name: 'Monitoring' }],
  iterations: [
    { id: 199, name: 'Sprint 18', done: true },
    { id: 200, name: 'Sprint 19', done: false },
    { id: 201, name: 'Sprint 20', done: false }
  ],
  members: [
    { id: 'u-kevin', mention: 'kevin' },
    { id: 'u-alice', mention: 'alice' },
    { id: 'u-bob', mention: 'bob' }
  ]
}
export const PROJECT = { id: 'git:gitlab.com/acme/api', name: 'api' }
export const STORY: Story = {
  id: 13873,
  name: 'Acme Billing — receive heat pump events',
  url: 'https://app.shortcut.com/acme/story/13873',
  type: 'feature',
  state: 'In Progress',
  stateType: 'started',
  workflowId: 1,
  stateId: 11,
  labels: ['back'],
  estimate: 3,
  epicId: 100,
  iterationId: 200,
  requesterId: 'u-alice',
  ownerIds: ['u-kevin'],
  priorityId: 'p-high',
  blocked: false,
  branch: 'feature/sc-13873/acme-billing-receive-heat-pump',
  existingBranches: []
}
export const BUG: Story = {
  ...STORY,
  id: 11801,
  name: 'Gas subscription share is wrong',
  url: 'https://app.shortcut.com/acme/story/11801',
  type: 'bug',
  state: 'To Do',
  stateType: 'unstarted',
  stateId: 10,
  labels: [],
  estimate: null,
  epicId: null,
  iterationId: null,
  ownerIds: [],
  priorityId: null,
  blocked: true,
  branch: 'bug/sc-11801/gas-subscription-share',
  existingBranches: ['bug/sc-11801/gas-share']
}
export const READY: Board = {
  kind: 'ready',
  project: PROJECT,
  query: 'owner:kevin !is:done !is:archived',
  stories: [STORY, BUG],
  truncated: false,
  sessions: {},
  states: ['To Do', 'In Progress', 'Done'],
  workflowStates: {
    1: [
      { id: 10, name: 'To Do', type: 'unstarted' },
      { id: 11, name: 'In Progress', type: 'started' },
      { id: 12, name: 'Done', type: 'done' }
    ]
  },
  estimateScale: [0, 1, 2, 3, 5, 8],
  priority: PRIORITY,
  viewerId: 'u-kevin',
  viewer: 'kevin'
}
export const STARTED: Board = {
  ...READY,
  sessions: { 13873: { worktreeId: 'r::/w/sc-13873', name: 'sc-13873-acme-billing-receive-heat', agent: 'claude' } }
}
export const EMPTY: Board = {
  kind: 'ready',
  project: PROJECT,
  query: 'owner:kevin !is:done !is:archived',
  stories: [],
  truncated: false,
  sessions: {},
  states: [],
  workflowStates: {},
  estimateScale: [],
  priority: null,
  viewerId: 'u-kevin',
  viewer: 'kevin'
}
export const DETAIL: StoryDetail = {
  description: 'Receive the **heat pump** events from Acme Billing.\n\n- store them\n- show them in the app',
  comments: [{ author: 'alice', text: 'The webhook spec is in the shared drive.', at: '2026-11-02T09:00:00Z' }],
  tasks: [
    { id: 1, description: 'Store the payloads', complete: true },
    { id: 2, description: 'Alert on failures', complete: false }
  ],
  blockers: []
}
