# renovate-regenerate

Regenerates committed files on Renovate pull requests and pushes them to the pull request branch. The Mend-hosted Renovate app cannot run `postUpgradeTasks`, so a dependency bump that feeds generated output (a chart README, a values schema, a bundled `dist/`) would otherwise fail the repository's drift check.

It is two actions, run in two jobs:

- `renovate-regenerate` checks out the pull request head, runs a mise task and uploads the changes to `paths` as a patch artifact. It never sees a write token.
- `renovate-regenerate/push` mints a GitHub App token, applies the patch, rejects it if it changes anything outside `paths`, and commits it to the branch as the App's bot user through the GraphQL `createCommitOnBranch` mutation.

The task runs dependency code (`npm ci`, `go run`, tool binaries Renovate just bumped), so keeping it out of the job that holds the token means nothing it leaves running can read the token.

## Usage

```yaml
---
name: Renovate Regenerate

on:
  pull_request:
    branches:
      - main

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  regenerate:
    if: >-
      ${{ github.event.pull_request.user.login == 'renovate[bot]'
      && github.event.pull_request.head.repo.full_name == github.repository }}
    name: Regenerate
    runs-on: ubuntu-26.04
    permissions:
      contents: read
    outputs:
      changed: ${{ steps.regenerate.outputs.changed }}
    steps:
      - name: Regenerate
        id: regenerate
        uses: home-operations/.github/actions/renovate-regenerate@<sha> # renovate-regenerate-v1.0.0
        with:
          task: generate
          paths: |
            charts/*/README.md
            charts/*/values.schema.json

  push:
    if: ${{ needs.regenerate.outputs.changed == 'true' }}
    name: Push
    needs:
      - regenerate
    runs-on: ubuntu-26.04
    permissions:
      contents: read
    steps:
      - name: Push
        uses: home-operations/.github/actions/renovate-regenerate/push@<sha> # renovate-regenerate-v1.0.0
        with:
          client-id: ${{ secrets.BOT_CLIENT_ID }}
          private-key: ${{ secrets.BOT_APP_PRIVATE_KEY }}
          paths: |
            charts/*/README.md
            charts/*/values.schema.json
```

Reference both actions by the same commit SHA. A branch or tag reference trips zizmor's `unpinned-uses` audit in the calling repository.

## Inputs

### renovate-regenerate

| Input   | Required | Description                                                    |
| ------- | -------- | -------------------------------------------------------------- |
| `task`  | yes      | mise task that regenerates the files                           |
| `paths` | yes      | Newline-separated git pathspecs of the generated files to keep |

Output `changed` is `true` when the task changed a file matched by `paths`.

### renovate-regenerate/push

| Input         | Required | Description                                                                         |
| ------------- | -------- | ----------------------------------------------------------------------------------- |
| `client-id`   | yes      | Client ID of the GitHub App that commits                                            |
| `private-key` | yes      | Private key of the GitHub App that commits                                          |
| `paths`       | yes      | Same pathspecs as `renovate-regenerate`; a patch changing anything else is rejected |

## Behaviour

- The commit has to come from a GitHub App, not `GITHUB_TOKEN`. A push made with `GITHUB_TOKEN` does not start a new workflow run, so the required check would never report on the regenerated commit.
- Renovate treats a branch with commits from another author as modified and stops rebasing it. The shared Renovate preset lists the App's bot email in `gitIgnoredAuthors` so it keeps rebasing.
- Renovate rebuilds its branch from the base branch when it rebases, dropping the regenerated commit, so the workflow runs again and pushes a fresh one. A run on an already regenerated head finds nothing to change and stops.
- Set `paths` to what the repository's drift check compares, and pass the same list to both actions. Other files the task touches, such as a mise lockfile, are not committed. Every pathspec has to match a file in the repository, or `git add` fails.
- The push job checks the patch against its own `paths` because the patch comes from the job that ran dependency code, which could have replaced it.
- The commit is created through the API, so GitHub signs it, and it carries the pull request's head SHA as `expectedHeadOid`: if Renovate pushed in the meantime, the commit is refused and the run for the new head takes over.
