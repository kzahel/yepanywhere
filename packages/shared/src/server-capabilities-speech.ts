import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const SPEECH_SERVER_CAPABILITIES = {
  speechBackendSetup: {
    id: CAPABILITY_ID_ALLOCATIONS.speechBackendSetup.id,
    name: "speech-backend-setup",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Persist local STT backends in server settings, install pixi runtimes and model weights, and request a safe YA restart.",
    clientFallback:
      "Hide the Speech backends enable/install table and make no setup, install, or speech-restart requests.",
    serverContract: {
      routes: [
        "GET /api/settings",
        "PUT /api/settings",
        "GET /api/speech/backends",
        "POST /api/speech/backends/:id/install",
        "POST /api/speech/backends/restart",
      ],
      // Both route modules are shared with older capabilities, not wholly owned.
      requestFields: ["speechVoiceBackends"],
      responseFields: ["settings.speechVoiceBackends"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers only enable local STT from YEP_VOICE_BACKENDS and have no install or settings-union routes.",
    },
  },
  speechVocabularySessionTerms: {
    id: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    name: "speech-vocabulary-session-terms",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.speechVocabularySessionTerms.id,
    },
    description:
      "Bias learned speech keyterms toward a supplied active-session term set when SQLite is ready.",
    clientFallback:
      "Omit context.sessionTerms and preserve existing speech recognition.",
    serverContract: {
      routes: ["POST /api/speech/transcribe", "GET /api/speech/ws"],
      // Extends requests on shared speech routes; it does not own the module.
      requestFields: ["context.sessionTerms"],
    },
    lifecycle: {
      kind: "permanent",
      reason: "Learned vocabulary depends on ready SQLite storage.",
    },
  },
  speechVocabulary: {
    id: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    name: "speech-vocabulary",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: {
      kind: "optional-bit",
      index: CAPABILITY_ID_ALLOCATIONS.speechVocabulary.id,
    },
    description:
      "Persistent opt-in speech vocabulary learning and Grok biasing when SQLite is ready.",
    clientFallback: "Hide vocabulary controls and make no vocabulary requests.",
    serverContract: {
      routes: [
        "GET /api/speech/vocabulary",
        "PUT /api/speech/vocabulary",
        "POST /api/speech/vocabulary/scan",
        "POST /api/speech/vocabulary/reset",
      ],
      routeModules: ["packages/server/src/routes/speech-vocabulary.ts"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Vocabulary availability depends on server storage configuration and readiness.",
    },
  },
  localSpeechModelSelection: {
    id: CAPABILITY_ID_ALLOCATIONS.localSpeechModelSelection.id,
    name: "local-speech-model-selection",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.8.2",
    advertisement: { kind: "version-implied" },
    description:
      "Per-request Whisper model selection and unified English Parakeet on NeMo.",
    clientFallback:
      "Hide Whisper and recent Parakeet choices; retain older Parakeet requests without modifying saved preferences.",
    serverContract: {
      requestFields: ["model"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Older servers ignore Whisper model overrides and lack the recent NeMo runtime.",
    },
  },
  voiceInput: {
    id: CAPABILITY_ID_ALLOCATIONS.voiceInput.id,
    name: "voiceInput",
    kind: "permanent",
    area: "speech",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index: OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.voiceInput.index,
    },
    description:
      "Server permits voice input features and may expose server-routed speech backends.",
    clientFallback:
      "When absent from a capabilities-bearing response, hide or disable voice input controls.",
    serverContract: {
      routes: [
        "POST /api/speech/transcribe",
        "POST /api/speech/prewarm",
        "GET /api/speech/ws",
        "POST /api/speech/xai-client-key",
        "POST /api/speech/xai-client-secret",
      ],
      responseFields: [
        "voiceBackends",
        "voiceBackendStatuses",
        "voiceBackendCapabilities",
      ],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Voice input can be disabled by server configuration and older clients preserve fallback behavior when version data is absent.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
