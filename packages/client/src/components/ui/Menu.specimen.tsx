import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import type { SpecimenMeta } from "../../../design/specimen";
import { Button } from "./Button";
import {
  Menu,
  MenuGroup,
  MenuItem,
  MenuSeparator,
  useMenuTrigger,
} from "./Menu";
import { Popover } from "./Popover";

export default {
  title: "Controls/Menu",
  component: Menu,
  parameters: {
    layer: "control",
    description:
      "Menu and Popover from components/ui/: an anchored surface above modals that flips and shifts to fit, closes on an outside press or Escape and returns focus to its trigger. Menu adds role=menu, roving focus and checkable items.",
  },
} satisfies SpecimenMeta;

const stage: CSSProperties = {
  minHeight: "300px",
  minWidth: "260px",
};

function Glyph({ d }: { d: string }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d={d} />
    </svg>
  );
}

function Sample({ children }: { children: ReactNode }) {
  const menu = useMenuTrigger();
  const { setOpen } = menu;
  // Open on mount so the page and captures show the surface.
  useEffect(() => setOpen(true), [setOpen]);
  return (
    <div style={stage}>
      <Button {...menu.triggerProps} variant="secondary">
        Session actions
      </Button>
      <Menu
        open={menu.open}
        onClose={menu.close}
        anchorRef={menu.anchorRef}
        aria-label="Session actions"
        autoFocus={false}
      >
        {children}
      </Menu>
    </div>
  );
}

export function Actions() {
  return (
    <Sample>
      <MenuItem
        icon={<Glyph d="M12 2l3 7h7l-5.5 4 2 7-6.5-4.5L5.5 20l2-7L2 9h7z" />}
      >
        Star
      </MenuItem>
      <MenuItem
        icon={<Glyph d="M11 4H4v16h16v-7M18 2l4 4-10 10H8v-4z" />}
        shortcut="R"
      >
        Rename
      </MenuItem>
      <MenuItem
        disabled
        tooltip="Needs a newer server"
        description="Needs a newer server"
      >
        Clone
      </MenuItem>
      <MenuSeparator />
      <MenuItem
        tone="danger"
        icon={<Glyph d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" />}
      >
        Terminate
      </MenuItem>
    </Sample>
  );
}

function CheckableItems() {
  const [speed, setSpeed] = useState("normal");
  const [captions, setCaptions] = useState(true);
  return (
    <>
      <MenuGroup label="Speed">
        {["slow", "normal", "fast"].map((value) => (
          <MenuItem
            key={value}
            kind="radio"
            checked={speed === value}
            onSelect={() => setSpeed(value)}
          >
            {value[0]?.toUpperCase() + value.slice(1)}
          </MenuItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        checked={captions}
        keepOpen
        onSelect={() => setCaptions((on) => !on)}
      >
        Captions
      </MenuItem>
    </>
  );
}

export function Checkable() {
  return (
    <Sample>
      <CheckableItems />
    </Sample>
  );
}

export function PlainPopover() {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setOpen(true), []);
  return (
    <div style={stage}>
      <Button
        ref={anchorRef}
        variant="secondary"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        Details
      </Button>
      <Popover
        open={open}
        onClose={() => setOpen(false)}
        anchorRef={anchorRef}
        placement="bottom-start"
        aria-label="Details"
        role="dialog"
        style={{ width: "16rem", padding: "var(--space-3)" }}
      >
        A popover holds any content: a short explanation, a form, a list of
        links. It closes on an outside press or Escape.
      </Popover>
    </div>
  );
}
