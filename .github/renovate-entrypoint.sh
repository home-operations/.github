#!/usr/bin/env bash
set -euo pipefail

# node/npm are intentionally not installed here. Renovate's mise manager
# provisions its own resolver tools (node, npm, golang, ruby) during `mise lock`
# as of renovate/renovate 43.247+ (renovatebot/renovate#44174) — that is what
# our `npm:oxfmt` mise tool needs to resolve. helm-docs/helm-schema below are
# not Renovate-provided, so they stay.

# renovate: datasource=github-releases depName=norwoodj/helm-docs
HELM_DOCS_VERSION=1.14.2
curl -fsSL \
    "https://github.com/norwoodj/helm-docs/releases/download/v${HELM_DOCS_VERSION#v}/helm-docs_${HELM_DOCS_VERSION#v}_Linux_x86_64.tar.gz" \
        | tar -xz -C /usr/local/bin helm-docs
helm-docs --version

# renovate: datasource=github-releases depName=dadav/helm-schema
HELM_SCHEMA_VERSION=0.23.4
curl -fsSL \
    "https://github.com/dadav/helm-schema/releases/download/${HELM_SCHEMA_VERSION#v}/helm-schema_${HELM_SCHEMA_VERSION#v}_Linux_x86_64.tar.gz" \
        | tar -xz -C /usr/local/bin helm-schema
helm-schema --version

runuser -u ubuntu renovate
