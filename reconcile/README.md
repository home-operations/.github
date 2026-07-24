# Reconcile

Stateless org reconciler for repository settings, labels, and managed files.
Desired state lives in this directory, live state is the GitHub API, and the
diff is computed on every run — no state file, no plan/apply lifecycle.

Runs from [`.github/workflows/reconcile.yaml`](../.github/workflows/reconcile.yaml)
daily, on pushes touching `reconcile/`, and on manual dispatch (with a dry-run
input). Built with [zx](https://github.com/google/zx) and
[Octokit](https://github.com/octokit/octokit.js).

## How each mode applies

| Mode     | Drift handling                                                   |
| -------- | ---------------------------------------------------------------- |
| settings | PATCHed directly (only the drifted keys)                         |
| labels   | Created / updated / deleted directly                             |
| files    | One PR per repo proposing the change; never merged automatically |

Settings and labels are config with no CI consequences, so they apply
directly. Files (mostly workflows) go through a PR so CI runs and a human
reviews before anything lands.

## Layout

```text
reconcile/
├── config/
│   ├── settings.yaml   # org-wide defaults: excludeRepos, settings, labels
│   └── repos/         # per-repo overrides, one <repo-name>.yaml each
├── files/             # managed file sources, mirroring destination paths
├── files.yaml          # file manifest: what syncs where
└── reconcile.mjs      # the reconciler
```

## Configuration

### `config/settings.yaml`

- `excludeRepos` — repos the reconciler never touches (archived repos are
  always skipped).
- `settings` — camelCase keys (e.g. `deleteBranchOnMerge`) mapped to their
  snake_case field on the
  [Update Repository API](https://docs.github.com/rest/repos/repos#update-a-repository).
  Only listed keys are managed; everything else is left alone. `name`,
  `private`, and `visibility` are refused as too dangerous to automate.
- `labels.include` — labels every repo must have (name, color, description).
  Quote all-digit colors (`"000000"`) so YAML keeps them strings.
- `labels.exclude` — regex patterns for labels other automation owns; matching
  labels are never deleted.

A repo's desired state is these defaults deep-merged with its
`config/repos/<repo-name>.yaml` (same shape): repo settings keys win, label
includes append (same-name overrides), label excludes union.

### `files.yaml`

Each entry under `files:` syncs `reconcile/files/<path>` to `<path>` in its
target repos:

- `path` — destination path (source mirrors it under `files/`)
- `repos` — explicit target list; omit to target every active repo not in
  `excludeRepos`
- `exclude` — repos to skip for this entry
- `state: absent` — propose _removing_ the file instead

All of a repo's drifted files land in a single commit on `branch` (default
`chore/file-sync`) and one PR. The PR is force-updated while drift remains and
closed automatically (branch deleted) once the repo is back in sync — so an
intentionally divergent repo should be added to the entry's `exclude` rather
than leaving its PR open forever.

## Running locally

```sh
cd reconcile && npm ci
GH_TOKEN=$(gh auth token) node reconcile.mjs --dry-run
```

Flags: `--dry-run` (log drift, change nothing), `--only settings,labels,files`,
`--repo <name>[,<name>]`. The workflow passes `DRY_RUN` and `REPO_FILTER` via
dispatch inputs.

## Token permissions

The workflow mints a bot app token with `contents`, `issues`, `pull-requests`,
and `workflows` write. Enabling settings management additionally requires
`administration: write` (commented in the workflow until needed).

## Limitations

- No approval gate for settings/labels — each run enforces (same model as
  safe-settings). Use the dry-run dispatch to preview.
- File-sync commits are not DCO-signed; repos enforcing sign-off on the bot
  need that check relaxed for sync PRs.
- Branch protection and push rules are intentionally out of scope — manage
  those with org rulesets.
