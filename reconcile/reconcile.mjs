#!/usr/bin/env node
// Stateless org reconciler: desired state lives in reconcile/, live state is the
// GitHub API, and the diff is computed on every run. Settings and labels are
// applied directly; managed-file drift is proposed through a PR per repo.
import "zx/globals";
import { Octokit } from "octokit";

const ORG = process.env.GH_ORG ?? "home-operations";
const DRY_RUN = Boolean(argv["dry-run"]) || process.env.DRY_RUN === "true";
const MODES = ["settings", "labels", "files", "rulesets"];
const only = argv.only ? String(argv.only).split(",") : MODES;
const repoFilter = (argv.repo ?? process.env.REPO_FILTER ?? "")
  .split(",")
  .map((r) => r.trim())
  .filter(Boolean);

for (const mode of only) {
  if (!MODES.includes(mode)) {
    console.error(`Unknown mode '${mode}' (valid: ${MODES.join(", ")})`);
    process.exit(1);
  }
}
if (!process.env.GH_TOKEN) {
  console.error("GH_TOKEN is required");
  process.exit(1);
}

const root = path.dirname(new URL(import.meta.url).pathname);
const config = YAML.parse(await fs.readFile(path.join(root, "config/settings.yaml"), "utf8"));
const filesConfig = YAML.parse(await fs.readFile(path.join(root, "files.yaml"), "utf8"));
const rulesetsConfig = YAML.parse(await fs.readFile(path.join(root, "rulesets.yaml"), "utf8"));
const overrides = {};
for (const file of await glob("config/repos/*.yaml", { cwd: root })) {
  overrides[path.basename(file, ".yaml")] = YAML.parse(
    await fs.readFile(path.join(root, file), "utf8"),
  );
}

// name/private/visibility are refused: a typo here must never rename or expose a repo.
const DANGEROUS_SETTINGS = ["name", "private", "visibility"];

const octokit = new Octokit({ auth: process.env.GH_TOKEN });
const summary = [];
const failures = [];
const tag = DRY_RUN ? chalk.yellow("[dry-run]") : chalk.green("[apply]");

const log = (repo, message) => {
  echo(`${tag} ${chalk.cyan(repo)}: ${message}`);
  summary.push(`- **${repo}**: ${message}`);
};

const allRepos = (
  await octokit.paginate(octokit.rest.repos.listForOrg, { org: ORG, per_page: 100 })
).filter((r) => !r.archived && !(config.excludeRepos ?? []).includes(r.name));
const repos = repoFilter.length ? allRepos.filter((r) => repoFilter.includes(r.name)) : allRepos;

echo(`${tag} reconciling ${repos.length} repos in ${ORG} (modes: ${only.join(", ")})`);

// Config uses camelCase keys; the GitHub APIs want snake_case.
const toSnakeCase = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const toSnakeCaseDeep = (value) => {
  if (Array.isArray(value)) return value.map(toSnakeCaseDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [toSnakeCase(key), toSnakeCaseDeep(v)]),
    );
  }
  return value;
};

// Deep comparison of only the keys config declares, so extra API-side fields
// (ids, defaults, timestamps) never register as drift. Arrays are compared
// order-insensitively by matching each desired item to some live item.
const subsetEqual = (desired, live) => {
  if (Array.isArray(desired)) {
    if (!Array.isArray(live) || desired.length !== live.length) return false;
    const remaining = [...live];
    return desired.every((item) => {
      const index = remaining.findIndex((candidate) => subsetEqual(item, candidate));
      if (index === -1) return false;
      remaining.splice(index, 1);
      return true;
    });
  }
  if (desired && typeof desired === "object") {
    if (!live || typeof live !== "object") return false;
    return Object.entries(desired).every(([key, value]) => subsetEqual(value, live[key]));
  }
  return desired === live;
};

async function reconcileSettings(repo) {
  const desired = Object.fromEntries(
    Object.entries({ ...config.settings, ...(overrides[repo.name]?.settings ?? {}) }).map(
      ([key, value]) => [toSnakeCase(key), value],
    ),
  );
  for (const key of DANGEROUS_SETTINGS) {
    if (key in desired) {
      log(repo.name, `refusing to manage dangerous setting \`${key}\``);
      delete desired[key];
    }
  }
  if (Object.keys(desired).length === 0) return;

  const { data: live } = await octokit.rest.repos.get({ owner: ORG, repo: repo.name });
  const delta = Object.fromEntries(
    Object.entries(desired).filter(([key, value]) => live[key] !== value),
  );
  if (Object.keys(delta).length === 0) return;

  log(repo.name, `settings drift: \`${Object.keys(delta).join("`, `")}\``);
  if (!DRY_RUN) {
    await octokit.rest.repos.update({ owner: ORG, repo: repo.name, ...delta });
  }
}

async function reconcileLabels(repo) {
  const includes = new Map();
  for (const label of [
    ...(config.labels?.include ?? []),
    ...(overrides[repo.name]?.labels?.include ?? []),
  ]) {
    includes.set(label.name.toLowerCase(), label);
  }
  const excludes = [
    ...(config.labels?.exclude ?? []),
    ...(overrides[repo.name]?.labels?.exclude ?? []),
  ].map((pattern) => new RegExp(pattern));
  if (includes.size === 0) return;

  const live = await octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
    owner: ORG,
    repo: repo.name,
    per_page: 100,
  });
  const liveByName = new Map(live.map((l) => [l.name.toLowerCase(), l]));

  for (const [key, desired] of includes) {
    // An all-digit hex color (e.g. 000000) YAML-parses as a number; normalize.
    const color = String(desired.color).padStart(6, "0").toLowerCase();
    const current = liveByName.get(key);
    if (!current) {
      log(repo.name, `create label \`${desired.name}\``);
      if (!DRY_RUN) {
        await octokit.rest.issues.createLabel({ owner: ORG, repo: repo.name, ...desired, color });
      }
    } else if (
      current.color.toLowerCase() !== color ||
      (current.description ?? "") !== (desired.description ?? "")
    ) {
      log(repo.name, `update label \`${desired.name}\``);
      if (!DRY_RUN) {
        await octokit.rest.issues.updateLabel({
          owner: ORG,
          repo: repo.name,
          name: current.name,
          new_name: desired.name,
          color,
          description: desired.description,
        });
      }
    }
  }

  for (const label of live) {
    if (includes.has(label.name.toLowerCase())) continue;
    if (excludes.some((pattern) => pattern.test(label.name))) continue;
    log(repo.name, `delete label \`${label.name}\``);
    if (!DRY_RUN) {
      await octokit.rest.issues.deleteLabel({ owner: ORG, repo: repo.name, name: label.name });
    }
  }
}

const managedFiles = await Promise.all(
  (filesConfig.files ?? []).map(async (entry) => ({
    ...entry,
    content:
      entry.state === "absent"
        ? null
        : await fs.readFile(path.join(root, "files", entry.path), "utf8"),
  })),
);

function fileTargets(repo) {
  return managedFiles.filter((entry) => {
    if (entry.exclude?.includes(repo.name)) return false;
    return entry.repos ? entry.repos.includes(repo.name) : true;
  });
}

async function liveFileContent(repo, filePath) {
  try {
    const { data } = await octokit.rest.repos.getContent({
      owner: ORG,
      repo: repo.name,
      path: filePath,
      ref: repo.default_branch,
    });
    if (Array.isArray(data) || data.type !== "file") {
      throw new Error(`${filePath} is not a regular file`);
    }
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

// Marks sync PRs as reconciler-owned so foreign branches/PRs that happen to
// use the same branch name are never adopted, force-pushed, or closed.
const SYNC_MARKER = "<!-- reconcile:file-sync -->";
const COMMIT_MESSAGE = filesConfig.commitMessage ?? "chore(sync): reconcile managed org files";

// A commit message alone is forgeable (a cherry-pick even preserves it), so
// tip ownership additionally requires GitHub's own web-flow committer and
// signature — present on API-created commits and unforgeable from a CLI push.
const tipIsReconcilers = (commit) =>
  commit.message === COMMIT_MESSAGE &&
  commit.committer?.email === "noreply@github.com" &&
  commit.verification?.verified === true;

// Compare-and-swap ref update: fails if the ref moved after its tip was
// verified, so a concurrent external push can never be overwritten between
// the ownership check and the mutation. Deleting passes the all-zero OID.
const ZERO_OID = "0".repeat(40);
async function casUpdateRef(repo, branch, beforeOid, afterOid) {
  await octokit.graphql(
    `mutation ($repositoryId: ID!, $refUpdates: [RefUpdate!]!) {
      updateRefs(input: { repositoryId: $repositoryId, refUpdates: $refUpdates }) {
        clientMutationId
      }
    }`,
    {
      repositoryId: repo.node_id,
      refUpdates: [{ name: `refs/heads/${branch}`, afterOid, beforeOid, force: true }],
    },
  );
}

async function closeStalePr(repo, branch) {
  const { data: open } = await octokit.rest.pulls.list({
    owner: ORG,
    repo: repo.name,
    state: "open",
    head: `${ORG}:${branch}`,
  });
  const marked = open.filter((pr) => pr.body?.includes(SYNC_MARKER));
  if (marked.length === 0) return;
  // External commits on the sync branch mean a human took the proposal over;
  // leave both the PR and the branch entirely alone.
  const ref = await octokit.rest.git
    .getRef({ owner: ORG, repo: repo.name, ref: `heads/${branch}` })
    .catch(() => null);
  if (!ref) return;
  const { data: tip } = await octokit.rest.git.getCommit({
    owner: ORG,
    repo: repo.name,
    commit_sha: ref.data.object.sha,
  });
  if (!tipIsReconcilers(tip)) {
    log(repo.name, `left sync PR and branch \`${branch}\` in place (external commits on tip)`);
    return;
  }
  if (DRY_RUN) {
    for (const pr of marked) {
      log(repo.name, `close stale sync PR #${pr.number} (repo back in sync)`);
    }
    return;
  }
  // Delete before closing: if the ref moved since verification the CAS fails
  // and the PR stays open for the next run to re-evaluate.
  try {
    await casUpdateRef(repo, branch, ref.data.object.sha, ZERO_OID);
  } catch {
    log(repo.name, `left sync PR and branch \`${branch}\` in place (ref moved during cleanup)`);
    return;
  }
  for (const pr of marked) {
    log(repo.name, `close stale sync PR #${pr.number} (repo back in sync)`);
    await octokit.rest.pulls.update({
      owner: ORG,
      repo: repo.name,
      pull_number: pr.number,
      state: "closed",
    });
  }
}

async function reconcileFiles(repo) {
  const targets = fileTargets(repo);
  const branch = filesConfig.branch ?? "chore/file-sync";
  // A repo excluded after a sync PR was opened must still get its PR closed.
  if (targets.length === 0) {
    await closeStalePr(repo, branch);
    return;
  }

  const drifted = [];
  for (const entry of targets) {
    const live = await liveFileContent(repo, entry.path);
    if (entry.state === "absent") {
      if (live !== null) drifted.push({ ...entry, action: "delete" });
    } else if (live !== entry.content) {
      drifted.push({ ...entry, action: live === null ? "create" : "update" });
    }
  }

  if (drifted.length === 0) {
    await closeStalePr(repo, branch);
    return;
  }

  const changes = drifted.map((d) => `${d.action} \`${d.path}\``);
  log(repo.name, `file drift: ${changes.join(", ")}`);
  if (DRY_RUN) return;

  const { data: headRef } = await octokit.rest.git.getRef({
    owner: ORG,
    repo: repo.name,
    ref: `heads/${repo.default_branch}`,
  });
  const headSha = headRef.object.sha;
  const { data: headCommit } = await octokit.rest.git.getCommit({
    owner: ORG,
    repo: repo.name,
    commit_sha: headSha,
  });
  const { data: tree } = await octokit.rest.git.createTree({
    owner: ORG,
    repo: repo.name,
    base_tree: headCommit.tree.sha,
    tree: drifted.map((d) => ({
      path: d.path,
      mode: "100644",
      type: "blob",
      ...(d.action === "delete" ? { sha: null } : { content: d.content }),
    })),
  });

  // Skip the push when the sync branch already proposes exactly this change,
  // otherwise a daily force-push would re-trigger CI on an unchanged PR.
  const existing = await octokit.rest.git
    .getRef({ owner: ORG, repo: repo.name, ref: `heads/${branch}` })
    .catch(() => null);
  const { data: open } = await octokit.rest.pulls.list({
    owner: ORG,
    repo: repo.name,
    state: "open",
    head: `${ORG}:${branch}`,
  });
  let upToDate = false;
  if (existing) {
    const { data: branchCommit } = await octokit.rest.git.getCommit({
      owner: ORG,
      repo: repo.name,
      commit_sha: existing.data.object.sha,
    });
    const tipIsOurs = tipIsReconcilers(branchCommit);
    const marked = open.some((pr) => pr.body?.includes(SYNC_MARKER));
    if (!tipIsOurs && !marked) {
      throw new Error(`branch ${branch} exists but is not owned by the reconciler; skipping`);
    }
    // A marked PR whose tip is no longer ours means someone pushed their own
    // commits onto the sync branch; never force-push over external work.
    if (!tipIsOurs) {
      log(repo.name, `sync branch has external commits; leaving the open sync PR untouched`);
      return;
    }
    upToDate = branchCommit.tree.sha === tree.sha && branchCommit.parents[0]?.sha === headSha;
  }

  if (!upToDate) {
    const { data: commit } = await octokit.rest.git.createCommit({
      owner: ORG,
      repo: repo.name,
      message: COMMIT_MESSAGE,
      tree: tree.sha,
      parents: [headSha],
    });
    if (existing) {
      // CAS against the verified tip: a concurrent external push makes this
      // throw instead of being overwritten; the next run re-evaluates.
      await casUpdateRef(repo, branch, existing.data.object.sha, commit.sha);
    } else {
      await octokit.rest.git.createRef({
        owner: ORG,
        repo: repo.name,
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    }
  }

  if (open.length === 0) {
    const { data: pr } = await octokit.rest.pulls.create({
      owner: ORG,
      repo: repo.name,
      base: repo.default_branch,
      head: branch,
      title: COMMIT_MESSAGE,
      body: [
        "This repository drifted from the org-managed files in",
        `[\`${ORG}/.github\`](https://github.com/${ORG}/.github/tree/main/reconcile).`,
        "",
        ...changes.map((c) => `- ${c}`),
        "",
        "Merge to re-sync, or exclude this repo in `reconcile/files.yaml` if the",
        "divergence is intentional. This PR is regenerated while drift remains",
        "and closed automatically once the repository is back in sync.",
        "",
        SYNC_MARKER,
      ].join("\n"),
    });
    log(repo.name, `opened sync PR #${pr.number}`);
  }
}

// Org rulesets are a single org-level object list, reconciled once per run
// rather than per repo. Enforcement is GitHub's; only definitions live here.
async function reconcileRulesets() {
  const desired = (rulesetsConfig.rulesets ?? []).map(toSnakeCaseDeep);
  if (desired.length === 0) return;
  const live = await octokit.paginate("GET /orgs/{org}/rulesets", { org: ORG, per_page: 100 });
  for (const ruleset of desired) {
    const match = live.find((r) => r.name === ruleset.name);
    if (!match) {
      log("org", `create ruleset \`${ruleset.name}\``);
      if (!DRY_RUN) await octokit.request("POST /orgs/{org}/rulesets", { org: ORG, ...ruleset });
      continue;
    }
    const { data: full } = await octokit.request("GET /orgs/{org}/rulesets/{ruleset_id}", {
      org: ORG,
      ruleset_id: match.id,
    });
    if (subsetEqual(ruleset, full)) continue;
    log("org", `update ruleset \`${ruleset.name}\``);
    if (!DRY_RUN) {
      await octokit.request("PUT /orgs/{org}/rulesets/{ruleset_id}", {
        org: ORG,
        ruleset_id: match.id,
        ...ruleset,
      });
    }
  }
}

const work = {
  settings: reconcileSettings,
  labels: reconcileLabels,
  files: reconcileFiles,
};

if (only.includes("rulesets") && repoFilter.length === 0) {
  try {
    await reconcileRulesets();
  } catch (error) {
    failures.push(`org (rulesets): ${error.message}`);
    echo(chalk.red(`org (rulesets): ${error.message}`));
  }
}

for (const repo of repos) {
  for (const mode of only) {
    if (mode === "rulesets") continue;
    try {
      await work[mode](repo);
    } catch (error) {
      failures.push(`${repo.name} (${mode}): ${error.message}`);
      echo(chalk.red(`${repo.name} (${mode}): ${error.message}`));
    }
  }
}

if (summary.length === 0) summary.push("- No drift detected");
if (failures.length > 0) {
  summary.push("", "### Failures", ...failures.map((f) => `- ${f}`));
  process.exitCode = 1;
}
if (process.env.GITHUB_STEP_SUMMARY) {
  await fs.appendFile(
    process.env.GITHUB_STEP_SUMMARY,
    [`## Reconcile${DRY_RUN ? " (dry-run)" : ""}`, "", ...summary, ""].join("\n"),
  );
}
echo(`${tag} done: ${summary.length} item(s), ${failures.length} failure(s)`);
