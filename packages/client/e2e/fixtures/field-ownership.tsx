import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { displayProviders } from "../../src/components/renderers/tools/__fixtures__/displayProviders";
import { SettingsSearchBar } from "../../src/pages/settings/SettingsSearchBar";
import { Field, Select, TextInput } from "../../src/components/ui/Field";
import { Checkbox } from "../../src/components/ui/Checkbox";
import { IconButton } from "../../src/components/ui/Button";
import { Badge } from "../../src/components/ui/Badge";
import "../../src/styles/purposeGlobals";

const settings = Array.from({ length: 500 }, (_, index) => `Setting ${index}`);

function Fixture() {
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(false);
  const [tick, setTick] = useState(0);
  const [prefix, setPrefix] = useState("plain");
  const [checked, setChecked] = useState(false);
  useEffect(() => {
    const timer = setInterval(() => setTick((value) => value + 1), 50);
    return () => clearInterval(timer);
  }, []);
  return (
    <main
      style={{
        maxWidth: 700,
        margin: "auto",
        padding: 16,
        display: "grid",
        gap: 12,
      }}
    >
      <h1>Shared fields and palettes</h1>
      <SettingsSearchBar
        query={query}
        onQueryChange={setQuery}
        matchValues={match}
        onMatchValuesChange={setMatch}
      />
      <Field label="Compact source" error="Invalid source">
        <TextInput
          type="search"
          size="small"
          touchTarget="large"
          defaultValue="A long source path retains space for the clear action"
          trailing={
            <IconButton size="small" label="Source action">
              ?
            </IconButton>
          }
        />
      </Field>
      <Select
        aria-label="Prefix"
        value={prefix}
        leading={prefix === "icon" ? "●" : undefined}
        onChange={(event) => setPrefix(event.target.value)}
      >
        <option value="plain">Plain prefix</option>
        <option value="icon">Icon prefix</option>
      </Select>
      <Checkbox
        label="Touch choice"
        touchTarget="large"
        checked={checked}
        onCheckedChange={setChecked}
      />
      <Checkbox
        label="Padded option"
        variant="option"
        description="A whole selectable row."
      />
      <div>
        <Badge emphasis="solid" palette={{ color: "#8250df", onSolid: "#fff" }}>
          Merged
        </Badge>{" "}
        <Badge
          palette={{
            color: "var(--provider-claude)",
            soft: "color-mix(in srgb, var(--provider-claude) 12%, transparent)",
          }}
        >
          Claude
        </Badge>
      </div>
      <output aria-label="Concurrent update">{tick}</output>
      <div style={{ maxHeight: 120, overflow: "auto" }}>
        {settings
          .filter((label) => label.toLowerCase().includes(query.toLowerCase()))
          .map((label) => (
            <div key={label}>
              {label} · {tick}
            </div>
          ))}
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  displayProviders(<Fixture />),
);
