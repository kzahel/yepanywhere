import {
  PUBLIC_FILE_SHARES_CAPABILITY,
  serverHasCapability,
  type UrlProjectId,
} from "@yep-anywhere/shared";
import { useRef } from "react";
import { api } from "../api/client";
import { useFileVhostService } from "../hooks/useFileVhostService";
import { usePublicShareStatus } from "../hooks/usePublicShareStatus";
import { useVersion } from "../hooks/useVersion";
import { useI18n } from "../i18n";
import { publicSharePlayUrlFromFileShareUrl } from "../lib/publicSharePlay";
import { IconButton } from "./ui/Button";

/**
 * The File Viewer's public-share control. A click opens the share dialog; a
 * middle click opens the file's existing public share in play form in a new
 * tab, or falls back to the dialog when the file has no share yet.
 */
export function PublicFileShareButton({
  onOpen,
  projectId,
  filePath,
}: {
  onOpen: (anchor: DOMRect) => void;
  projectId: string;
  filePath: string;
}) {
  const { t } = useI18n();
  const { version } = useVersion();
  const { status } = usePublicShareStatus();
  const fileVhost = useFileVhostService(projectId);
  // Looked up when the pointer arrives, so the middle click that follows can
  // usually open its tab synchronously, inside the browser's popup allowance.
  const lookup = useRef<{
    promise: Promise<string | null>;
    url?: string | null;
  } | null>(null);
  if (
    !fileVhost &&
    (status?.canCreate !== true ||
      !serverHasCapability(version, PUBLIC_FILE_SHARES_CAPABILITY))
  ) {
    return null;
  }

  const lookUpPlayUrl = () => {
    const entry: NonNullable<typeof lookup.current> = {
      promise: api
        .getPublicFileShares(projectId as UrlProjectId, filePath)
        .then((response) => {
          const shareUrl = response.items[0]?.url;
          return shareUrl
            ? (publicSharePlayUrlFromFileShareUrl(shareUrl) ?? shareUrl)
            : null;
        })
        .catch(() => null),
    };
    void entry.promise.then((url) => {
      entry.url = url;
    });
    lookup.current = entry;
    return entry;
  };

  const openPlay = (anchor: DOMRect) => {
    const entry = lookup.current ?? lookUpPlayUrl();
    if (entry.url !== undefined) {
      if (entry.url) window.open(entry.url, "_blank", "noopener,noreferrer");
      else onOpen(anchor);
      return;
    }
    // Still looking: claim the tab now, while the click still counts as a
    // user gesture, and point it at the share once it is known.
    const tab = window.open("", "_blank");
    void entry.promise.then((url) => {
      if (url && tab) {
        tab.opener = null;
        tab.location.replace(url);
      } else if (url) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else {
        tab?.close();
        onOpen(anchor);
      }
    });
  };

  return (
    <IconButton
      onClick={(event) => onOpen(event.currentTarget.getBoundingClientRect())}
      onPointerEnter={() => {
        lookUpPlayUrl();
      }}
      onMouseDown={(event) => {
        // Keep the middle button from starting autoscroll or a paste.
        if (event.button === 1) event.preventDefault();
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return;
        event.preventDefault();
        openPlay(event.currentTarget.getBoundingClientRect());
      }}
      label={t("fileViewerSharePublicly")}
    >
      <PublicLinkIcon />
    </IconButton>
  );
}

function PublicLinkIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="m8 12 4-4M6.5 14.5l-1 1a2.8 2.8 0 0 1-4-4l3-3a2.8 2.8 0 0 1 4 0M13.5 5.5l1-1a2.8 2.8 0 1 1 4 4l-3 3a2.8 2.8 0 0 1-4 0" />
    </svg>
  );
}
