# workflow-lint

Lints workflows and action definitions with [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://github.com/zizmorcore/zizmor).

## Usage

The action lints the working directory, so the repository must be checked out first.

```yaml
jobs:
  workflow-lint:
    name: Workflow Lint
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@<sha> # v7.0.1
        with:
          persist-credentials: false

      - name: Lint workflows
        uses: home-operations/.github/actions/workflow-lint@<sha> # workflow-lint-0.1.0
```

Reference it by commit SHA. A branch or tag reference trips zizmor's `unpinned-uses` audit in the calling repository.

## Inputs

| Input                | Default  | Description                  |
| -------------------- | -------- | ---------------------------- |
| `actionlint-version` | `latest` | Version of actionlint to run |
| `zizmor-version`     | `latest` | Version of zizmor to run     |

## Behaviour

- actionlint runs with `-shellcheck=`. Inline `run:` blocks are not shell-linted, because actionlint invokes shellcheck with `--norc` and a repository's `.shellcheckrc` can never apply to them.
- Two `-ignore` regexes suppress actionlint's errors for parallel steps (`background:`, `wait:`) until [rhysd/actionlint#694](https://github.com/rhysd/actionlint/pull/694) ships in a release.
- zizmor runs online with `${{ github.token }}`, so the API-backed audits such as impostor commits and known-vulnerable actions are active. The lefthook pre-commit hook runs `--offline` and does not cover those.
- zizmor runs even when actionlint fails, so a single run reports both.
