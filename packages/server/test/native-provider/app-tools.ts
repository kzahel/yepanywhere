import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Exchange } from "./model-server.js";
import type { AppProvider } from "./app-fixture.js";

/** Execute a real, file-gated tool whose output bursts during app replacement. */
export async function heldAppTool(
  provider: AppProvider,
  project: string,
  request: Exchange,
) {
  const script = join(project, "native-held-tool.cjs");
  await writeFile(
    script,
    `const fs=require('node:fs');
fs.appendFileSync('tool-start-count','start\\n');
let burst=false,finished=false;
const timer=setTimeout(()=>process.exit(4),45000);
const watch=fs.watch('.',check);
fs.writeFileSync('tool-started',String(process.pid));
function check(){
 if(fs.existsSync('tool-burst')&&!burst){burst=true;process.stdout.write('OWNED_DENSE_OUTPUT '.repeat(16000)+'\\n');fs.writeFileSync('tool-burst-done','done');}
 if(fs.existsSync('tool-release')&&!finished){finished=true;watch.close();clearTimeout(timer);fs.writeFileSync('tool-finished','done');console.log('OWNED_DENSE_TOOL_DONE');}
}
check();
`,
  );
  const command = `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`;
  if (provider === "claude")
    request.tool("Bash", {
      command,
      timeout: 60000,
      description: "Run the owned lifecycle tool",
    });
  else
    request.tool(
      "exec",
      `let result=await tools.exec_command({cmd:${JSON.stringify(command)},workdir:${JSON.stringify(project)},yield_time_ms:1000,max_output_tokens:100,sandbox_permissions:"require_escalated",justification:"Run the owned lifecycle tool for reload qualification"}); while(result.session_id){result=await tools.write_stdin({session_id:result.session_id,chars:"",yield_time_ms:1000,max_output_tokens:100});} text(result.output);`,
    );
}
