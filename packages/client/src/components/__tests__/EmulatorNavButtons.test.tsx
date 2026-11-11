import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../i18n";
import { EmulatorNavButtons } from "../EmulatorNavButtons";

function createDataChannel() {
  return {
    readyState: "open",
    send: vi.fn(),
  } as unknown as RTCDataChannel;
}

function renderNavigation(
  dataChannel: RTCDataChannel | null,
  deviceType: "android" | "chromeos" | "emulator" | "ios-simulator",
) {
  return render(
    <I18nProvider>
      <EmulatorNavButtons dataChannel={dataChannel} deviceType={deviceType} />
    </I18nProvider>,
  );
}

describe("EmulatorNavButtons", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders Android navigation controls for Android devices", () => {
    const dataChannel = createDataChannel();

    renderNavigation(dataChannel, "android");

    const navigation = screen.getByRole("group", {
      name: "Device navigation",
    });
    expect(navigation).toBeDefined();
    expect(screen.getByRole("button", { name: "Back" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Recents" })).toBeDefined();
  });

  it("sends the Android key message for each navigation button", () => {
    const dataChannel = createDataChannel();

    renderNavigation(dataChannel, "emulator");

    for (const [name, key] of [
      ["Back", "GoBack"],
      ["Home", "GoHome"],
      ["Recents", "AppSwitch"],
    ]) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(dataChannel.send).toHaveBeenCalledWith(
        JSON.stringify({ type: "key", key }),
      );
    }
  });

  it("disables the buttons and sends nothing until the channel opens", () => {
    const dataChannel = {
      readyState: "connecting",
      send: vi.fn(),
    } as unknown as RTCDataChannel;

    renderNavigation(dataChannel, "android");

    const home = screen.getByRole("button", { name: "Home" });
    expect(home.hasAttribute("disabled")).toBe(true);

    fireEvent.click(home);
    expect(dataChannel.send).not.toHaveBeenCalled();
  });

  it("disables the buttons when there is no data channel", () => {
    renderNavigation(null, "ios-simulator");

    expect(
      screen.getByRole("button", { name: "Home" }).hasAttribute("disabled"),
    ).toBe(true);
  });

  it("styles the root and buttons from the co-located CSS Module", () => {
    const dataChannel = createDataChannel();
    const { container } = renderNavigation(dataChannel, "android");

    const root = container.firstElementChild as HTMLElement;
    const buttons = Array.from(root.querySelectorAll("button"));

    expect(root.className).not.toBe("");
    expect(buttons).toHaveLength(3);
    for (const button of buttons) {
      expect(button.className).not.toBe("");
      expect(button.className).not.toBe(root.className);
    }
  });

  it("renders only Home for iOS simulators and sends GoHome", () => {
    const dataChannel = createDataChannel();

    renderNavigation(dataChannel, "ios-simulator");

    expect(screen.queryByRole("button", { name: "Back" })).toBeNull();
    expect(screen.getByRole("button", { name: "Home" })).toBeDefined();
    expect(screen.queryByRole("button", { name: "Recents" })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(dataChannel.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "key", key: "GoHome" }),
    );
  });

  it("renders nothing for unsupported device types", () => {
    const dataChannel = createDataChannel();
    const { container } = renderNavigation(dataChannel, "chromeos");

    expect(container.firstChild).toBeNull();
  });
});
