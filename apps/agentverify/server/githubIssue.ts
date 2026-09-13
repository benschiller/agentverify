import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function createGithubIssue(repository: string, title: string, body: string) {
  const { stdout } = await execFileAsync("gh", [
    "issue",
    "create",
    "--repo",
    repository,
    "--title",
    title,
    "--body",
    body,
  ]);
  return stdout.trim();
}
