import { type ReactNode, useState } from "react";
import { createRoot } from "react-dom/client";
import { displayProviders } from "../../src/components/renderers/tools/__fixtures__/displayProviders";
import { ToolCallRow } from "../../src/components/blocks/ToolCallRow";
import { TextBlock } from "../../src/components/blocks/TextBlock";
import { OutputCopyButton } from "../../src/components/renderers/tools/outputPreview";
import { SourceRowMenuTrigger } from "../../src/components/SourceContextMenu";
import { IconButton } from "../../src/components/ui/Button";
import { RememberedDisclosureStateProvider } from "../../src/contexts/RememberedDisclosureStateContext";
import appStyles from "../../src/components/ProjectAppViewer.module.css";
import menuStyles from "../../src/components/SourceContextMenu.module.css";
import lastStyles from "../../src/components/LastSessionFile.module.css";
import "../../src/styles/index.css";

function Site({ name, children }: { name: string; children: ReactNode }) {
  return (
    <section
      data-site={name}
      style={{
        position: "relative",
        padding: 16,
        marginBottom: 16,
        minHeight: 64,
        border: "1px solid var(--border-color)",
      }}
    >
      <button type="button" data-before={name}>
        Before {name}
      </button>
      {children}
    </section>
  );
}

// These three witnesses isolate the DOM/CSS contract from host routing, app
// processes and opening a file viewer. The styles and shared controls are real;
// the four transcript cases below also exercise their production handlers.
function Action({ className, name }: { className: string; name: string }) {
  const [count, setCount] = useState(0);
  return (
    <IconButton
      label={name}
      className={className}
      data-clicks={count}
      onClick={() => setCount(count + 1)}
    >
      ⧉
    </IconButton>
  );
}
function Fixture() {
  const [menuClicks, setMenuClicks] = useState(0);
  return (
    <main style={{ padding: 24, maxWidth: 800, margin: "auto" }}>
      <h1>Hover and keyboard reveal</h1>
      <Site name="tool">
        <ToolCallRow
          id="reveal-tool"
          toolName="Bash"
          toolInput={{ command: "printf 'hello'" }}
          toolResult={{ content: "hello" }}
          status="complete"
        />
      </Site>
      <Site name="bash">
        <div className="bash-inline-section-header">
          Output{" "}
          <OutputCopyButton text="bash clipboard witness" label="Copy output" />
        </div>
      </Site>
      <Site name="text">
        <TextBlock
          text="A paragraph with $x^2$ math."
          onQuoteBlock={() => setMenuClicks((value) => value + 1)}
        />
      </Site>
      <Site name="quote">
        <TextBlock
          text="A quoteable paragraph."
          augmentHtml="<p>A quoteable paragraph.</p>"
          onQuoteBlock={() => setMenuClicks((value) => value + 1)}
        />
      </Site>
      <Site name="edit">
        <ToolCallRow
          id="reveal-edit"
          toolName="Edit"
          toolInput={{
            file_path: "/tmp/reveal.ts",
            old_string: "before",
            new_string: "after",
          }}
          toolResult={{
            content: "Updated /tmp/reveal.ts",
            structured: {
              filePath: "/tmp/reveal.ts",
              oldString: "before",
              newString: "after",
              originalFile: "before",
              structuredPatch: [
                {
                  oldStart: 1,
                  oldLines: 1,
                  newStart: 1,
                  newLines: 1,
                  lines: ["-before", "+after"],
                },
              ],
              userModified: false,
              replaceAll: false,
            },
          }}
          status="complete"
        />
      </Site>
      <Site name="app">
        <div className={appStyles.title}>
          Project app{" "}
          <span className={appStyles.pathActions}>
            <Action name="Copy app path" className={appStyles.copyPath!} />
          </span>
        </div>
      </Site>
      <Site name="host">
        <div className="host-picker-item">
          Saved host{" "}
          <Action name="Delete host" className="host-picker-delete" />
        </div>
      </Site>
      <Site name="menu">
        <div
          className={menuStyles.rowSurface}
          style={{ position: "relative", minHeight: 40 }}
        >
          Source row{" "}
          <SourceRowMenuTrigger
            actions={[]}
            label="Source menu"
            onOpen={() => setMenuClicks((value) => value + 1)}
          />
        </div>
        <output data-menu-clicks={menuClicks} />
      </Site>
      <Site name="last">
        <Action name="Restore last file" className={lastStyles.reopen!} />
      </Site>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  displayProviders(
    <RememberedDisclosureStateProvider>
      <Fixture />
    </RememberedDisclosureStateProvider>,
  ),
);
