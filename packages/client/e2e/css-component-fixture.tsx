import { type ComponentType, type ReactNode, createElement } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../src/i18n";
import "../src/styles/index.css";

const COMPONENT_PREFIX = "/src/components/";
const NOOP_SENTINEL = "$noop";

type FixtureProps = Record<string, unknown>;

function reviveFixtureValue(value: unknown): unknown {
  if (value === NOOP_SENTINEL) return () => {};
  if (Array.isArray(value)) return value.map(reviveFixtureValue);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      key,
      reviveFixtureValue(entry),
    ]),
  );
}

function parseProps(raw: string | null): FixtureProps {
  if (!raw) return {};
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error("Fixture props must be a JSON object");
  }
  return reviveFixtureValue(parsed) as FixtureProps;
}

function fixtureError(error: unknown): ReactNode {
  return (
    <pre data-css-fixture-error="true">
      {error instanceof Error ? (error.stack ?? error.message) : String(error)}
    </pre>
  );
}

const rootElement = document.getElementById("css-component-fixture-root");
if (!rootElement) throw new Error("Missing CSS component fixture root");

document.body.style.margin = "0";
document.body.style.minHeight = "100vh";
document.body.style.background = "var(--bg-surface)";
document.body.style.color = "var(--text-primary)";

const root = createRoot(rootElement);

try {
  const params = new URLSearchParams(window.location.search);
  const modulePath = params.get("module") ?? "";
  const exportName = params.get("export") ?? "";
  if (!modulePath.startsWith(COMPONENT_PREFIX) || modulePath.includes("..")) {
    throw new Error(`Fixture module must be under ${COMPONENT_PREFIX}`);
  }
  if (!/^[A-Za-z_$][\w$]*$/.test(exportName)) {
    throw new Error("Fixture export must be a JavaScript identifier");
  }

  const loaded: Record<string, unknown> = await import(
    /* @vite-ignore */ modulePath
  );
  const Candidate = loaded[exportName];
  const isReactComponent =
    typeof Candidate === "function" ||
    (Candidate !== null &&
      typeof Candidate === "object" &&
      "$$typeof" in Candidate);
  if (!isReactComponent) {
    throw new Error(`Module does not export component ${exportName}`);
  }

  const props = parseProps(params.get("props"));
  const candidate = createElement(
    Candidate as ComponentType<FixtureProps>,
    props,
  );
  root.render(
    <I18nProvider>
      <div
        data-css-fixture-root="true"
        style={{
          boxSizing: "border-box",
          maxWidth: "100vw",
          padding: "16px",
        }}
      >
        {candidate}
      </div>
    </I18nProvider>,
  );
  requestAnimationFrame(() => {
    document.documentElement.dataset.cssFixtureReady = "true";
  });
} catch (error) {
  root.render(fixtureError(error));
  document.documentElement.dataset.cssFixtureError = "true";
}
