import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type RenderLog = {
  id?: string;
  timestamp?: string;
  message?: string;
  labels?: Array<{ name: string; value: string }>;
};

function parseJsonLines(output: string): RenderLog[] {
  const records: RenderLog[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < output.length; index += 1) {
    const character = output[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "{") {
      if (depth === 0) start = index;
      depth += 1;
    } else if (character === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try {
          const parsed: unknown = JSON.parse(output.slice(start, index + 1));
          if (parsed && typeof parsed === "object") records.push(parsed as RenderLog);
        } catch {
          // Ignore malformed fragments while preserving other log records.
        }
        start = -1;
      }
    }
  }

  return records;
}

export async function queryRenderLogs(start: string, end: string) {
  const { stdout } = await execFileAsync("render", [
    "logs",
    "--resources",
    "srv-dag24tn40ujc73dg4b0g",
    "--start",
    start,
    "--end",
    end,
    "--limit",
    "200",
    "--output",
    "json",
  ]);
  return parseJsonLines(stdout);
}
