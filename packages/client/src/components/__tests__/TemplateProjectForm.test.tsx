// @vitest-environment jsdom
import "fake-indexeddb/auto";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { ToastProvider } from "../../contexts/ToastContext";
import { TemplateProjectForm } from "../TemplateProjectForm";
import type { TemplateCreationRequest } from "../../api/projectTemplatesClient";

vi.mock("../../hooks/useActingPrincipal", () => ({
  useActingPrincipal: () => ({ principal: { username: null }, resolved: true }),
}));

afterEach(() => {
  cleanup();
  sessionStorage.clear();
  vi.unstubAllGlobals();
});

const templates = [
  { id: "app", sourceId: "local", title: "App canvas", description: "Starter" },
];
const onStarted = vi.fn();
function form() {
  return render(
    <I18nProvider>
      <ToastProvider>
        <TemplateProjectForm
          templates={templates}
          projects={[]}
          pathBase="/projects"
          onStarted={onStarted}
        />
      </ToastProvider>
    </I18nProvider>,
  );
}

const fill = (name: string, intent: string) => {
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: name },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "What would you like to make?" }),
    { target: { value: intent } },
  );
};

it("keeps a single template as a radio and reopens an accepted creation by read after a lost response", async () => {
  const requests: TemplateCreationRequest[] = [];
  const reads: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") {
        requests.push(JSON.parse(String(init.body)));
        throw new Error("Connection lost");
      }
      if (!String(url).includes("/project-templates/operations/"))
        return Response.json({});
      reads.push(String(url));
      return Response.json({
        request: requests[0],
        phase: "started",
        log: "",
        projectId: "project",
        sessionId: "session",
      });
    }),
  );
  const rendered = form();
  expect(screen.getAllByRole("radio")).toHaveLength(1);
  expect(screen.queryByRole("combobox")).toBeNull();
  fill("Garden", "Sketch plants");
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  await screen.findByText("Connection lost");
  rendered.unmount();
  form();
  await waitFor(() =>
    expect(onStarted).toHaveBeenCalledWith("project", "session"),
  );
  // Reopening reads the saved operation; it never sends the creation again.
  expect(requests).toHaveLength(1);
  expect(reads).toHaveLength(1);
  expect(reads[0]).toContain(requests[0]!.operationId);
  expect(requests[0]).toMatchObject({
    path: "/projects/garden",
    name: "Garden",
    intent: "Sketch plants",
    templateId: "app",
    sourceId: "local",
  });
});

it("offers Start fresh when a restored creation cannot be confirmed, then creates corrected input independently", async () => {
  const requests: TemplateCreationRequest[] = [];
  let reachable = false;
  const busy = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method !== "POST")
        return Response.json({ error: "Operation not found" }, { status: 404 });
      if (!reachable) throw new Error("Connection lost");
      const request = JSON.parse(String(init.body)) as TemplateCreationRequest;
      requests.push(request);
      return Response.json({ request, phase: "setup", log: "" });
    }),
  );
  const mount = () =>
    render(
      <I18nProvider>
        <ToastProvider>
          <TemplateProjectForm
            templates={templates}
            projects={[]}
            pathBase="/projects"
            onBusyChange={busy}
            onStarted={onStarted}
          />
        </ToastProvider>
      </I18nProvider>,
    );
  const first = mount();
  fill("Garden", "Sketch plants");
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  await screen.findByText("Connection lost");
  const lost = JSON.parse(
    sessionStorage.getItem("ya-template-creation:local")!,
  ) as TemplateCreationRequest;
  first.unmount();
  reachable = true;
  mount();

  const fresh = await screen.findByRole("button", {
    name: "Start fresh and edit details",
  });
  expect(screen.getByText(/no record of it/)).toBeTruthy();
  const name = screen.getByRole("textbox", { name: "Name" });
  expect((name as HTMLInputElement).value).toBe("Garden");
  expect((name as HTMLInputElement).disabled).toBe(true);
  expect(requests).toHaveLength(0);

  fireEvent.click(fresh);
  expect((name as HTMLInputElement).disabled).toBe(false);
  expect(busy).toHaveBeenLastCalledWith(false);
  expect(sessionStorage.getItem("ya-template-creation:local")).toBeNull();
  expect(
    (
      screen.getByRole("textbox", {
        name: "What would you like to make?",
      }) as HTMLTextAreaElement
    ).value,
  ).toBe("Sketch plants");
  fill("Orchard", "Sketch trees");
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    name: "Orchard",
    intent: "Sketch trees",
  });
  expect(requests[0]!.operationId).not.toBe(lost.operationId);
});

it("ignores a saved creation it cannot read", async () => {
  const fetch = vi.fn(async (_url: string) => Response.json({}));
  vi.stubGlobal("fetch", fetch);
  for (const damaged of ["{not json", JSON.stringify({ operationId: 7 })]) {
    sessionStorage.setItem("ya-template-creation:local", damaged);
    const rendered = form();
    const name = screen.getByRole("textbox", { name: "Name" });
    expect((name as HTMLInputElement).disabled).toBe(false);
    expect(sessionStorage.getItem("ya-template-creation:local")).toBeNull();
    rendered.unmount();
  }
  expect(
    fetch.mock.calls.filter(([url]) => url.includes("/project-templates/")),
  ).toHaveLength(0);
});

it("unlocks details after the server rejects a request before allocation", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json({ error: "Source changed" }, { status: 409 }),
    ),
  );
  form();
  const name = screen.getByRole("textbox", { name: "Name" });
  fireEvent.change(name, { target: { value: "Garden" } });
  fireEvent.change(
    screen.getByRole("textbox", { name: "What would you like to make?" }),
    { target: { value: "Sketch plants" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  await screen.findByText("Source changed");
  expect((name as HTMLInputElement).disabled).toBe(false);
});

it("shows progress immediately before the creation request returns", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => new Promise<Response>(() => {})),
  );
  form();
  fireEvent.change(screen.getByRole("textbox", { name: "Name" }), {
    target: { value: "Garden" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "What would you like to make?" }),
    { target: { value: "Sketch plants" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  expect(screen.getByText("Submitting project creation…")).toBeTruthy();
  expect(screen.getByText("Waiting for setup output…")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Hide setup log" })).toBeTruthy();
});

it("creates the template, name and path an enclosing form chose", async () => {
  const requests: TemplateCreationRequest[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const request = JSON.parse(String(init.body)) as TemplateCreationRequest;
      requests.push(request);
      return Response.json({ request, phase: "setup", log: "" });
    }),
  );
  render(
    <I18nProvider>
      <ToastProvider>
        <TemplateProjectForm
          templates={templates}
          projects={[]}
          pathBase="/projects"
          intent="Sketch plants"
          chosen={{ template: templates[0]!, name: "math", path: "~/math" }}
          onStarted={onStarted}
        />
      </ToastProvider>
    </I18nProvider>,
  );
  // The enclosing form owns the palette and the name.
  expect(screen.queryByRole("radio")).toBeNull();
  expect(screen.queryByRole("textbox", { name: "Name" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create & prepare" }));
  await waitFor(() => expect(requests).toHaveLength(1));
  expect(requests[0]).toMatchObject({
    sourceId: "local",
    templateId: "app",
    name: "math",
    path: "~/math",
    intent: "Sketch plants",
  });
});
