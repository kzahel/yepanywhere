import { useState } from "react";
import { createRoot } from "react-dom/client";
import { SettingsSection } from "../../src/pages/settings/SettingsSection";
import "../../src/styles/purposeGlobals";
import styles from "./Prompts.module.css";

const DEFAULT_BLOCK =
  'When using any external image/video generation API or MCP tool, enable the provider\'s safety filtering at its strictest setting (e.g. moderation="auto", enable_safety_checker=true, safety_filter_level="block_most"). Never disable a safety checker. Prefer providers with server-side filtering.';

interface Block {
  id: number;
  text: string;
}

function Blocks({
  blocks,
  onChange,
  scope,
}: {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  scope: string;
}) {
  function move(index: number, direction: number) {
    const next = [...blocks];
    const other = index + direction;
    [next[index], next[other]] = [next[other]!, next[index]!];
    onChange(next);
  }
  return (
    <div className={styles.blocks}>
      {blocks.length === 0 && (
        <p className={styles.empty}>No additional instructions.</p>
      )}
      {blocks.map((block, index) => (
        <div className={styles.block} key={block.id}>
          <textarea
            aria-label={`${scope} block ${index + 1}`}
            rows={2}
            placeholder="Write an instruction…"
            value={block.text}
            onChange={(event) =>
              onChange(
                blocks.map((item) =>
                  item.id === block.id
                    ? { ...item, text: event.target.value }
                    : item,
                ),
              )
            }
          />
          <div className={styles.tools}>
            <button
              type="button"
              className={styles.remove}
              aria-label={`Remove ${scope} block ${index + 1}`}
              title="Remove instruction"
              onClick={() =>
                onChange(blocks.filter((item) => item.id !== block.id))
              }
            >
              ×
            </button>
            {blocks.length > 1 && (
              <>
                <button
                  type="button"
                  aria-label={`Move ${scope} block ${index + 1} up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${scope} block ${index + 1} down`}
                  disabled={index === blocks.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </>
            )}
          </div>
        </div>
      ))}
      <button
        className={styles.add}
        type="button"
        aria-label="+ Add instruction block"
        onClick={() =>
          onChange([
            ...blocks,
            {
              id: Math.max(0, ...blocks.map((block) => block.id)) + 1,
              text: "",
            },
          ])
        }
      >
        + Add block
      </button>
    </div>
  );
}

function App() {
  const [screen, setScreen] = useState<"global" | "user">("global");
  const [defaults, setDefaults] = useState(true);
  const [globalBlocks, setGlobalBlocks] = useState<Block[]>([
    { id: 1, text: DEFAULT_BLOCK },
  ]);
  const [userBlocks, setUserBlocks] = useState<Block[]>([]);
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false);
  const isGlobal = screen === "global";
  const text = [...globalBlocks, ...(!isGlobal ? userBlocks : [])]
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join("\n\n");
  function navigate(next: "global" | "user") {
    setScreen(next);
    setPreview(false);
    setNotice("");
    window.scrollTo(0, 0);
  }
  return (
    <div className={styles.page}>
      <div className={styles.mockbar}>
        <span>Mockup</span>
        <nav aria-label="Mockup views">
          <button
            type="button"
            aria-pressed={isGlobal}
            onClick={() => navigate("global")}
          >
            All limited users
          </button>
          <button
            type="button"
            aria-pressed={!isGlobal}
            onClick={() => navigate("user")}
          >
            Edit Alex
          </button>
        </nav>
      </div>
      <header className={styles.header}>
        <strong>Yep Anywhere</strong>
        <span>
          Settings <span aria-hidden="true">/</span> Users
        </span>
      </header>
      <div className={styles.layout}>
        <aside className={styles.sidebar}>
          <strong>Settings</strong>
          <span>Appearance</span>
          <span>Sessions</span>
          <span>Providers</span>
          <span>Projects</span>
          <span>Local access</span>
          <span className={styles.selected}>Users</span>
          <span>Advanced</span>
        </aside>
        <main className={styles.main}>
          <div className={styles.titleRow}>
            <div>
              <h1>{isGlobal ? "Users" : "Edit Alex"}</h1>
            </div>
            {!isGlobal && (
              <button type="button" onClick={() => navigate("global")}>
                ← All users
              </button>
            )}
          </div>
          {isGlobal && (
            <div className={styles.userRow}>
              <div>
                <strong>Alex</strong>
                <span>Limited user · 2 projects</span>
              </div>
              <button type="button" onClick={() => navigate("user")}>
                Edit
              </button>
            </div>
          )}
          {!isGlobal && (
            <details className={styles.account}>
              <summary>Account, workspace & project access</summary>
              <p>
                Existing account and grant controls stay here. This proposal
                focuses on instructions.
              </p>
            </details>
          )}
          <SettingsSection
            title={
              isGlobal
                ? "Instructions for all limited users"
                : "Additional instructions for Alex"
            }
            description={
              isGlobal
                ? "Joined in order, before per-user instructions."
                : "Appended after shared instructions."
            }
            className={styles.instructions}
          >
            {isGlobal ? (
              <div className={styles.defaultControl}>
                <label>
                  <input
                    type="checkbox"
                    checked={defaults}
                    onChange={(event) => setDefaults(event.target.checked)}
                  />
                  <strong>Start from default</strong>
                </label>
                <p>
                  {defaults
                    ? "Append to the provider’s default instructions."
                    : "Replace the provider’s default instructions."}
                </p>
              </div>
            ) : (
              <details className={styles.inherited}>
                <summary>
                  Inherited: {defaults ? "default + " : ""}
                  {globalBlocks.length} shared{" "}
                  {globalBlocks.length === 1 ? "block" : "blocks"}
                </summary>
                <p className={styles.promptText}>
                  {globalBlocks.map((block) => block.text).join("\n\n") ||
                    "No shared blocks."}
                </p>
                <button type="button" onClick={() => navigate("global")}>
                  Edit shared
                </button>
              </details>
            )}
            <Blocks
              blocks={isGlobal ? globalBlocks : userBlocks}
              onChange={isGlobal ? setGlobalBlocks : setUserBlocks}
              scope={isGlobal ? "Shared" : "Alex"}
            />
            <div className={styles.actions}>
              <button
                type="button"
                className={styles.primary}
                aria-label={isGlobal ? "Save shared instructions" : "Save user"}
                onClick={() =>
                  setNotice(
                    "Saved in this preview only. No server settings changed.",
                  )
                }
              >
                Save
              </button>
              <button
                type="button"
                onClick={() => setPreview(!preview)}
                aria-expanded={preview}
                aria-label="Preview combined instructions"
              >
                Preview combined
              </button>
            </div>
            {notice && (
              <p className={styles.notice} role="status">
                {notice}
              </p>
            )}
            {preview && (
              <section className={styles.preview}>
                <h3>Combined instructions{!isGlobal && " · Alex"}</h3>
                <p className={styles.order}>
                  {defaults ? "Provider default → " : ""}Shared blocks
                  {!isGlobal ? " → Alex’s blocks" : " → Per-user blocks"}
                </p>
                {defaults && (
                  <p className={styles.baseNote}>
                    Provider default instructions come first. Their text varies
                    by provider.
                  </p>
                )}
                <pre>{text || "No custom instructions."}</pre>
                {isGlobal && (
                  <p>A user's own blocks, if any, are appended after these.</p>
                )}
              </section>
            )}
            <p className={styles.timing}>Applies on next session launch.</p>
          </SettingsSection>
          <section className={styles.restriction}>
            <strong>Sandboxed Claude</strong>
            <p>MCP & connectors always disabled.</p>
          </section>
        </main>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
