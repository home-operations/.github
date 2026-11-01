# workflow-lint

Lints workflows and action definitions with [actionlint](https://github.com/rhysd/actionlint) and [zizmor](https://github.com/zizmorcore/zizmor). Checks JSON, YAML and Markdown formatting with oxfmt.

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
        uses: home-operations/.github/actions/workflow-lint@<sha> # workflow-lint-1.0.0
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
- Two more suppress actionlint's errors for the `$/` self-repository `uses:` syntax until [rhysd/actionlint#711](https://github.com/rhysd/actionlint/issues/711) ships in a release. zizmor already supports it as of 1.29.0.
- One more suppresses actionlint's unknown runner label error for `ubuntu-26.04` and `ubuntu-26.04-arm` until [rhysd/actionlint#682](https://github.com/rhysd/actionlint/issues/682) ships in a release.
- zizmor runs online with `${{ github.token }}`, so the API-backed audits such as impostor commits and known-vulnerable actions are active. The lefthook pre-commit hook runs `--offline` and does not cover those.
- If a repository has a `.lefthook.toml`, lefthook runs the hooks tagged `ci` in `lefthook.common.toml` over every tracked file. If a hook changes a file, the step fails.
- The step reads the lefthook and oxfmt versions from the repository's `.mise/config.toml`. You must pin both tools there.
- If an earlier step fails, zizmor and the formatting check still run. A single run reports all three.
