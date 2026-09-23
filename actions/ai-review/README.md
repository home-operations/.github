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
    types: [opened, reopened, ready_for_review]
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
      ${{ (github.event_name == 'pull_request' && github.event.pull_request.user.type != 'Bot')
      || (github.event_name == 'issue_comment' && github.event.issue.pull_request
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

| Input             | Default                        | Description                                                        |
| ----------------- | ------------------------------ | ------------------------------------------------------------------ |
| `llm-api-key`     |                                | API key for the LLM endpoint (required)                            |
| `llm-base-url`    | `https://openrouter.ai/api/v1` | Base URL of the OpenAI-compatible LLM endpoint                     |
| `llm-model`       | `anthropic/claude-sonnet-5`    | Model the endpoint should review with                              |
| `request-changes` | `false`                        | Submit a blocking REQUEST_CHANGES review on high severity findings |

## Behaviour

- A pull request is reviewed once when it is opened, reopened or marked ready for review.
  Later pushes are not re-reviewed; comment `/robin` on the pull request to ask for another
  pass. Robin only honours the command from users with write access or higher.
- The `if:` guard in the example skips automatic reviews of bot pull requests (Renovate,
  release-please) and drops comment triggers before a runner is spent on them. A maintainer
  can still comment `/robin` on a bot pull request.
- `request-changes` defaults to `false` so findings never block the pull request. A
  REQUEST_CHANGES review from `github-actions[bot]` would hold auto-merge and evict merge
  queue entries.
- Robin sends the pull request diff to the configured endpoint. Pull requests from forks do
  not receive secrets, so they are only reviewed when a maintainer comments `/robin`.
- Per-repository tuning lives on the base branch: `.github/robin.yml` for limits such as
  `max-diff-size` and `skip-paths`, and `.github/code-reviewer.md` for extra reviewer
  instructions. See Robin's [advanced guide](https://github.com/antongulin/robin/blob/main/docs/ADVANCED.md).
