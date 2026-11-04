import { join } from "node:path";
import type { NativeProvider } from "./runtimes.js";
import type { Exchange } from "./model-server.js";

/** These names/arguments come from each pinned executable's actual tool inventory. */
export function readOwnedFile(
  provider: NativeProvider,
  project: string,
  request: Exchange,
) {
  const path = join(project, "notes.txt");
  if (provider.startsWith("claude")) request.tool("Read", { file_path: path });
  else if (provider.startsWith("codex"))
    request.tool(
      "exec",
      `const result = await tools.exec_command({cmd: ${JSON.stringify(process.platform === "win32" ? "type notes.txt" : "cat notes.txt")}, workdir: ${JSON.stringify(project)}, max_output_tokens: 100}); text(result.output);`,
    );
  else if (provider === "antigravity")
    request.tool("view_file", {
      AbsolutePath: path,
      toolSummary: "Read fixture",
      toolAction: "Reading fixture",
    });
  else if (provider === "pi") request.tool("read", { path });
  else if (provider === "opencode") request.tool("read", { filePath: path });
  else if (provider === "grok")
    request.tool("read_file", { target_file: path });
  else request.tool("read_file", { file_path: path });
}
