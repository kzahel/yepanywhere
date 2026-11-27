import { nativeSessionControl } from "./native-session-control.js";
import type { SessionCreationStore } from "../sessions/SessionCreationStore.js";
import {
  thinkingOptionToConfig,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import type { Supervisor } from "../supervisor/Supervisor.js";
import type { Process } from "../supervisor/Process.js";
import type { SessionCommandOwner } from "./session-commands.js";
import { CoreApiError } from "./errors.js";
import {
  nativeSessionInputs,
  type NativeSessionInputDeps,
} from "./native-session-inputs.js";
import {
  RouterRefusedBeforeProvider,
  type RouterBindingRef,
  routerSelectionFromBinding,
} from "../services/AgentAuthRouter.js";

/** Uses incumbent native ownership. Monitoring is shared per process, not caller. */
export function nativeSessionCommandOwner(
  deps: Omit<NativeSessionInputDeps, "supervisor"> & {
    supervisor: Pick<
      Supervisor,
      "startSession" | "getAllProcesses" | "getProcessForSession"
    > &
      Partial<
        Pick<
          Supervisor,
          | "interruptProcess"
          | "abortProcessWithVerification"
          | "pauseRecapsUntilUserTurn"
        >
      >;
    dataDir?: string;
    approvalAuditEnabled?: () => boolean;
    globalInstructions: () => string | undefined;
    creations?: SessionCreationStore;
    callerLaunch?: (
      sessionId: string,
    ) => { routerBinding?: RouterBindingRef; model?: string } | undefined;
    /**
     * Whether a catalog project's directory still exists. The catalog keeps a
     * project while its transcripts remain, after the directory is gone.
     */
    projectDirectoryExists?: (path: string) => Promise<boolean>;
  },
): SessionCommandOwner {
  type Watch = {
    pending: Map<string, { consumed: () => void; ended: () => void }>;
    release: () => void;
  };
  const watches = new Map<Process, Watch>();
  let pending = 0;
  const watch = (
    process: Process,
    id: string,
    consumed: () => void,
    ended: () => void,
  ) => {
    if (process.hasConsumedApiInput(id)) {
      consumed();
      return () => {};
    }
    if (process.isTerminated) {
      ended();
      return () => {};
    }
    if (watches.get(process)?.pending.has(id)) return () => {};
    if (pending >= 1024 || (!watches.has(process) && watches.size >= 128))
      throw new CoreApiError(
        "command_capacity",
        "Native input observation capacity reached",
        503,
      );
    let current = watches.get(process);
    if (!current) {
      const entry: Watch = { pending: new Map(), release: () => {} };
      const take = (id: string) => {
        const target = entry.pending.get(id);
        if (!target) return;
        entry.pending.delete(id);
        pending--;
        if (!entry.pending.size) entry.release();
        target.consumed();
      };
      const unsubscribeInput = process.observeApiInputConsumed(take);
      const unsubscribeCancelled = process.observeApiInputCancelled((id) => {
        const target = entry.pending.get(id);
        if (!target) return;
        entry.pending.delete(id);
        pending--;
        if (!entry.pending.size) entry.release();
        target.ended();
      });
      const unsubscribeState = process.subscribe((event) => {
        if (
          (event.type === "state-change" &&
            event.state.type === "terminated") ||
          event.type === "terminated" ||
          event.type === "complete"
        ) {
          const targets = [...entry.pending.values()];
          pending -= entry.pending.size;
          entry.pending.clear();
          entry.release();
          for (const target of targets) target.ended();
        }
      });
      entry.release = () => {
        unsubscribeInput();
        unsubscribeCancelled();
        unsubscribeState();
        if (watches.get(process) === entry) watches.delete(process);
      };
      watches.set(process, entry);
      current = entry;
    }
    const acquired = current;
    if (acquired.pending.has(id)) return () => {};
    acquired.pending.set(id, { consumed, ended });
    pending++;
    return () => {
      if (acquired.pending.delete(id)) pending--;
      if (!acquired.pending.size) acquired.release();
    };
  };
  const control = nativeSessionControl(deps);
  const inputs = nativeSessionInputs(deps);
  return {
    ...control,
    prepareControl(id, operation, pendingRequestId, response) {
      return operation === "cancelInput"
        ? inputs.prepareCancel(id, pendingRequestId ?? "")
        : control.prepareControl!(id, operation, pendingRequestId, response);
    },
    checkInput: inputs.check,
    inputs: inputs.list,
    close() {
      inputs.close();
      for (const entry of watches.values()) entry.release();
      watches.clear();
      pending = 0;
    },
    canSend(id) {
      const process = deps.supervisor.getProcessForSession(id);
      return Boolean(process && !process.isTerminated);
    },
    async send(
      id,
      request,
      receipt,
      consumed,
      ended,
      progress = () => {},
      admissible,
      attachments,
    ) {
      const process = deps.supervisor.getProcessForSession(id);
      if (!process || process.isTerminated) return { accepted: false };
      // Compaction reports its outcome through the queue, not input consumption.
      const release =
        request.type === "prompt"
          ? watch(process, receipt.id, consumed, ended)
          : () => {};
      try {
        const result = await inputs.admit(
          process,
          request,
          receipt,
          (patch) => {
            // Input that left the queue undelivered can no longer be consumed.
            if (
              patch.delivery === "cancelled" ||
              patch.delivery === "uncertain"
            )
              release();
            progress(patch);
          },
          admissible,
          attachments,
        );
        if (!result.accepted) release();
        return result;
      } catch (error) {
        release();
        throw error;
      }
    },
    async recover(receipt, consumed, ended) {
      const saved =
        receipt.kind === "createSession"
          ? deps.creations?.get({ kind: "superuser" }, receipt.id)
          : undefined;
      if (
        saved &&
        !saved.deleted &&
        saved.request?.input?.nativeReceiptId === receipt.id &&
        saved.initialInputId === receipt.id &&
        saved.attempt.delivery === "consumed"
      )
        return { sessionId: saved.sessionId, consumed: true };
      const bound = receipt.sessionId
        ? deps.supervisor.getProcessForSession(receipt.sessionId)
        : undefined;
      if (receipt.sessionId && !bound) return;
      const processes = bound ? [bound] : deps.supervisor.getAllProcesses();
      if (processes.length > 256) return;
      // Inherited transcript UUIDs are not proof of this process's admission.
      const candidates = processes.filter(
        (process) =>
          !process.isTerminated &&
          (process.hasConsumedApiInput(receipt.id) ||
            process.hasAcceptedApiInput(receipt.id)),
      );
      if (candidates.length !== 1) return;
      const process = candidates[0]!;
      if (consumed && ended) watch(process, receipt.id, consumed, ended);
      return {
        sessionId: process.sessionId,
        consumed: process.hasConsumedApiInput(receipt.id),
      };
    },
    async start(
      project,
      request,
      receipt,
      settled,
      failed,
      consumed = () => {},
      admitted = () => {},
      authorize = async () => {},
      attachments,
    ) {
      const thinking = request.thinking
        ? thinkingOptionToConfig(request.thinking)
        : { thinking: undefined, effort: undefined };
      const callerId =
        receipt.creator.principal.kind === "peer"
          ? undefined
          : (receipt.creator.sessionId ?? undefined);
      const caller = callerId ? deps.callerLaunch?.(callerId) : undefined;
      const explicitRouter = Boolean(
        request.routerPoolId || request.routerAccountId,
      );
      const routed =
        explicitRouter || request.routing === "direct"
          ? undefined
          : caller?.routerBinding;
      let model = request.model === "default" ? undefined : request.model;
      if (routed) {
        if (routed.provider !== request.provider) {
          const binding = routed.poolName
            ? `The caller uses the "${routed.poolName}" pool for ${routed.provider}.`
            : `The caller has a ${routed.provider} router binding.`;
          const routerOption = ` To use the router, specify a ${request.provider} pool (routerPoolId) or account (routerAccountId) and a model.`;
          return {
            rejected: true,
            message: `${binding} To start ${request.provider}, set routing to "direct".${routerOption}`,
          };
        }
        model ??= caller?.model;
        if (!model)
          return {
            rejected: true,
            message:
              "Name a model: a session started from a router session needs one its router account offers.",
          };
      }
      // A forwarded request must not name files on this server.
      if (
        request.bootInstructions &&
        "path" in request.bootInstructions &&
        receipt.creator.principal.kind === "peer"
      )
        return {
          rejected: true,
          message:
            "bootInstructions.path is available only to local callers; send the instructions as text",
        };
      // No provider can start here; a refusal, not an uncertain launch.
      if (
        deps.projectDirectoryExists &&
        !(await deps.projectDirectoryExists(project.path))
      )
        return {
          rejected: true,
          message: `The project's directory no longer exists on this server: ${project.path}`,
        };
      // The router has no default model; say so here, in v0's terms, before
      // its own refusal reaches the receipt worded for the settings UI.
      if (explicitRouter && !model)
        return {
          rejected: true,
          message:
            "Name a model: a router pool or account needs a model id from its selection catalog.",
        };
      let result: Awaited<ReturnType<Supervisor["startSession"]>>;
      try {
        if (attachments) await authorize();
        result = await deps.supervisor.startSession(
          project.path,
          {
            text: request.prompt,
            uuid: receipt.id,
            tempId: receipt.id,
            metadata: {
              apiSubmissionId: receipt.id,
              origin: "coordination",
              sourceSessionId:
                receipt.creator.principal.kind === "peer"
                  ? undefined
                  : (receipt.creator.sessionId ?? undefined),
              serverReceivedAt: receipt.createdAt,
            },
          },
          request.permissionMode,
          {
            providerName: request.provider,
            model,
            requestedModel: request.model ?? model,
            ...thinking,
            ...(explicitRouter
              ? {
                  routerPoolId: request.routerPoolId,
                  routerAccountId: request.routerAccountId,
                  routerPolicy: request.routerPolicy,
                  routerClaudeAiConnectors: request.routerClaudeAiConnectors,
                }
              : routed
                ? routerSelectionFromBinding(routed)
                : {}),
            serviceTier: request.serviceTier,
            apiClient: request.apiClient,
            bootInstructions: request.bootInstructions ?? undefined,
            globalInstructions: deps.globalInstructions(),
            recapMode: "off",
            promptSuggestionMode: "off",
          },
          {
            projectId: project.id as UrlProjectId,
            creation: {
              requestId: receipt.id,
              nativeReceiptId: receipt.id,
              ...(attachments
                ? { attachments: { files: attachments, authorize } }
                : {}),
              context: {
                owner: { kind: "superuser" },
                source: { kind: "request", provenance: { surface: "api" } },
              },
              authorize,
              onAccepted: (saved) => admitted(saved.sessionId),
            },
            requireProviderSessionId: true,
            onStarted: (id, process) => {
              settled(id);
              try {
                watch(process, receipt.id, consumed, failed);
              } catch {
                failed();
              }
            },
            onFailed: (reason, error) => failed(error ?? reason),
            onRetryableFailure: failed,
          },
        );
      } catch (error) {
        // A router refusal precedes any provider start: a known rejection,
        // not an uncertain launch.
        if (error instanceof RouterRefusedBeforeProvider)
          return { rejected: true, message: error.message };
        throw error;
      }
      if ("error" in result) return { rejected: true };
      if ("queued" in result) return { queueId: result.queueId };
      return { sessionId: result.sessionId };
    },
  };
}
