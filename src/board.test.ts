// Pure helpers: branch parsing, sessions, preferences and the worktree create command.
import { assert, test } from 'orca/testing'
import { activeProjectId, branchFor, createArgs, createdWorktree, existingBranch, projectRepoIds, repoPath, startStateFor, startTarget, usesDetail, parseProjectList, prefFor, readPrefs, renderTemplate, sessionsFor, storyIdOf, worktreeName } from './board'
import { DEFAULT_PREFS, type Story } from './protocol'

const STORY: Story = {
  id: 13873,
  name: 'Acme Billing — recevoir les données et événements',
  url: 'https://app.shortcut.com/acme/story/13873',
  type: 'feature',
  state: 'In Progress',
  stateType: 'started',
  workflowId: 1,
  stateId: 11,
  epicId: null,
  iterationId: null,
  requesterId: null,
  ownerIds: [],
  priorityId: null,
  blocked: false,
  labels: [],
  estimate: 3,
  branch: 'feature/sc-13873/acme-billing-recevoir-les-donnees',
  existingBranches: []
}
const PROJECT = 'git:gitlab.com/acme/api'

test('reads the story id Shortcut puts in branch names', () => {
  assert.equal(storyIdOf('refs/heads/feature/sc-13873/webhooks'), 13873)
  assert.equal(storyIdOf('sc-42-fix-login'), 42)
  assert.equal(storyIdOf('kevin/SC-7'), 7)
  assert.equal(storyIdOf('main'), null)
  assert.equal(storyIdOf('disc-12-thing'), null)
  assert.equal(storyIdOf(null), null)
})

test('keeps every project, not only GitHub ones', () => {
  const json = JSON.stringify({ result: { projects: [
    { id: 'git:gitlab.com/acme/api', displayName: 'api', providerIdentity: null },
    { id: 'github:acme/web', displayName: 'Web', providerIdentity: { owner: 'acme', repo: 'web' } },
    { id: 'broken' }
  ] } })
  assert.deepEqual(parseProjectList(json), [{ id: 'git:gitlab.com/acme/api', name: 'api' }, { id: 'github:acme/web', name: 'Web' }])
})

test('finds the active project and the worktree of each story by branch', () => {
  const list = JSON.stringify({ result: { worktrees: [
    { id: 'r::/main', projectId: PROJECT, displayName: 'main', branch: 'refs/heads/main' },
    { id: 'r::/a', projectId: PROJECT, displayName: 'sc-13873-acme', branch: 'refs/heads/feature/sc-13873/billing' },
    { id: 'r::/b', projectId: PROJECT, displayName: 'old', branch: 'refs/heads/sc-5', isArchived: true },
    { id: 'o::/c', projectId: 'other', displayName: 'other', branch: 'refs/heads/sc-9' }
  ] } })
  const ps = JSON.stringify({ result: { worktrees: [
    { worktreeId: 'r::/main', isActive: true },
    { worktreeId: 'r::/a', agents: [{ agentType: 'claude' }] }
  ] } })
  assert.equal(activeProjectId(ps, list), PROJECT)
  assert.deepEqual(sessionsFor(PROJECT, list, ps), { 13873: { worktreeId: 'r::/a', name: 'sc-13873-acme', agent: 'claude' } })
})

test('uses the branch Shortcut formats, or builds one that carries sc-<id>', () => {
  assert.equal(branchFor(STORY), 'feature/sc-13873/acme-billing-recevoir-les-donnees')
  assert.equal(branchFor({ ...STORY, branch: null }), 'sc-13873-acme-billing-recevoir-les-donnees')
  assert.equal(branchFor({ ...STORY, branch: 'feature/sc-1/other-story' }), 'sc-13873-acme-billing-recevoir-les-donnees')
  assert.equal(worktreeName(STORY), 'sc-13873-acme-billing-recevoir-les')
})

test('builds the worktree create command on the story branch', () => {
  assert.deepEqual(createArgs({ projectId: PROJECT, story: STORY, agent: 'claude', prompt: 'Go' }), [
    'worktree', 'create', '--project', PROJECT, '--name', 'sc-13873-acme-billing-recevoir-les',
    '--branch', 'feature/sc-13873/acme-billing-recevoir-les-donnees', '--comment', STORY.url,
    '--no-parent', '--json', '--agent', 'claude', '--prompt', 'Go'
  ])
  assert.equal(createArgs({ projectId: PROJECT, story: STORY, agent: null, prompt: 'Go' }).includes('--agent'), false)
})

test('reads preferences defensively and falls back per project', () => {
  assert.deepEqual(readPrefs(null), DEFAULT_PREFS)
  assert.deepEqual(readPrefs('junk'), DEFAULT_PREFS)
  const prefs = readPrefs({ query: 'team:Back', template: 'T', projects: { [PROJECT]: { query: 'label:api', template: '  ' }, bad: 3 } })
  assert.equal(prefFor(prefs, PROJECT, 'query'), 'label:api')
  assert.equal(prefFor(prefs, PROJECT, 'template'), 'T')
  assert.equal(prefFor(prefs, 'elsewhere', 'query'), 'team:Back')
  assert.equal(prefFor(readPrefs({ query: '', template: '', projects: {} }), 'x', 'query'), DEFAULT_PREFS.query)
})

test('fills the prompt template', () => {
  assert.equal(
    renderTemplate('{{story_id}} {{story_name}} {{story_url}} {{branch}}', STORY),
    `13873 ${STORY.name} ${STORY.url} feature/sc-13873/acme-billing-recevoir-les-donnees`
  )
})

const refs = (list: string[]) => JSON.stringify({ result: { refs: list } })

test('takes up a local branch first, then one Shortcut knows, else none', () => {
  const story = { id: 13873, existingBranches: ['feature/sc-13873/new-name', 'feature/sc-999/other'] }
  assert.deepEqual(existingBranch(story, refs(['refs/heads/feature/sc-13873/webhooks', 'refs/heads/main'])), {
    name: 'feature/sc-13873/webhooks',
    local: true
  })
  assert.deepEqual(existingBranch(story, refs([])), { name: 'feature/sc-13873/new-name', local: false })
  assert.deepEqual(existingBranch(story, refs(['refs/heads/feature/sc-13873/new-name'])), { name: 'feature/sc-13873/new-name', local: true })
  assert.deepEqual(existingBranch({ id: 5, existingBranches: [] }, refs(['refs/remotes/origin/bug/sc-5/x'])), { name: 'bug/sc-5/x', local: false })
  assert.equal(existingBranch({ id: 5, existingBranches: [] }, refs(['refs/heads/sc-55-other', 'refs/tags/sc-5'])), null)
})

test('reads project repos, repo paths and the created worktree', () => {
  assert.deepEqual(projectRepoIds(JSON.stringify({ result: { projects: [{ id: 'git:x', sourceRepoIds: ['r1', 'r2'] }] } })), { 'git:x': ['r1', 'r2'] })
  assert.equal(repoPath(JSON.stringify({ result: { repos: [{ id: 'r1', path: '/w/api' }] } }), 'r1'), '/w/api')
  assert.deepEqual(createdWorktree(JSON.stringify({ result: { worktree: { path: '/w/sc-1', branch: 'refs/heads/kevin/sc-1' } } })), {
    path: '/w/sc-1',
    branch: 'kevin/sc-1'
  })
  const args = createArgs({ projectId: 'git:x', story: STORY, agent: null, prompt: '', base: 'origin/feature/sc-13873/x' })
  assert.ok(args.includes('--base-branch') && !args.includes('--branch'))
})

test('moves only a story not started, to the chosen started state', () => {
  const states = [
    { id: 10, name: 'To Do', type: 'unstarted' },
    { id: 11, name: 'In Progress', type: 'started' },
    { id: 12, name: 'In Review', type: 'started' }
  ]
  const todo = { stateType: 'unstarted', stateId: 10 }
  assert.equal(startTarget(todo, states, 'first-started')?.id, 11)
  assert.equal(startTarget(todo, states, '=In Review')?.id, 12)
  assert.equal(startTarget(todo, states, 'none'), null)
  assert.equal(startTarget({ stateType: 'started', stateId: 12 }, states, 'first-started'), null)
  assert.equal(startTarget(todo, states, '=Gone'), null)
  assert.equal(startStateFor(readPrefs({ projects: { p: { startState: '=In Review' } } }), 'p'), '=In Review')
  assert.equal(startStateFor(readPrefs({ projects: { p: { startState: 'bogus' } } }), 'p'), 'first-started')
})

test('fills the description, tasks and comments, and drops empty lines they leave', () => {
  const detail = {
    description: 'Do it.',
    comments: [{ author: 'alice', text: 'Line one\nline two', at: '' }],
    tasks: [{ id: 1, description: 'Store', complete: true }, { id: 2, description: 'Alert', complete: false }],
    blockers: []
  }
  const template = '{{story_name}}\n\n{{story_description}}\n\n{{story_tasks}}\n\n{{story_comments}}\n\nGo.'
  assert.equal(
    renderTemplate(template, STORY, detail),
    `${STORY.name}\n\nDo it.\n\nTasks:\n- [x] Store\n- [ ] Alert\n\nComments:\n- @alice: Line one line two\n\nGo.`
  )
  assert.equal(renderTemplate(template, STORY, null), `${STORY.name}\n\nGo.`)
  assert.ok(usesDetail(template))
  assert.ok(!usesDetail('{{story_url}}'))
})
