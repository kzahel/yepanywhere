import {
  useSessionCollectionQueryRecords,
  useStarredSessionRecords,
  useCategorizedSessionRecords,
} from "../lib/clientSummaryStore";
import { useSidebarSessionFeeds } from "./useSidebarSessionFeeds";

/** Render accepted windows; unrelated cached entities cannot restore membership. */
export function useSidebarSessionRecords() {
  const feeds = useSidebarSessionFeeds();
  const { globalQuery, starredQuery, categorizedQuery, authoritativeWindows } =
    feeds;
  const globalQueryRecords = useSessionCollectionQueryRecords(globalQuery);
  const starredSessionRecords = useStarredSessionRecords(
    authoritativeWindows ? starredQuery : undefined,
  );
  const categorizedSessionRecords = useCategorizedSessionRecords(
    authoritativeWindows ? categorizedQuery : undefined,
  );
  return {
    ...feeds,
    globalQueryRecords,
    starredSessionRecords,
    categorizedSessionRecords,
  };
}
