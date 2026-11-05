import { beforeEach } from "vitest";
import { invalidateLocalStorageValues } from "./src/lib/localStorageValue";
import { invalidateSessionApps } from "./src/lib/sessionApps";

function createTestStorage(): Storage {
  const storage = new Map<string, string>();

  return {
    get length() {
      return storage.size;
    },
    clear() {
      storage.clear();
    },
    getItem(key: string) {
      return storage.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(storage.keys())[index] ?? null;
    },
    removeItem(key: string) {
      storage.delete(key);
    },
    setItem(key: string, value: string) {
      storage.set(key, value);
    },
  };
}

// Do not probe window.localStorage first: Node 25's webstorage getter warns
// unless --localstorage-file has a valid path.
if (typeof window !== "undefined") {
  // jsdom has no layout engine or resize observer. Structural renderer tests
  // need the browser API to mount; geometry/notification tests supply their
  // own observer, and real scrolling is qualified in the browser suite.
  if (typeof globalThis.ResizeObserver === "undefined") {
    const Observer = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
    Object.defineProperty(globalThis, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: Observer,
    });
    Object.defineProperty(window, "ResizeObserver", {
      configurable: true,
      writable: true,
      value: Observer,
    });
  }
  // jsdom has no media-query evaluator. Tests can override matches/events
  // when exercising responsive behavior or reduced-motion preferences.
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: (media: string) => {
      const events = new EventTarget();
      return {
        media,
        matches: false,
        onchange: null,
        addEventListener: events.addEventListener.bind(events),
        removeEventListener: events.removeEventListener.bind(events),
        dispatchEvent: events.dispatchEvent.bind(events),
        addListener: (listener: EventListener) =>
          events.addEventListener("change", listener),
        removeListener: (listener: EventListener) =>
          events.removeEventListener("change", listener),
      };
    },
  });
  for (const name of ["localStorage", "sessionStorage"] as const) {
    const storage = createTestStorage();
    Object.defineProperty(window, name, {
      configurable: true,
      value: storage,
    });
    Object.defineProperty(globalThis, name, {
      configurable: true,
      value: storage,
    });
  }
}

// Client unit tests have no server, yet mounted components still request
// relative URLs such as `/api/settings` and `/api/local-image`. Node rejects
// those a few ticks later; cleanup usually unmounts first, but on a loaded host
// the rejection lands while the component is mounted and its error state
// updates React outside act(). Model the absent server as one that never
// answers; a test that needs a response mocks fetch or the source transport.
const unansweredFetch = Symbol.for("yep-anywhere.unansweredRelativeFetch");
const realFetch = globalThis.fetch as typeof fetch & {
  [unansweredFetch]?: true;
};
if (realFetch && !realFetch[unansweredFetch]) {
  const testFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    return URL.canParse(url)
      ? realFetch(input, init)
      : new Promise<Response>(() => {});
  }) as typeof fetch & { [unansweredFetch]?: true };
  testFetch[unansweredFetch] = true;
  globalThis.fetch = testFetch;
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
  invalidateLocalStorageValues();
  invalidateSessionApps();
});
