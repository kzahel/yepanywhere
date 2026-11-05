import { createContext } from "react";

/** Subscription observations from the native login do not describe a routed session. */
export const RoutedSessionContext = createContext<{ accountId: string } | null>(
  null,
);
