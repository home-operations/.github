# .github

Org-wide defaults for [home-operations](https://github.com/home-operations). Everything here applies to every repository in the organisation, either because GitHub reads it from this repository by name or because the other repositories pull it in explicitly.

## Composite actions

Shared CI steps, each versioned and tagged on its own. Reference them by commit SHA — a branch or tag reference trips zizmor's `unpinned-uses` audit in the calling repository.

| Action                                   | Purpose                                                              |
| ---------------------------------------- | -------------------------------------------------------------------- |
| [`workflow-lint`](actions/workflow-lint) | Lints workflows and action definitions with actionlint and zizmor    |
| [`docs-build`](actions/docs-build)       | Builds the docs site with mise and uploads the GitHub Pages artifact |

Each has its own README, changelog and `<component>-<version>` tag, so one action's release never moves the other's version.

## Shared configuration

| Path                    | Purpose                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `lefthook.common.toml`  | Pre-commit hooks every repository extends as a lefthook remote, pinned to `main`                          |
| `.github/safe-settings` | Repository settings reconciled across the org by [safe-settings](https://github.com/github/safe-settings) |
| `.github/workflows`     | Org-level automation: Renovate, safe-settings reconciliation, stale issue handling                        |

Because repositories track `lefthook.common.toml` at `main`, a hook added here takes effect everywhere on the next commit. A hook that shells out to a tool needs that tool pinned in each repository's `.mise/config.toml` first.

## Community health files

`CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE`, `.github/pull_request_template.md` and `.github/FUNDING.yml` are served by GitHub to any repository in the org that does not provide its own. A repository-level file always wins.

Note the [AI usage policy](CONTRIBUTING.md#ai-usage-policy) in `CONTRIBUTING.md`: pull requests that are fully or predominantly AI-generated are not accepted.
