import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// Reproduce a launcher exit notification arriving after the OS already says
// its PID is dead. This ordering happens naturally on Windows but is legal on
// every platform. Only the initial backend notification is delayed.
const spawn = childProcess.spawn;
let retiredExit;
let replacementStarted = false;
function deliverRetiredExit() {
  if (!retiredExit || !replacementStarted) return;
  setTimeout(retiredExit, 100);
  retiredExit = undefined;
}
childProcess.spawn = (command, args, options) => {
  const child = spawn(command, args, options);
  if (
    args.includes("@yep-anywhere/server") &&
    options.env.YEP_SERVER_GENERATION.endsWith("-2")
  ) {
    replacementStarted = true;
    deliverRetiredExit();
  }
  if (
    args.includes("@yep-anywhere/server") &&
    options.env.YEP_SERVER_GENERATION.endsWith("-1")
  ) {
    const emit = child.emit;
    child.emit = function (event, ...values) {
      if (event === "exit") {
        retiredExit = () => emit.call(this, event, ...values);
        deliverRetiredExit();
        return true;
      }
      return emit.call(this, event, ...values);
    };
  }
  return child;
};
syncBuiltinESMExports();
