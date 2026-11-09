import { useEffect } from "react";
import { Button } from "../../src/components/ui/Button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  useMenuTrigger,
} from "../../src/components/ui/Menu";
import type { SpecimenMeta } from "../specimen";
import styles from "./Census.module.css";
import { CensusRow } from "./censusParts";
import { LEGACY_MENUS, type MenuDisposition } from "./mapping";

export default {
  title: "Census/Menus and popovers",
  parameters: {
    layer: "census",
    width: "fill",
    description:
      "Every hand-rolled menu, dropdown and floating panel, and where it went. The family is swept: menus are Menu, other floating panels Popover, and lint bans menu roles and document pointer listeners outside them. The page stays as a regression view.",
  },
} satisfies SpecimenMeta;

function SampleMenu() {
  const menu = useMenuTrigger();
  const { setOpen } = menu;
  useEffect(() => setOpen(true), [setOpen]);
  return (
    <div style={{ minHeight: "180px" }}>
      <Button {...menu.triggerProps} variant="secondary" size="small">
        Menu
      </Button>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        aria-label="Sample"
        autoFocus={false}
      >
        <MenuItem shortcut="R">Rename</MenuItem>
        <MenuItem checked kind="radio">
          Checked
        </MenuItem>
        <MenuSeparator />
        <MenuItem tone="danger">Delete</MenuItem>
      </Menu>
    </div>
  );
}

const TITLES: Record<MenuDisposition, string> = {
  menu: "Menu (components/ui/Menu.tsx)",
  popover: "Popover (components/ui/Popover.tsx)",
  keep: "Kept: not a menu or popover",
  composer: "Composer: its own later pass",
};

export function LegacyByDestination() {
  return (
    <div className={styles.census}>
      <SampleMenu />
      {(Object.keys(TITLES) as MenuDisposition[]).map((disposition) => {
        const rows = LEGACY_MENUS.filter((row) => row.to === disposition);
        return (
          <section key={disposition} className={styles.group}>
            <header className={styles.groupHeader}>
              <h3 className={styles.groupTitle}>
                {TITLES[disposition]} · {rows.length}
              </h3>
            </header>
            <div className={styles.rows}>
              {rows.map((row) => (
                <CensusRow
                  key={row.name}
                  label={`${row.name} · ${row.file}`}
                  note={row.note}
                  sample={
                    <span className={styles.loading}>
                      {disposition === "menu" || disposition === "popover"
                        ? "Swept"
                        : "Left"}
                    </span>
                  }
                />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}
LegacyByDestination.storyName = "Legacy, by destination";
