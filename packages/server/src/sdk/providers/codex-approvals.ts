import type { PermissionMode } from "@yep-anywhere/shared";
import type { StartSessionOptions } from "./types.js";
import type { ToolApprovalResult } from "../types.js";
import type {
  CommandExecutionApprovalDecision,
  CommandExecutionRequestApprovalParams,
  FileChangeApprovalDecision,
  FileChangeRequestApprovalParams,
  PermissionsRequestApprovalParams,
  PermissionsRequestApprovalResponse,
  ToolRequestUserInputParams,
  ToolRequestUserInputResponse,
} from "./codex-protocol/index.js";
import type { JsonRpcServerRequest } from "./codex-json-rpc.js";
import { getOptionalString } from "./codex-item-conversion.js";
import { log } from "./codex-log.js";

export async function handleServerRequestApproval(
  request: JsonRpcServerRequest,
  options: StartSessionOptions,
  signal: AbortSignal,
  permissionMode: PermissionMode,
): Promise<unknown> {
  log.info(
    {
      method: request.method,
      requestId: request.id,
      permissionMode,
    },
    "Codex app-server sent server request",
  );

  const params =
    request.params && typeof request.params === "object"
      ? (request.params as Record<string, unknown>)
      : {};

  switch (request.method) {
    case "item/tool/call":
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "No dynamic tool is registered for this session",
          },
        ],
      };
    case "item/commandExecution/requestApproval": {
      const commandParams = asCommandExecutionRequestApprovalParams(
        request.params,
      );
      if (!commandParams) {
        log.warn(
          {
            method: request.method,
            requestId: request.id,
          },
          "Codex command approval params invalid; declining",
        );
        return { decision: "decline" as CommandExecutionApprovalDecision };
      }
      log.info(
        {
          method: request.method,
          requestId: request.id,
          threadId: commandParams.threadId,
          turnId: commandParams.turnId,
          itemId: commandParams.itemId,
          command: commandParams.command,
          cwd: commandParams.cwd,
        },
        "Handling Codex command approval request",
      );
      const toolInput = {
        command: commandParams.command,
        cwd: commandParams.cwd,
        reason: commandParams.reason,
        commandActions: commandParams.commandActions ?? [],
        proposedExecpolicyAmendment:
          commandParams.proposedExecpolicyAmendment ?? null,
        threadId: commandParams.threadId,
        turnId: commandParams.turnId,
        itemId: commandParams.itemId,
      };
      const decision: CommandExecutionApprovalDecision =
        await resolveApprovalDecision(
          options,
          "Bash",
          toolInput,
          signal,
          "accept",
          "decline",
          permissionMode,
        );
      log.info(
        {
          method: request.method,
          requestId: request.id,
          threadId: commandParams.threadId,
          turnId: commandParams.turnId,
          itemId: commandParams.itemId,
          decision,
        },
        "Resolved Codex command approval request",
      );
      return { decision };
    }

    case "item/fileChange/requestApproval": {
      const fileParams = asFileChangeRequestApprovalParams(request.params);
      if (!fileParams) {
        log.warn(
          {
            method: request.method,
            requestId: request.id,
          },
          "Codex file-change approval params invalid; declining",
        );
        return { decision: "decline" as FileChangeApprovalDecision };
      }
      const grantRoot = fileParams.grantRoot ?? null;
      log.info(
        {
          method: request.method,
          requestId: request.id,
          threadId: fileParams.threadId,
          turnId: fileParams.turnId,
          itemId: fileParams.itemId,
          grantRoot,
        },
        "Handling Codex file-change approval request",
      );
      const toolInput = {
        file_path: grantRoot ?? undefined,
        reason: fileParams.reason ?? null,
        grantRoot,
        threadId: fileParams.threadId,
        turnId: fileParams.turnId,
        itemId: fileParams.itemId,
      };
      const decision: FileChangeApprovalDecision =
        await resolveApprovalDecision(
          options,
          "Edit",
          toolInput,
          signal,
          "accept",
          "decline",
          permissionMode,
        );
      log.info(
        {
          method: request.method,
          requestId: request.id,
          threadId: fileParams.threadId,
          turnId: fileParams.turnId,
          itemId: fileParams.itemId,
          decision,
        },
        "Resolved Codex file-change approval request",
      );
      return { decision };
    }

    // Backward-compatible protocol variants.
    case "execCommandApproval": {
      const commandParts = Array.isArray(params.command)
        ? params.command.filter(
            (part): part is string => typeof part === "string",
          )
        : [];
      const toolInput = {
        command: commandParts.join(" "),
        cwd: getOptionalString(params.cwd),
        reason: getOptionalString(params.reason),
        parsedCmd: Array.isArray(params.parsedCmd) ? params.parsedCmd : [],
        callId: getOptionalString(params.callId),
      };
      const decision = await resolveApprovalDecision(
        options,
        "Bash",
        toolInput,
        signal,
        "approved",
        "denied",
        permissionMode,
      );
      log.info(
        {
          method: request.method,
          requestId: request.id,
          decision,
          command: toolInput.command,
          cwd: toolInput.cwd,
        },
        "Resolved legacy Codex command approval request",
      );
      return { decision };
    }

    case "applyPatchApproval": {
      const fileChanges =
        params.fileChanges && typeof params.fileChanges === "object"
          ? (params.fileChanges as Record<string, unknown>)
          : {};
      const paths = Object.keys(fileChanges);
      const toolInput = {
        changes: paths.map((path) => ({ path, kind: "update" })),
        reason: getOptionalString(params.reason),
        grantRoot: getOptionalString(params.grantRoot),
        callId: getOptionalString(params.callId),
      };
      const decision = await resolveApprovalDecision(
        options,
        "Edit",
        toolInput,
        signal,
        "approved",
        "denied",
        permissionMode,
      );
      log.info(
        {
          method: request.method,
          requestId: request.id,
          decision,
          changedPathCount: paths.length,
          grantRoot: toolInput.grantRoot,
        },
        "Resolved legacy Codex apply-patch approval request",
      );
      return { decision };
    }

    case "item/permissions/requestApproval": {
      const permissionParams = asPermissionsRequestApprovalParams(
        request.params,
      );
      if (!permissionParams) {
        log.warn(
          {
            method: request.method,
            requestId: request.id,
          },
          "Codex permission approval params invalid; declining",
        );
        return createDeclinedPermissionResponse();
      }

      return await resolvePermissionRequestApproval(
        options,
        permissionParams,
        signal,
        permissionMode,
      );
    }

    case "item/tool/requestUserInput": {
      const requestInput = asToolRequestUserInputParams(request.params);
      if (!requestInput) {
        log.warn(
          {
            method: request.method,
            requestId: request.id,
          },
          "Codex tool user-input params invalid; returning no answers",
        );
        return { answers: {} } satisfies ToolRequestUserInputResponse;
      }

      const toolInput = {
        questions: requestInput.questions.map((question) => ({
          id: question.id,
          header: question.header,
          question: question.question,
          options: question.options ?? [],
          multiSelect: false,
          isOther: question.isOther,
          isSecret: question.isSecret,
        })),
        isBlocking: requestInput.isBlocking,
        autoResolutionMs: requestInput.autoResolutionMs,
        threadId: requestInput.threadId,
        turnId: requestInput.turnId,
        itemId: requestInput.itemId,
      };
      const result = await resolveToolApprovalResult(
        options,
        "AskUserQuestion",
        toolInput,
        signal,
        permissionMode,
      );
      const updatedInput =
        result.behavior === "allow" &&
        result.updatedInput &&
        typeof result.updatedInput === "object"
          ? (result.updatedInput as {
              answers?: Record<string, string | string[]>;
            })
          : null;
      const submittedAnswers = updatedInput?.answers ?? {};
      const answers: ToolRequestUserInputResponse["answers"] = {};
      for (const question of requestInput.questions) {
        const submitted =
          submittedAnswers[question.id] ?? submittedAnswers[question.question];
        answers[question.id] = {
          answers: Array.isArray(submitted)
            ? submitted.filter(
                (answer): answer is string => typeof answer === "string",
              )
            : typeof submitted === "string"
              ? [submitted]
              : [],
        };
      }
      log.info(
        {
          method: request.method,
          requestId: request.id,
          questionCount: requestInput.questions.length,
          threadId: requestInput.threadId,
          turnId: requestInput.turnId,
          itemId: requestInput.itemId,
          behavior: result.behavior,
        },
        "Resolved Codex tool user-input request",
      );
      const response: ToolRequestUserInputResponse = { answers };
      return response;
    }

    default: {
      log.warn(
        { method: request.method, requestId: request.id },
        "Unhandled codex server request",
      );
      return {};
    }
  }
}

async function resolveApprovalDecision<TDecision extends string>(
  options: StartSessionOptions,
  toolName: string,
  toolInput: unknown,
  signal: AbortSignal,
  allowDecision: TDecision,
  denyDecision: TDecision,
  permissionMode: PermissionMode,
): Promise<TDecision> {
  const result = await resolveToolApprovalResult(
    options,
    toolName,
    toolInput,
    signal,
    permissionMode,
  );
  return result.behavior === "allow" ? allowDecision : denyDecision;
}

async function resolveToolApprovalResult(
  options: StartSessionOptions,
  toolName: string,
  toolInput: unknown,
  signal: AbortSignal,
  permissionMode: PermissionMode,
): Promise<ToolApprovalResult> {
  if (!options.onToolApproval) {
    log.warn(
      { toolName },
      "No onToolApproval handler available; denying Codex approval request",
    );
    return { behavior: "deny" };
  }

  let result: ToolApprovalResult;
  try {
    result = await options.onToolApproval(toolName, toolInput, {
      signal,
      permissionMode,
    });
  } catch (error) {
    log.warn(
      { toolName, error },
      "onToolApproval threw; denying Codex approval request",
    );
    return { behavior: "deny" };
  }

  log.info(
    { toolName, behavior: result.behavior },
    "Resolved tool approval callback result",
  );

  return result;
}

async function resolvePermissionRequestApproval(
  options: StartSessionOptions,
  params: PermissionsRequestApprovalParams,
  signal: AbortSignal,
  permissionMode: PermissionMode,
): Promise<PermissionsRequestApprovalResponse> {
  if (permissionMode === "bypassPermissions") {
    return createGrantedPermissionResponse(params, "turn");
  }

  const toolInput = {
    cwd: params.cwd,
    reason: params.reason,
    permissions: params.permissions,
    threadId: params.threadId,
    turnId: params.turnId,
    itemId: params.itemId,
  };
  const decision = await resolveApprovalDecision(
    options,
    "Permissions",
    toolInput,
    signal,
    "accept",
    "decline",
    permissionMode,
  );
  return decision === "accept"
    ? createGrantedPermissionResponse(params, "turn")
    : createDeclinedPermissionResponse();
}

function createGrantedPermissionResponse(
  params: PermissionsRequestApprovalParams,
  scope: PermissionsRequestApprovalResponse["scope"],
): PermissionsRequestApprovalResponse {
  const permissions: PermissionsRequestApprovalResponse["permissions"] = {};
  if (params.permissions.network) {
    permissions.network = params.permissions.network;
  }
  if (params.permissions.fileSystem) {
    permissions.fileSystem = params.permissions.fileSystem;
  }
  return { permissions, scope };
}

export function createDeclinedPermissionResponse(): PermissionsRequestApprovalResponse {
  return { permissions: {}, scope: "turn" };
}

function asCommandExecutionRequestApprovalParams(
  params: unknown,
): CommandExecutionRequestApprovalParams | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string"
  ) {
    return null;
  }
  return params as CommandExecutionRequestApprovalParams;
}

function asFileChangeRequestApprovalParams(
  params: unknown,
): FileChangeRequestApprovalParams | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string"
  ) {
    return null;
  }
  return params as FileChangeRequestApprovalParams;
}

function asPermissionsRequestApprovalParams(
  params: unknown,
): PermissionsRequestApprovalParams | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    typeof record.cwd !== "string" ||
    !record.permissions ||
    typeof record.permissions !== "object"
  ) {
    return null;
  }
  return params as PermissionsRequestApprovalParams;
}

export function asToolRequestUserInputParams(
  params: unknown,
): ToolRequestUserInputParams | null {
  if (!params || typeof params !== "object") return null;
  const record = params as Record<string, unknown>;
  if (
    typeof record.threadId !== "string" ||
    typeof record.turnId !== "string" ||
    typeof record.itemId !== "string" ||
    !Array.isArray(record.questions) ||
    (record.isBlocking !== undefined && typeof record.isBlocking !== "boolean")
  ) {
    return null;
  }
  return {
    ...(params as ToolRequestUserInputParams),
    // Codex 0.147 made this field required. Older app-server releases omit
    // it and defined those requests as blocking.
    isBlocking:
      typeof record.isBlocking === "boolean" ? record.isBlocking : true,
  };
}
