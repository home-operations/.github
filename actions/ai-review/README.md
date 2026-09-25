# ai-review

Reviews a pull request with [Robin](https://github.com/antongulin/robin) through an
OpenAI-compatible LLM endpoint. Robin posts a summary comment plus inline comments on
changed lines, and says so when it finds nothing worth flagging.

## Usage

The action reads the pull request through the API, so no checkout is needed. The job
needs `actions: read` (Robin detects when a cancelled run was superseded), `contents: read`
and `pull-requests: write`.

```yaml
name: AI Review

on:
  pull_request:
    types: [opened, synchronize, reopened, ready_for_review]
  issue_comment:
    types: [created]

concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || github.event.issue.number }}
  cancel-in-progress: true

permissions:
  contents: read

jobs:
  review:
    if: >-
      ${{ (github.event_name == 'pull_request'
      && !github.event.pull_request.head.repo.fork
      && !github.event.pull_request.draft
      && (github.event.action != 'synchronize' || github.event.pull_request.user.type != 'Bot'))
      || (github.event_name == 'issue_comment'
      && startsWith(github.event.comment.body, '/robin')
      && contains(fromJSON('["OWNER", "MEMBER", "COLLABORATOR"]'), github.event.comment.author_association)) }}
    name: AI Review
    runs-on: ubuntu-26.04
    timeout-minutes: 15
    permissions:
      actions: read
      contents: read
      pull-requests: write
    steps:
      - name: Review
        uses: home-operations/.github/actions/ai-review@<sha> # ai-review-v1.0.0
        with:
          llm-api-key: ${{ secrets.LLM_API_KEY }}
```

Reference it by commit SHA. A branch or tag reference trips zizmor's `unpinned-uses` audit in
the calling repository.

## Inputs

| Input          | Default                        | Description                                    |
| -------------- | ------------------------------ | ---------------------------------------------- |
| `llm-api-key`  |                                | API key for the LLM endpoint (required)        |
| `llm-base-url` | `https://openrouter.ai/api/v1` | Base URL of the OpenAI-compatible LLM endpoint |
| `llm-model`    | `openai/gpt-6-sol`             | Model the endpoint should review with          |

## Behaviour

- A pull request is reviewed when it is opened, reopened, marked ready for review or pushed
  to. A review still running when the next push lands is cancelled. The example guard keeps
  bot pull requests to one review on open, since Renovate rebases its open pull requests
  whenever the default branch moves and each rebase is a `synchronize` event on an
  unchanged diff. Comment `/robin` to ask for another pass at any time; Robin only honours
  the command from users with write access or higher.
- The `if:` guard in the example reviews every non-draft pull request that does not come
  from a fork, bots included, and drops comment triggers from non-members before a runner
  is spent on them. Everything else (comments on issues, unknown commands, bot comments,
  commenters without write access) Robin rejects on its own.
- Findings never block the pull request. A REQUEST_CHANGES review from
  `github-actions[bot]` would hold auto-merge and evict merge queue entries, so Robin posts
  a plain comment.
- Robin sends the pull request diff to the configured endpoint. Pull requests from forks do
  not receive secrets on `pull_request` events, so the guard skips them; a maintainer
  reviews a fork by commenting `/robin`, which runs with the base repository's secrets.
- Per-repository tuning lives on the base branch: `.github/robin.yml` for limits such as
  `max-diff-size`, `skip-paths` and `reasoning-effort`, and `.github/code-reviewer.md` for
  extra reviewer instructions. See Robin's
  [advanced guide](https://github.com/antongulin/robin/blob/main/docs/ADVANCED.md).
