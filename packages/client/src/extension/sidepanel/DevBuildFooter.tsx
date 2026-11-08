import { useEffect, useState } from "react";
import { Button } from "../../components/ui/Button";
import { useI18n } from "../../i18n";
import { getChrome } from "../chrome";
import { saveDevReload } from "../devReload";
import styles from "./DevBuildFooter.module.css";

interface BuildInfo {
  generation: string;
  workerHash: string;
  manifest: string;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

/** Mounted only in the explicitly enabled unpacked development build. */
export function DevBuildFooter() {
  const { t } = useI18n();
  const [latest, setLatest] = useState<BuildInfo>();
  const [fullReload, setFullReload] = useState(false);
  const [error, setError] = useState(false);
  const [check, setCheck] = useState(0);
  const [reloading, setReloading] = useState(false);
  const current = __EXTENSION_DEV_BUILD_ID__;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Manual checks restart the owned polling lifecycle.
  useEffect(() => {
    const chrome = getChrome();
    if (!chrome) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let inFlight = false;
    let decision: { generation: string; fullReload: boolean } | undefined;
    const poll = async () => {
      if (abort.signal.aborted || inFlight) return;
      clearTimeout(timer);
      if (document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        const response = await fetch(
          `${chrome.runtime.getURL("dev-build.json")}?check=${Date.now()}`,
          { cache: "no-store", signal: abort.signal },
        );
        if (!response.ok) throw new Error("Build unavailable");
        const text = await response.text();
        if (text.length > 256 * 1024) throw new Error("Invalid build metadata");
        const info: BuildInfo = JSON.parse(text);
        if (
          typeof info.generation !== "string" ||
          typeof info.workerHash !== "string" ||
          typeof info.manifest !== "string"
        )
          throw new Error("Invalid build metadata");
        let requiresReload = false;
        if (info.generation !== current) {
          if (decision?.generation === info.generation)
            requiresReload = decision.fullReload;
          else {
            const worker = (await chrome.runtime
              .sendMessage({ kind: "ya-dev-worker" })
              .catch(() => null)) as { workerHash?: string } | null;
            requiresReload =
              worker?.workerHash !== info.workerHash ||
              canonicalJson(chrome.runtime.getManifest()) !== info.manifest;
            decision = {
              generation: info.generation,
              fullReload: requiresReload,
            };
          }
        }
        if (!abort.signal.aborted) {
          setLatest((previous) =>
            previous?.generation === info.generation ? previous : info,
          );
          setFullReload(requiresReload);
          setError(false);
        }
      } catch {
        if (!abort.signal.aborted) setError(true);
      } finally {
        inFlight = false;
        if (!abort.signal.aborted && document.visibilityState === "visible")
          timer = setTimeout(() => void poll(), 1500);
      }
    };
    const visible = () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") void poll();
    };
    document.addEventListener("visibilitychange", visible);
    void poll();
    return () => {
      abort.abort();
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [current, check]);
  const update = latest && latest.generation !== current;
  const reloadPanel = () => {
    if (!latest || error) {
      setCheck((value) => value + 1);
      return;
    }
    window.location.reload();
  };
  const reloadExtension = async () => {
    const chrome = getChrome();
    if (!chrome) return;
    setReloading(true);
    try {
      await saveDevReload(chrome);
      chrome.runtime.reload();
    } catch {
      setError(true);
      setReloading(false);
    }
  };
  return (
    <footer className={styles.footer} data-extension-build={current}>
      <span className={styles.status} role="status">
        {error
          ? t("extensionDevUnavailable")
          : update
            ? t("extensionDevUpdateReady")
            : t("extensionDevCurrent", { build: current.slice(0, 8) })}
      </span>
      {(!fullReload || !latest || error) && (
        <Button
          variant={update && !error ? "primary" : "secondary"}
          className={styles.action}
          disabled={reloading}
          title={t("extensionDevPanelReloadHelp")}
          onClick={reloadPanel}
        >
          {!latest || error
            ? t("extensionDevCheck")
            : update
              ? t("extensionDevUpdatePanel")
              : t("extensionDevReloadPanel")}
        </Button>
      )}
      <Button
        variant={update && fullReload ? "primary" : "secondary"}
        className={styles.action}
        disabled={reloading}
        title={t("extensionDevFullReloadHelp")}
        onClick={() => void reloadExtension()}
      >
        {t("extensionDevReloadExtension")}
      </Button>
    </footer>
  );
}
