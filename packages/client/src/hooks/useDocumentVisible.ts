import { useEffect, useState } from "react";

/** Navigation acquisition stops for hidden pages, including back/forward cache. */
export function useDocumentVisible(): boolean {
  const [visible, setVisible] = useState(
    () => document.visibilityState !== "hidden",
  );
  useEffect(() => {
    const show = () => setVisible(document.visibilityState !== "hidden");
    const hide = () => setVisible(false);
    document.addEventListener("visibilitychange", show);
    window.addEventListener("pagehide", hide);
    window.addEventListener("pageshow", show);
    return () => {
      document.removeEventListener("visibilitychange", show);
      window.removeEventListener("pagehide", hide);
      window.removeEventListener("pageshow", show);
    };
  }, []);
  return visible;
}
