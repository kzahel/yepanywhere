import {
  NON_HUMAN_USER_TURN_CAPABILITY,
  serverHasCapability,
} from "@yep-anywhere/shared";
import { useSessionNonHumanUserTurn } from "../lib/clientSummaryStore";
import { useVersion } from "./useVersion";

export function useNonHumanUserTurn(sessionId: string) {
  const { version } = useVersion();
  const turn = useSessionNonHumanUserTurn(sessionId);
  return serverHasCapability(version, NON_HUMAN_USER_TURN_CAPABILITY)
    ? turn
    : undefined;
}
