import {
  Component,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import styles from "./Design.module.css";
import { type DesignRoute, routeHref, useDesignRoute } from "./route";
import {
  DESIGN_LAYERS,
  DESIGN_THEMES,
  type DesignTheme,
  type LoadedSpecimen,
  type LoadedState,
} from "./specimen";
import { findTarget, specimens } from "./specimens";

const LAYER_LABELS = {
  token: "Tokens",
  control: "Controls",
  pattern: "Patterns",
  scene: "Scenes",
  census: "Census",
} as const;

/** Marks the page ready for capture once fonts have loaded. */
function useFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) setReady(true);
    });
    return () => {
      live = false;
    };
  }, []);
  return ready;
}

class StateBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Reported so design:shot fails rather than photographing the message.
    console.error(
      "Specimen state failed to render",
      error,
      info.componentStack,
    );
  }

  render() {
    return this.state.error ? (
      <div className={styles.stateError}>{this.state.error.message}</div>
    ) : (
      this.props.children
    );
  }
}

function RenderState({ state }: { state: LoadedState }) {
  const Render = state.render;
  return (
    <StateBoundary>
      <Render />
    </StateBoundary>
  );
}

function IsolatedState({
  specimen,
  state,
  theme,
}: {
  specimen: LoadedSpecimen;
  state: LoadedState;
  theme: DesignTheme;
}) {
  const ready = useFontsReady();
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return (
    <main
      className={`${styles.isolated} ${specimen.parameters.width === "fill" ? styles.fill : ""}`}
      // On the element too, so tokens resolve in this theme from the first
      // render; the document attribute follows in a layout effect.
      data-theme={theme}
      data-design-ready={ready ? "" : undefined}
      data-design-state={state.id}
    >
      <RenderState state={state} />
    </main>
  );
}

/** A same-origin frame that grows to its document's height. */
function PhoneFrame({ src, title }: { src: string; title: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(200);
  useEffect(() => {
    const element = frame.current;
    if (!element) return;
    let observer: ResizeObserver | undefined;
    const attach = () => {
      const root = element.contentDocument?.documentElement;
      if (!root) return;
      observer?.disconnect();
      observer = new ResizeObserver(() => setHeight(root.scrollHeight));
      observer.observe(root);
    };
    element.addEventListener("load", attach);
    return () => {
      element.removeEventListener("load", attach);
      observer?.disconnect();
    };
  }, []);
  return (
    <iframe
      ref={frame}
      className={styles.phoneFrame}
      src={src}
      title={title}
      style={{ height }}
    />
  );
}

function ThemeCell({
  specimen,
  state,
  theme,
  phone,
}: {
  specimen: LoadedSpecimen;
  state: LoadedState;
  theme: DesignTheme;
  phone: boolean;
}) {
  if (phone) {
    return (
      <PhoneFrame
        src={`design.html${routeHref(state.id, { iso: true, theme })}`}
        title={`${state.name}, ${theme}`}
      />
    );
  }
  return (
    <div
      className={`${styles.cell} ${specimen.parameters.width === "fill" ? styles.fill : ""}`}
      data-theme={theme}
    >
      <RenderState state={state} />
    </div>
  );
}

function Toolbar({ route, target }: { route: DesignRoute; target: string }) {
  return (
    <nav className={styles.toolbar} aria-label="View">
      <span className={styles.toolbarLabel}>Theme</span>
      <a
        href={routeHref(target, { phone: route.phone })}
        aria-current={route.theme ? undefined : "page"}
      >
        all
      </a>
      {DESIGN_THEMES.map((theme) => (
        <a
          key={theme}
          href={routeHref(target, { phone: route.phone, theme })}
          aria-current={route.theme === theme ? "page" : undefined}
        >
          {theme}
        </a>
      ))}
      <span className={styles.toolbarLabel}>Width</span>
      <a
        href={routeHref(target, { theme: route.theme })}
        aria-current={route.phone ? undefined : "page"}
      >
        natural
      </a>
      <a
        href={routeHref(target, { phone: true, theme: route.theme })}
        aria-current={route.phone ? "page" : undefined}
      >
        phone
      </a>
    </nav>
  );
}

function GridPage({
  specimen,
  only,
  route,
}: {
  specimen: LoadedSpecimen;
  only: LoadedState | undefined;
  route: DesignRoute;
}) {
  const ready = useFontsReady();
  const themes = route.theme ? [route.theme] : DESIGN_THEMES;
  const states = only ? [only] : specimen.states;
  return (
    <div className={styles.page} data-design-ready={ready ? "" : undefined}>
      <header className={styles.pageHeader}>
        <p className={styles.crumbs}>
          <a href="#/">Playground</a> /{" "}
          {LAYER_LABELS[specimen.parameters.layer]}
          {only ? (
            <>
              {" / "}
              <a href={routeHref(specimen.id)}>{specimen.title}</a>
            </>
          ) : null}
        </p>
        <h1>{only ? only.name : specimen.title}</h1>
        {specimen.parameters.description ? (
          <p className={styles.description}>
            {specimen.parameters.description}
          </p>
        ) : null}
        <p className={styles.source}>
          <code>{specimen.file}</code>
        </p>
        <Toolbar route={route} target={only ? only.id : specimen.id} />
      </header>
      <div
        className={styles.grid}
        style={{ "--design-columns": themes.length } as CSSProperties}
      >
        {states.map((state) => (
          <section key={state.id} className={styles.row}>
            <h2 className={styles.stateHeading}>
              <a href={routeHref(state.id)}>{state.name}</a>{" "}
              <a
                className={styles.isoLink}
                href={routeHref(state.id, { iso: true, theme: themes[0] })}
              >
                isolated
              </a>
            </h2>
            <div className={styles.themes}>
              {themes.map((theme) => (
                <figure key={theme} className={styles.figure}>
                  <figcaption>{theme}</figcaption>
                  <ThemeCell
                    specimen={specimen}
                    state={state}
                    theme={theme}
                    phone={route.phone}
                  />
                </figure>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function IndexPage() {
  const ready = useFontsReady();
  return (
    <div className={styles.page} data-design-ready={ready ? "" : undefined}>
      <header className={styles.pageHeader}>
        <h1>YA design playground</h1>
        <p className={styles.description}>
          Shared controls, their states and the census of legacy variants, in
          every theme. Contract: <code>topics/ui-design.md</code>. Capture with{" "}
          <code>pnpm -s design:shot &lt;id&gt;</code>; list with{" "}
          <code>pnpm -s design:index</code>.
        </p>
      </header>
      {DESIGN_LAYERS.map((layer) => {
        const group = specimens.filter(
          (specimen) => specimen.parameters.layer === layer,
        );
        if (!group.length) return null;
        return (
          <section key={layer} className={styles.indexGroup}>
            <h2>{LAYER_LABELS[layer]}</h2>
            <ul className={styles.indexList}>
              {group.map((specimen) => (
                <li key={specimen.id}>
                  <a href={routeHref(specimen.id)}>{specimen.title}</a>
                  {specimen.parameters.description ? (
                    <span className={styles.indexNote}>
                      {specimen.parameters.description}
                    </span>
                  ) : null}
                  <span className={styles.indexStates}>
                    {specimen.states.map((state) => (
                      <a key={state.id} href={routeHref(state.id)}>
                        {state.name}
                      </a>
                    ))}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </div>
  );
}

/** Layers → specimens; the active specimen's states expand beneath it. */
function Sidebar({
  route,
  activeSpecimen,
}: {
  route: DesignRoute;
  activeSpecimen: LoadedSpecimen | undefined;
}) {
  // Moving between pages keeps the chosen theme filter and width.
  const view = { theme: route.theme, phone: route.phone };
  return (
    <>
      <a
        className={styles.navBrand}
        href="#/"
        aria-current={route.target ? undefined : "page"}
      >
        YA design playground
      </a>
      {DESIGN_LAYERS.map((layer) => {
        const group = specimens.filter(
          (specimen) => specimen.parameters.layer === layer,
        );
        if (!group.length) return null;
        return (
          <section key={layer} className={styles.navGroup}>
            <h2 className={styles.navGroupTitle}>{LAYER_LABELS[layer]}</h2>
            <ul className={styles.navList}>
              {group.map((specimen) => (
                <li key={specimen.id}>
                  <a
                    className={styles.navLink}
                    href={routeHref(specimen.id, view)}
                    aria-current={
                      route.target === specimen.id ? "page" : undefined
                    }
                  >
                    {specimen.title}
                  </a>
                  {specimen === activeSpecimen ? (
                    <ul className={styles.navStates}>
                      {specimen.states.map((state) => (
                        <li key={state.id}>
                          <a
                            className={styles.navLink}
                            href={routeHref(state.id, view)}
                            aria-current={
                              route.target === state.id ? "page" : undefined
                            }
                          >
                            {state.name}
                          </a>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ul>
          </section>
        );
      })}
    </>
  );
}

/**
 * Persistent sidebar beside every page except isolated states. On narrow
 * screens it becomes a drawer behind a "Pages" button that closes on
 * navigation, on Escape and on a tap outside it.
 */
function Shell({
  route,
  activeSpecimen,
  heading,
  children,
}: {
  route: DesignRoute;
  activeSpecimen: LoadedSpecimen | undefined;
  heading: string;
  children: ReactNode;
}) {
  // Open for one page only: following a link changes the target, which
  // closes the drawer without an effect.
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === route.target;
  const setOpen = (value: boolean) => setOpenOn(value ? route.target : null);
  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenOn(null);
    };
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);
  return (
    <div className={styles.shell}>
      <div className={styles.mobileBar}>
        <button
          type="button"
          className={styles.menuButton}
          aria-expanded={open}
          aria-controls="design-nav"
          onClick={() => setOpen(!open)}
        >
          Pages
        </button>
        <span className={styles.mobileTitle}>{heading}</span>
      </div>
      {open ? (
        <div
          className={styles.backdrop}
          aria-hidden="true"
          onClick={() => setOpen(false)}
        />
      ) : null}
      <nav
        id="design-nav"
        className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}
        aria-label="Playground pages"
      >
        <Sidebar route={route} activeSpecimen={activeSpecimen} />
      </nav>
      <div className={styles.main}>{children}</div>
    </div>
  );
}

function NotFound({ target }: { target: string }) {
  return (
    <div className={styles.page}>
      <h1>Nothing at “{target}”</h1>
      <p>
        <a href="#/">Back to the index</a>
      </p>
    </div>
  );
}

export function DesignApp() {
  const route = useDesignRoute();
  // Pages outside isolation show every theme in their own cells; the
  // document itself stays dark so the shell reads the same everywhere.
  useLayoutEffect(() => {
    if (!route.iso) document.documentElement.dataset.theme = "dark";
  }, [route.iso]);
  const found = route.target ? findTarget(route.target) : undefined;
  if (route.iso && found?.state)
    return (
      <IsolatedState
        specimen={found.specimen}
        state={found.state}
        theme={route.theme ?? "dark"}
      />
    );
  const heading = !route.target
    ? "Index"
    : found
      ? (found.state?.name ?? found.specimen.title)
      : "Not found";
  return (
    <Shell route={route} activeSpecimen={found?.specimen} heading={heading}>
      {!route.target ? (
        <IndexPage />
      ) : found ? (
        <GridPage specimen={found.specimen} only={found.state} route={route} />
      ) : (
        <NotFound target={route.target} />
      )}
    </Shell>
  );
}
