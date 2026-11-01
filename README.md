# .github

Org-wide defaults for [home-operations](https://github.com/home-operations). Everything here applies to every repository in the organisation. GitHub reads some of it from this repository by name, and the other repositories pull in the rest explicitly.

## Composite actions

Shared CI steps, each versioned and tagged on its own. Reference them by commit SHA, because a branch or tag reference trips zizmor's `unpinned-uses` audit in the calling repository.

| Action                                   | Purpose                                                                                             |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [`workflow-lint`](actions/workflow-lint) | Lints workflows and action definitions with actionlint and zizmor, and checks formatting with oxfmt |

Each has its own README, changelog and `<component>-<version>` tag, so one action's release never moves the other's version.

## Shared configuration

| Path                    | Purpose                                                                                                   |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| `lefthook.common.toml`  | Pre-commit hooks every repository extends as a lefthook remote, pinned to `main`                          |
| `renovate-config.json`  | Renovate preset every repository extends as `local>home-operations/.github:renovate-config`               |
| `.github/safe-settings` | Repository settings reconciled across the org by [safe-settings](https://github.com/github/safe-settings) |
| `.github/workflows`     | Org-level automation: Renovate, safe-settings reconciliation, stale issue handling                        |

Because repositories track `lefthook.common.toml` at `main`, a hook added here takes effect everywhere on the next commit. A hook that shells out to a tool needs that tool pinned in each repository's `.mise/config.toml` first.

## Community health files

GitHub serves these files to any org repository without its own copy: `CODE_OF_CONDUCT.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/ISSUE_TEMPLATE`, `.github/pull_request_template.md` and `.github/FUNDING.yml`. A repository-level file always wins.

Note the [AI usage policy](CONTRIBUTING.md#ai-usage-policy) in `CONTRIBUTING.md`: pull requests that are fully or predominantly AI-generated are not accepted.
