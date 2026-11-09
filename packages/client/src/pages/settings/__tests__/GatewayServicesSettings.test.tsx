// @vitest-environment jsdom

import { act, fireEvent, render, screen } from "@testing-library/react";
import type { GatewayService } from "@yep-anywhere/shared";
import { useSyncExternalStore } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerSettings } from "../../../api/client";
import { GatewayServicesSettings } from "../GatewayServicesSettings";

/**
 * A settings store that behaves like useServerSettings: a save's answer
 * replaces the settings everyone renders and only then resolves the save.
 * Each save waits until the test answers it, so typing can happen while one
 * is in flight.
 */
const { store } = vi.hoisted(() => ({
  store: {
    settings: {} as ServerSettings,
    listeners: new Set<() => void>(),
    pending: [] as Array<{
      updates: Partial<ServerSettings>;
      answer: (
        normalize?: (settings: ServerSettings) => ServerSettings,
      ) => void;
    }>,
  },
}));

function publish(settings: ServerSettings) {
  store.settings = settings;
  for (const listener of store.listeners) listener();
}

vi.mock("../../../hooks/useServerSettings", () => ({
  useServerSettings: () => ({
    settings: useSyncExternalStore(
      (listener) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      () => store.settings,
    ),
    isLoading: false,
    error: null,
    updateSetting: vi.fn(),
    updateSettings: (updates: Partial<ServerSettings>) =>
      new Promise<ServerSettings>((resolve) => {
        store.pending.push({
          updates,
          answer: (normalize = (settings) => settings) => {
            const accepted = normalize({ ...store.settings, ...updates });
            publish(accepted);
            resolve(accepted);
          },
        });
      }),
    refetch: vi.fn(),
  }),
}));

vi.mock("../../../i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const vllm: GatewayService = {
  id: "vllm",
  label: "",
  shortName: "",
  url: "http://127.0.0.1:8001",
  enabled: true,
  autoStop: false,
  autoStopAfterSeconds: 300,
  codexEnabled: false,
  codexWireApi: "responses",
};

/** Type one character at a time, as a keyboard does. */
function typeSequentially(input: HTMLElement, text: string) {
  for (const character of text) {
    const current = (input as HTMLInputElement).value;
    fireEvent.change(input, { target: { value: current + character } });
  }
}

async function answerNextSave(
  normalize?: (settings: ServerSettings) => ServerSettings,
) {
  const next = store.pending.shift();
  expect(next).toBeDefined();
  await act(async () => {
    next!.answer(normalize);
  });
}

describe("GatewayServicesSettings saving", () => {
  const reloadProviders = vi.fn(async () => {});

  beforeEach(() => {
    store.listeners.clear();
    store.pending = [];
    store.settings = {
      serviceWorkerEnabled: true,
      persistRemoteSessionsToDisk: false,
      gatewayServices: [vllm],
      defaultGatewayServiceId: "vllm",
    };
    reloadProviders.mockClear();
  });

  it("keeps what is typed in the next field while the last field saves", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    const shortName = screen.getByRole("textbox", {
      name: "providersGatewayServiceShortNameLabel",
    });
    typeSequentially(shortName, "gpu");
    fireEvent.blur(shortName);
    expect(store.pending).toHaveLength(1);

    // Tab on and keep typing while that save is still out.
    const context = screen.getByRole("spinbutton", {
      name: "providersGatewayServiceContextLabel",
    });
    typeSequentially(context, "252");
    fireEvent.blur(context);
    // The second save waits for the first instead of racing it.
    expect(store.pending).toHaveLength(1);

    await answerNextSave();

    expect(shortName).toHaveProperty("value", "gpu");
    expect(context).toHaveProperty("value", "252");

    // Then the waiting save sends the draft as it stands, both fields in it.
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0]!.updates.gatewayServices).toEqual([
      expect.objectContaining({ shortName: "gpu", contextWindowTokens: 252 }),
    ]);
    await answerNextSave();

    expect(context).toHaveProperty("value", "252");
    expect(store.pending).toHaveLength(0);
    expect(reloadProviders).toHaveBeenCalledTimes(2);
    expect(screen.getByText("providersGatewayServiceAutoSaved")).toBeTruthy();
  });

  it("keeps typing into the saved entry itself while its save is out", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    const shortName = screen.getByRole("textbox", {
      name: "providersGatewayServiceShortNameLabel",
    });
    typeSequentially(shortName, "gp");
    fireEvent.blur(shortName);
    fireEvent.focus(shortName);
    typeSequentially(shortName, "u");

    await answerNextSave();

    expect(shortName).toHaveProperty("value", "gpu");
    expect(screen.getByText("providersGatewayServicePendingBlur")).toBeTruthy();
  });

  it("shows the saved copy of an entry nobody has changed since sending", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    const url = screen.getByRole("textbox", {
      name: "providersGatewayServiceUrlLabel",
    });
    fireEvent.change(url, { target: { value: "http://127.0.0.1:8002/" } });
    fireEvent.blur(url);

    // The server stores the endpoint without its trailing slash.
    await answerNextSave((settings) => ({
      ...settings,
      gatewayServices: settings.gatewayServices?.map((service) => ({
        ...service,
        url: service.url.replace(/\/$/u, ""),
      })),
    }));

    expect(url).toHaveProperty("value", "http://127.0.0.1:8002");
    expect(screen.getByText("providersGatewayServiceAutoSaved")).toBeTruthy();
  });

  it("saves an added service only once its endpoint has been entered", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    fireEvent.click(
      screen.getByRole("button", { name: "providersGatewayServiceAdd" }),
    );
    const url = screen.getAllByRole("textbox", {
      name: "providersGatewayServiceUrlLabel",
    })[1]!;
    expect(url).toHaveProperty("value", "");
    expect(store.pending).toHaveLength(0);

    // Operating the new entry, or another one, does not publish it yet.
    fireEvent.click(
      screen.getAllByRole("checkbox", {
        name: "providersGatewayServiceCodex",
      })[1]!,
    );
    expect(store.pending).toHaveLength(0);
    const shortName = screen.getAllByRole("textbox", {
      name: "providersGatewayServiceShortNameLabel",
    })[0]!;
    typeSequentially(shortName, "gpu");
    fireEvent.blur(shortName);
    expect(store.pending).toHaveLength(1);
    expect(store.pending[0]!.updates.gatewayServices).toEqual([
      expect.objectContaining({ id: "vllm", shortName: "gpu" }),
    ]);
    await answerNextSave();
    fireEvent.blur(url);
    expect(store.pending).toHaveLength(0);

    fireEvent.change(url, { target: { value: "http://127.0.0.1:9000" } });
    fireEvent.blur(url);

    expect(store.pending).toHaveLength(1);
    expect(store.pending[0]!.updates.gatewayServices).toEqual([
      expect.objectContaining({ id: "vllm" }),
      expect.objectContaining({
        id: "127-0-0-1-9000",
        url: "http://127.0.0.1:9000",
        codexEnabled: false,
      }),
    ]);
    await answerNextSave();
    expect(screen.getByText("providersGatewayServiceAutoSaved")).toBeTruthy();
  });

  it("drops an added service removed before its endpoint was entered", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    fireEvent.click(
      screen.getByRole("button", { name: "providersGatewayServiceAdd" }),
    );
    const id = screen.getAllByRole("textbox", {
      name: "providersGatewayServiceIdAria",
    })[1]!;
    fireEvent.change(id, { target: { value: "spare" } });
    fireEvent.blur(id);
    fireEvent.click(
      screen.getAllByRole("button", {
        name: "providersGatewayServiceRemove",
      })[1]!,
    );

    expect(store.pending).toHaveLength(0);
    expect(
      screen.getAllByRole("textbox", {
        name: "providersGatewayServiceUrlLabel",
      }),
    ).toHaveLength(1);
    expect(screen.getByText("providersGatewayServiceAutoSaved")).toBeTruthy();
  });

  it("takes a list saved elsewhere when nothing here is unsaved", async () => {
    render(<GatewayServicesSettings reloadProviders={reloadProviders} />);

    act(() => {
      publish({
        ...store.settings,
        gatewayServices: [
          vllm,
          { ...vllm, id: "copilot", url: "http://127.0.0.1:4141" },
        ],
      });
    });

    expect(
      screen.getAllByRole("textbox", {
        name: "providersGatewayServiceUrlLabel",
      }),
    ).toHaveLength(2);
  });
});
