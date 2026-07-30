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

# Comma-separated labels that exempt an item from being marked or closed. Empty
# matches the actions/stale configuration this replaces, which set no exempt-*
# inputs. Exemptions deliberately do not apply to the revive pass: an item that
# becomes exempt after being marked should still shed its label.
EXEMPT_LABELS="${EXEMPT_LABELS:-}"

# Bounds the blast radius of a malformed query, mirroring the intent of
# actions/stale's operations-per-run. Anything over budget is left for the next
# run. Sized for org-wide scope: the 23 workflows this replaces each carried
# their own budget of 30.
OPERATIONS_PER_RUN="${OPERATIONS_PER_RUN:-100}"

# The search API will not return more than this no matter what is asked for.
readonly SEARCH_LIMIT=1000

# Applying the label bumps updated_at, so a freshly marked item reports
# updated_at at the same instant as its labeled event. Only treat an item as
# revived once the gap exceeds the skew between those two writes.
readonly UNSTALE_GRACE_SECONDS=120

stale_before="$(date -u -d "${DAYS_BEFORE_STALE} days ago" +%F)"
close_before="$(date -u -d "${DAYS_BEFORE_CLOSE} days ago" +%F)"

operations=0

warn() {
  printf '::warning::%s\n' "$*"
}

run() {
  operations=$((operations + 1))
  if [[ "${DRY_RUN}" == "true" ]]; then
    printf '    would run: %s\n' "$*"
    return 0
  fi
  "$@"
}

over_budget() {
  if ((operations >= OPERATIONS_PER_RUN)); then
    warn "operations budget of ${OPERATIONS_PER_RUN} reached; remaining items deferred to the next run"
    return 0
  fi
  return 1
}

# Absorbs transient API failures so a rate limit or a 502 does not leave an item
# half processed. Retries consume budget, which is intended.
retry() {
  local attempt=1
  until "$@"; do
    if ((attempt >= 3)); then
      return 1
    fi
    sleep $((attempt * 2))
    attempt=$((attempt + 1))
  done
}

# Labels that exempt an item, as search qualifiers.
exempt_args=()
if [[ -n "${EXEMPT_LABELS}" ]]; then
  IFS=',' read -ra exempt_labels <<<"${EXEMPT_LABELS}"
  for label in "${exempt_labels[@]}"; do
    label="${label#"${label%%[![:space:]]*}"}"
    label="${label%"${label##*[![:space:]]}"}"
    if [[ -n "${label}" ]]; then
      exempt_args+=("-label:${label}")
    fi
  done
fi

# is:unlocked because commenting on a locked item fails; those are skipped
# rather than allowed to abort the run.
search() {
  gh search issues \
    --owner "${ORG}" \
    --state open \
    --include-prs \
    --limit "${SEARCH_LIMIT}" \
    --json repository,number,isPullRequest,updatedAt,url \
    "$@" "is:unlocked"
}

# Warns rather than truncating silently when a pass saturates the search cap.
rows() {
  local json
  json="$(search "$@")"

  if (($(jq -r 'length' <<<"${json}") >= SEARCH_LIMIT)); then
    warn "search returned the ${SEARCH_LIMIT}-result cap; some items were not seen this run"
  fi

  jq -r '.[] | [.repository.nameWithOwner, .number, .isPullRequest, .updatedAt, .url] | @tsv' <<<"${json}"
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

  local items repo number is_pr updated_at url labeled_at
  items="$(rows -- "label:${STALE_LABEL}")"
  [[ -n "${items}" ]] || return 0

  while IFS=$'\t' read -r repo number is_pr updated_at url; do
    over_budget && break

    labeled_at="$(gh api "repos/${repo}/issues/${number}/timeline" --paginate \
      --jq ".[] | select(.event == \"labeled\" and .label.name == \"${STALE_LABEL}\") | .created_at" \
      | tail -1)"

    # Labelled by hand rather than by this script; leave it alone.
    [[ -n "${labeled_at}" ]] || continue

    if (($(date -u -d "${updated_at}" +%s) - $(date -u -d "${labeled_at}" +%s) > UNSTALE_GRACE_SECONDS)); then
      printf '  revive %s\n' "${url}"
      if ! retry run gh api -X DELETE "repos/${repo}/issues/${number}/labels/${STALE_LABEL}" --silent; then
        warn "could not remove ${STALE_LABEL} from ${url}; it will be retried on the next run"
      fi
    fi
  done <<<"${items}"
}

# Comment first, then label. Both writes land inside UNSTALE_GRACE_SECONDS of
# each other either way, so the ordering is chosen for how it fails rather than
# for the revive comparison: commenting first means a failed label leaves an
# item warned but not marked, which never closes. Labelling first would leave an
# item marked but never warned, which closes in DAYS_BEFORE_CLOSE days without
# anyone having been told.
mark() {
  printf '==> Marking items untouched since %s\n' "${stale_before}"

  local items repo number is_pr updated_at url
  items="$(rows --updated "<${stale_before}" -- "-label:${STALE_LABEL}" "${exempt_args[@]}")"
  [[ -n "${items}" ]] || return 0

  while IFS=$'\t' read -r repo number is_pr updated_at url; do
    over_budget && break

    printf '  mark %s\n' "${url}"

    if ! retry run gh api "repos/${repo}/issues/${number}/comments" \
      -f "body=$(stale_body "$(noun_for "${is_pr}")")" --silent; then
      warn "could not comment on ${url}; it will be retried on the next run"
      continue
    fi

    # The comment already moved updated_at out of the stale window, so this item
    # will not be reconsidered for another DAYS_BEFORE_STALE days.
    if ! retry run gh api "repos/${repo}/issues/${number}/labels" \
      -f "labels[]=${STALE_LABEL}" --silent; then
      warn "commented on ${url} but could not apply ${STALE_LABEL}; it needs the label by hand"
    fi
  done <<<"${items}"
}

# Marking set updated_at, so "labelled and untouched since close_before" is the
# same thing as "stale for DAYS_BEFORE_CLOSE days". actions/stale counts from
# the label's creation date instead; the two agree only because the revive pass
# strips the label from anything touched in between.
close() {
  printf '==> Closing items marked before %s\n' "${close_before}"

  local items repo number is_pr updated_at url
  items="$(rows --updated "<${close_before}" -- "label:${STALE_LABEL}" "${exempt_args[@]}")"
  [[ -n "${items}" ]] || return 0

  while IFS=$'\t' read -r repo number is_pr updated_at url; do
    over_budget && break

    printf '  close %s\n' "${url}"
    if [[ "${is_pr}" == "true" ]]; then
      retry run gh pr close "${number}" --repo "${repo}" \
        --comment "$(close_body 'pull request')" --delete-branch \
        || warn "could not close ${url}; it will be retried on the next run"
    else
      retry run gh issue close "${number}" --repo "${repo}" \
        --comment "$(close_body 'issue')" --reason "not planned" \
        || warn "could not close ${url}; it will be retried on the next run"
    fi
  done <<<"${items}"
}

if [[ "${DRY_RUN}" == "true" ]]; then
  printf 'Dry run: no writes will be made\n'
fi

unstale
mark
close

printf '==> %s operation(s) of %s budget\n' "${operations}" "${OPERATIONS_PER_RUN}"
