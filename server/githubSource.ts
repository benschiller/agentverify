import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type SourceRequest = {
  repository: string;
  path: string;
};

export type SourceResult = {
  repository: string;
  path: string;
  content: string;
  url: string;
};

export async function listGithubSourcePaths(repository: string): Promise<string[]> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repository}/git/trees/HEAD?recursive=1`,
    "--jq",
    '.tree[] | select(.type == "blob") | .path',
  ]);
  return stdout.split("\n").map((path) => path.trim()).filter(Boolean);
}

export async function fetchGithubSource({ repository, path }: SourceRequest): Promise<SourceResult> {
  const { stdout } = await execFileAsync("gh", [
    "api",
    `repos/${repository}/contents/${path}`,
    "--jq",
    ".content",
  ]);
  const content = Buffer.from(stdout.replace(/\s+$/, ""), "base64").toString("utf8");
  return {
    repository,
    path,
    content,
    url: `https://github.com/${repository}/blob/main/${path}`,
  };
}
