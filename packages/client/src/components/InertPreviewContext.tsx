import { createContext, type ReactNode, useContext } from "react";

const InertPreviewContext = createContext(false);

/** Preview descendants render their visual surface without live service editors. */
export function InertPreviewProvider({ children }: { children: ReactNode }) {
  return (
    <InertPreviewContext.Provider value={true}>
      {children}
    </InertPreviewContext.Provider>
  );
}

export function useInertPreview(): boolean {
  return useContext(InertPreviewContext);
}
