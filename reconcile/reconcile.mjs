#!/usr/bin/env node
// Stateless org reconciler: desired state lives in reconcile/, live state is the
// GitHub API, and the diff is computed on every run. Settings and labels are
// applied directly; managed-file drift is proposed through a PR per repo.
import "zx/globals";
import { Octokit } from "octokit";

const ORG = process.env.GH_ORG ?? "home-operations";
const DRY_RUN = Boolean(argv["dry-run"]) || process.env.DRY_RUN === "true";
const MODES = ["settings", "labels", "files"];
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

// Config uses camelCase keys; the Update Repository API wants snake_case.
const toSnakeCase = (key) => key.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

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

async function closeStalePr(repo, branch) {
  const { data: open } = await octokit.rest.pulls.list({
    owner: ORG,
    repo: repo.name,
    state: "open",
    head: `${ORG}:${branch}`,
  });
  for (const pr of open) {
    log(repo.name, `close stale sync PR #${pr.number} (repo back in sync)`);
    if (!DRY_RUN) {
      await octokit.rest.pulls.update({
        owner: ORG,
        repo: repo.name,
        pull_number: pr.number,
        state: "closed",
      });
      await octokit.rest.git
        .deleteRef({ owner: ORG, repo: repo.name, ref: `heads/${branch}` })
        .catch(() => {});
    }
  }
}

async function reconcileFiles(repo) {
  const targets = fileTargets(repo);
  const branch = filesConfig.branch ?? "chore/file-sync";
  if (targets.length === 0) return;

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
  let upToDate = false;
  if (existing) {
    const { data: branchCommit } = await octokit.rest.git.getCommit({
      owner: ORG,
      repo: repo.name,
      commit_sha: existing.data.object.sha,
    });
    upToDate = branchCommit.tree.sha === tree.sha && branchCommit.parents[0]?.sha === headSha;
  }

  if (!upToDate) {
    const { data: commit } = await octokit.rest.git.createCommit({
      owner: ORG,
      repo: repo.name,
      message: filesConfig.commitMessage ?? "chore(sync): reconcile managed org files",
      tree: tree.sha,
      parents: [headSha],
    });
    if (existing) {
      await octokit.rest.git.updateRef({
        owner: ORG,
        repo: repo.name,
        ref: `heads/${branch}`,
        sha: commit.sha,
        force: true,
      });
    } else {
      await octokit.rest.git.createRef({
        owner: ORG,
        repo: repo.name,
        ref: `refs/heads/${branch}`,
        sha: commit.sha,
      });
    }
  }

  const { data: open } = await octokit.rest.pulls.list({
    owner: ORG,
    repo: repo.name,
    state: "open",
    head: `${ORG}:${branch}`,
  });
  if (open.length === 0) {
    const { data: pr } = await octokit.rest.pulls.create({
      owner: ORG,
      repo: repo.name,
      base: repo.default_branch,
      head: branch,
      title: filesConfig.commitMessage ?? "chore(sync): reconcile managed org files",
      body: [
        "This repository drifted from the org-managed files in",
        `[\`${ORG}/.github\`](https://github.com/${ORG}/.github/tree/main/reconcile).`,
        "",
        ...changes.map((c) => `- ${c}`),
        "",
        "Merge to re-sync, or exclude this repo in `reconcile/files.yml` if the",
        "divergence is intentional. This PR is regenerated while drift remains",
        "and closed automatically once the repository is back in sync.",
      ].join("\n"),
    });
    log(repo.name, `opened sync PR #${pr.number}`);
  }
}

const work = {
  settings: reconcileSettings,
  labels: reconcileLabels,
  files: reconcileFiles,
};

for (const repo of repos) {
  for (const mode of only) {
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
