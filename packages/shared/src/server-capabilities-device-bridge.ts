import { CAPABILITY_ID_ALLOCATIONS } from "./capability-ids.js";
import { OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS } from "./server-capability-optional-bits.js";
import type { ServerCapabilityDefinition } from "./server-capability-definition.js";

export const DEVICE_BRIDGE_SERVER_CAPABILITIES = {
  deviceBridgeAvailable: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeAvailable.id,
    name: "deviceBridge-available",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeAvailable.index,
    },
    description:
      "Server recognizes the device bridge feature and can surface device settings or setup state.",
    clientFallback: "Hide device bridge settings and navigation.",
    serverContract: {
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Device bridge availability varies by server environment and installation state.",
    },
  },
  deviceBridge: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridge.id,
    name: "deviceBridge",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index: OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridge.index,
    },
    description:
      "Server has an installed device bridge runtime and device routes can be used.",
    clientFallback: "Hide live device controls.",
    serverContract: {
      routes: [
        "GET /api/devices",
        "POST /api/devices/:id/start",
        "POST /api/devices/:id/stop",
        "GET /api/devices/:id/screenshot",
      ],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "The installed bridge runtime is environment-dependent and can change without a protocol-version change.",
    },
  },
  deviceBridgeDownload: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeDownload.id,
    name: "deviceBridge-download",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeDownload.index,
    },
    description:
      "Server can download or update managed device bridge runtime dependencies.",
    clientFallback: "Hide device bridge download/update prompts.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Download support depends on server environment and is advertised separately from installed runtime availability.",
    },
  },
  deviceBridgeUpdate: {
    id: CAPABILITY_ID_ALLOCATIONS.deviceBridgeUpdate.id,
    name: "deviceBridge-update",
    kind: "permanent",
    area: "deviceBridge",
    introducedIn: "0.6.0",
    advertisement: {
      kind: "optional-bit",
      index:
        OPTIONAL_SERVER_CAPABILITY_BIT_ALLOCATIONS.deviceBridgeUpdate.index,
    },
    description:
      "Server reports an available update for managed device bridge runtime dependencies.",
    clientFallback:
      "Show download/setup state without an update-specific prompt.",
    serverContract: {
      routes: ["POST /api/devices/bridge/download"],
      responseFields: ["deviceBridgeState", "latestDeviceBridgeVersion"],
    },
    lifecycle: {
      kind: "permanent",
      reason:
        "Update availability is dynamic state advertised for older clients that branch on capability strings.",
    },
  },
} as const satisfies Record<string, ServerCapabilityDefinition>;
