import { type CSSProperties, useState } from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Banner } from "./Banner";
import { Button } from "./Button";

export default {
  title: "Controls/Banner",
  component: Banner,
  parameters: {
    layer: "control",
    description:
      "Banner from components/ui/Banner.tsx: a message about a page, panel or form in four tones, with an optional title, actions and dismiss. Errors are role=alert, the rest role=status.",
  },
} satisfies SpecimenMeta;

const column: CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: "var(--space-3)",
  width: "min(30rem, 100%)",
};

export function Tones() {
  return (
    <div style={column}>
      <Banner tone="info">
        Sessions sync from the host every few seconds.
      </Banner>
      <Banner tone="success">Saved. The server picks it up on restart.</Banner>
      <Banner tone="warning">
        This provider is deprecated and will be removed.
      </Banner>
      <Banner tone="error">
        Could not reach the server: connection refused.
      </Banner>
    </div>
  );
}

export function TitleAndActions() {
  const [shown, setShown] = useState(true);
  return (
    <div style={column}>
      <Banner
        tone="warning"
        title="Storage is on a network filesystem"
        actions={<Button size="small">Learn more</Button>}
      >
        Session files may be slow to load or lose writes.
      </Banner>
      {shown ? (
        <Banner
          tone="info"
          dismissLabel="Dismiss"
          onDismiss={() => setShown(false)}
        >
          A new version is available.
        </Banner>
      ) : (
        <Button size="small" onClick={() => setShown(true)}>
          Show again
        </Button>
      )}
      <Banner
        tone="error"
        actions={
          <>
            <Button size="small" variant="primary">
              Retry
            </Button>
            <Button size="small">Details</Button>
          </>
        }
        dismissLabel="Dismiss"
        onDismiss={() => {}}
      >
        The tunnel dropped. Retrying in 5 s.
      </Banner>
    </div>
  );
}

export function Compact() {
  return (
    <div style={column}>
      <Banner tone="error" compact>
        Invalid port.
      </Banner>
      <Banner tone="success" compact role="none">
        Connected.
      </Banner>
    </div>
  );
}

export function Elevated() {
  return (
    <div style={column}>
      <Banner elevated tone="warning" title="Floating notice">
        This notice stays distinct above page content.
      </Banner>
      <Banner tone="warning">Inline notice without elevation.</Banner>
    </div>
  );
}
