#!/usr/bin/env bash
# Mark, revive and close stale issues and pull requests across the whole org.
#
# GitHub's search API is org-scoped, so one query covers every repository. That
# is why this replaces a per-repository actions/stale workflow rather than
# calling it: actions/stale reads owner and repo from the run context
# (context.repo) with no input to override it, and GITHUB_REPOSITORY cannot be
# reassigned from a workflow because the runner ignores writes to GITHUB_*.
set -Eeuo pipefail

: "${GH_TOKEN:?}"
: "${ORG:?}"

DAYS_BEFORE_STALE="${DAYS_BEFORE_STALE:-60}"
DAYS_BEFORE_CLOSE="${DAYS_BEFORE_CLOSE:-7}"
STALE_LABEL="${STALE_LABEL:-stale}"
DRY_RUN="${DRY_RUN:-false}"

# Applying the label bumps updated_at, so a freshly marked item reports
# updated_at at the same instant as its labeled event. Only treat an item as
# revived once the gap exceeds the skew between those two writes.
readonly UNSTALE_GRACE_SECONDS=120

stale_before="$(date -u -d "${DAYS_BEFORE_STALE} days ago" +%F)"
close_before="$(date -u -d "${DAYS_BEFORE_CLOSE} days ago" +%F)"

run() {
  if [[ "${DRY_RUN}" == "true" ]]; then
    printf '    would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

# Raw qualifiers go after `--` so the leading `-` of a negated one is not read
# as a flag.
search() {
  gh search issues \
    --owner "${ORG}" \
    --state open \
    --include-prs \
    --limit 100 \
    --json repository,number,isPullRequest,updatedAt,url \
    "$@"
}

noun_for() {
  [[ "$1" == "true" ]] && printf 'pull request' || printf 'issue'
}

stale_body() {
  cat <<EOF
This $1 has been marked as stale due to ${DAYS_BEFORE_STALE} days of inactivity. Please remove the stale label or leave a comment to keep it open.
If no action is taken, it will be automatically closed in ${DAYS_BEFORE_CLOSE} days.
EOF
}

close_body() {
  printf 'This %s has been automatically closed after %s days of inactivity following the stale status.\n' \
    "$1" "${DAYS_BEFORE_CLOSE}"
}

# Runs before marking so an item that saw activity loses the label instead of
# being closed on the same pass.
unstale() {
  printf '==> Reviving items active since they were marked\n'

  search -- "label:${STALE_LABEL}" \
    | jq -r '.[] | [.repository.nameWithOwner, .number, .updatedAt, .url] | @tsv' \
    | while IFS=$'\t' read -r repo number updated_at url; do
      local labeled_at
      labeled_at="$(gh api "repos/${repo}/issues/${number}/timeline" --paginate \
        --jq ".[] | select(.event == \"labeled\" and .label.name == \"${STALE_LABEL}\") | .created_at" \
        | tail -1)"

      # Labelled by hand rather than by this script; leave it alone.
      [[ -n "${labeled_at}" ]] || continue

      if (($(date -u -d "${updated_at}" +%s) - $(date -u -d "${labeled_at}" +%s) > UNSTALE_GRACE_SECONDS)); then
        printf '  revive %s\n' "${url}"
        run gh api -X DELETE "repos/${repo}/issues/${number}/labels/${STALE_LABEL}" --silent
      fi
    done
}

# Comment first, then label: the label has to be the last write so that
# updated_at and the labeled event line up for unstale().
mark() {
  printf '==> Marking items untouched since %s\n' "${stale_before}"

  search --updated "<${stale_before}" -- "-label:${STALE_LABEL}" \
    | jq -r '.[] | [.repository.nameWithOwner, .number, .isPullRequest, .url] | @tsv' \
    | while IFS=$'\t' read -r repo number is_pr url; do
      printf '  mark %s\n' "${url}"
      run gh api "repos/${repo}/issues/${number}/comments" \
        -f "body=$(stale_body "$(noun_for "${is_pr}")")" --silent
      run gh api "repos/${repo}/issues/${number}/labels" \
        -f "labels[]=${STALE_LABEL}" --silent
    done
}

# Marking set updated_at, so "labelled and untouched since close_before" is the
# same thing as "stale for DAYS_BEFORE_CLOSE days".
close() {
  printf '==> Closing items marked before %s\n' "${close_before}"

  search --updated "<${close_before}" -- "label:${STALE_LABEL}" \
    | jq -r '.[] | [.repository.nameWithOwner, .number, .isPullRequest, .url] | @tsv' \
    | while IFS=$'\t' read -r repo number is_pr url; do
      printf '  close %s\n' "${url}"
      if [[ "${is_pr}" == "true" ]]; then
        run gh pr close "${number}" --repo "${repo}" \
          --comment "$(close_body 'pull request')" --delete-branch
      else
        run gh issue close "${number}" --repo "${repo}" \
          --comment "$(close_body 'issue')" --reason "not planned"
      fi
    done
}

if [[ "${DRY_RUN}" == "true" ]]; then
  printf 'Dry run: no writes will be made\n'
fi

unstale
mark
close
