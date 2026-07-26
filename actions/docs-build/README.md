# docs-build

Builds a docs site by running the repository's `docs` mise task, and uploads it as a GitHub Pages artifact when deploying.

## Usage

The action builds in the working directory, so the repository must be checked out first. Publishing stays in the calling workflow: `actions/deploy-pages` needs a job `environment` and `pages: write` / `id-token: write`, neither of which a composite action can declare.

```yaml
jobs:
  build:
    name: Build docs site
    runs-on: ubuntu-24.04
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@<sha> # v7.0.1
        with:
          persist-credentials: false

      - name: Build docs site
        uses: home-operations/.github/actions/docs-build@<sha> # docs-build-1.0.0
        with:
          deploy: ${{ inputs.deploy }}

  publish:
    name: Publish to GitHub Pages
    if: ${{ inputs.deploy }}
    needs:
      - build
    runs-on: ubuntu-24.04
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    steps:
      - name: Publish to GitHub Pages
        id: deployment
        uses: actions/deploy-pages@<sha> # v5.0.0
```

Reference it by commit SHA. A branch or tag reference trips zizmor's `unpinned-uses` audit in the calling repository.

## Inputs

| Input    | Default   | Description                                                   |
| -------- | --------- | ------------------------------------------------------------- |
| `deploy` | `"false"` | Configure Pages and upload the built site as a Pages artifact |
| `path`   | `./site`  | Directory the docs task writes the site to                    |

## Behaviour

- The build itself is `mise run docs`, so what gets built is the calling repository's business.
- With `deploy: false` the site is built and thrown away, which is what a pull request wants: the build is verified, nothing is published.
- Repository-specific setup stays in the caller. A Rust project wanting a shared build cache adds its own `Swatinem/rust-cache` step before this one.
