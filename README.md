# Shortcut Launcher

Start your [Shortcut](https://www.shortcut.com) stories from [Orca](https://github.com/stablyai/orca).
A side panel lists the stories your saved search finds; **Start** opens a story in its own branch
and worktree, with your default coding agent and a prompt built from your template.

## Features

- **Your stories, in Orca.** A Shortcut search per project (default: `owner:{{me}} !is:done !is:archived`),
  with state, type and label filters.
- **Branches Shortcut recognises.** Start uses the branch name Shortcut formats for the story
  (`feature/sc-123/title`, from your workspace's VCS settings), so Shortcut's GitHub, GitLab or
  Bitbucket integration links the branch and its merge request to the story on its own.
- **Any Git host.** Works with every Orca project, not only GitHub ones.
- **Running work at a glance.** A story whose `sc-<id>` branch has a worktree shows it, and the agent
  running in it. Worktrees you created by hand on such a branch count too.
- **Details without leaving Orca.** Open a card's Details for the description and comments, in
  Markdown, and edit the story's fields in the order Shortcut's own sidebar uses: state, type,
  estimate, priority, epic, iteration, requester and owners. The card itself only adds a badge for
  High and Highest priority.
- **Prompts per project.** Variables: `{{story_url}}`, `{{story_id}}`, `{{story_name}}`, `{{branch}}`,
  and `{{story_description}}`, `{{story_tasks}}`, `{{story_comments}}`, read from Shortcut at Start
  only when the template uses them. The default prompt carries the description and tasks, so the
  agent needs no Shortcut access of its own.
- **Start picks up where the story is.** A story not started yet moves to its first started state
  (choose another, or none, under On Start). When the story already has a branch, in your clone or
  on the remote, Start opens the worktree on it instead of making a new one.
- **Tasks, blockers, comments.** Tick the story's tasks, see what blocks it, and comment from Details.
  A Blocked badge marks blocked stories on the list, and the list sorts by state, priority or estimate.

## Get started

Requires **Orca 1.4.248+**.

1. Load the plugin (see Development) and open **Shortcut**, the rocket panel in the right sidebar.
2. Create a token in Shortcut → Settings → API Tokens and paste it. The plugin checks it against
   Shortcut, then stores it in Orca's encrypted secrets (OS keychain).
3. Select a workspace in Orca's sidebar, adjust its search under **Search** if needed, and press
   **Start** on a story.

## What it runs

The plugin runs code on your machine, so Orca asks you to approve it. It:

- calls the Shortcut REST API v3 with your token: `/member`, `/workflows`, `/custom-fields`,
  `/search/stories`, `/search/epics`, `/iterations`, `/members` and `/stories/<id>` to read; it
  changes a story when you edit a field, tick a task or comment in its Details, and when Start
  moves it (`PUT /stories/<id>`, `PUT /stories/<id>/tasks/<id>`, `POST /stories/<id>/comments`). A priority change
  first reads the story's custom fields and sends the others back unchanged, since Shortcut replaces
  the whole set
- lists projects and worktrees, finds a story's branches (`orca repo search-refs`) and creates
  worktrees with the Orca CLI (`orca-ide` on Linux); runs `git fetch`, `git checkout` and
  `git branch -D` in the new worktree only when it takes up an existing branch
- shows a story's worktree in Orca when you open it (`workspace:read`, `workspace:write`)
- reads your default agent from Orca's settings

It shows up to 100 stories per search.

## Known limits

- Orca's CLI cannot make a worktree on a branch that exists. To take one up, Start has Orca make the
  worktree from it, switches the worktree to the existing branch with `git checkout`, deletes the
  branch Orca named, then launches the agent.

## Development

```sh
nvm use                     # Node 22+: the settings tests use node:sqlite
npm install                 # TypeScript and Node typings, for type-checking only
orca plugin types .         # Orca's typings into .orca/types (broken in Orca 1.4.248: its bundle lacks them)
npx tsc -p .
orca plugin test .
orca plugin check .
orca plugin dev watch .
```

## Credits

Adapted from [Task Launcher](https://github.com/rr235/orca-task-launcher) by rr235 (MIT): the panel
and worker structure, the Orca CLI helpers and the default-agent lookup.

## License

[MIT](LICENSE)
