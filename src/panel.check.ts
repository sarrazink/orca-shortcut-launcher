// `orca plugin check` renders the panel once per scenario, with these answers for its requests.
import { defineCheck } from 'orca/testing'
import { DETAIL, EMPTY, OPTIONS, PROJECT, READY, STARTED } from './fixtures'
import type { Board } from './protocol'

const answers = (board: Board) => ({
  'project.active': () => PROJECT,
  'board.load': () => board,
  'story.start': () => ({ reused: null, moved: null, warning: null }),
  'worktree.open': () => null,
  'story.detail': () => DETAIL,
  'story.options': () => OPTIONS,
  'story.update': () => null,
  'story.comment': () => ({ author: 'kevin', text: 'Estimated', at: '2026-11-09T10:00:00Z' }),
  'story.task': () => null,
  'token.set': () => ({ ok: true as const, viewer: 'kevin' }),
  'token.clear': () => null
})

export default defineCheck({
  noToken: { requests: answers({ kind: 'no-token' }) },
  ready: { requests: answers(READY) },
  started: { requests: answers(STARTED) },
  empty: { requests: answers(EMPTY) },
  error: { requests: answers({ kind: 'error', message: 'Shortcut refused the token.' }) }
})
