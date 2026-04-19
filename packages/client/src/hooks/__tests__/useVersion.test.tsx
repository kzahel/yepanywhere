import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";

vi.mock("../../api/client", () => ({
  api: {
    getVersion: vi.fn(),
  },
}));

describe("useVersion", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it("shares one in-flight version request across multiple hook instances", async () => {
    const getVersion = vi.mocked(api.getVersion);
    getVersion.mockResolvedValue({
      current: "0.4.28",
      latest: null,
      updateAvailable: false,
      resumeProtocolVersion: 2,
      capabilities: ["git-status"],
    });

    const { useVersion } = await import("../useVersion");
    const first = renderHook(() => useVersion());
    const second = renderHook(() => useVersion());

    await waitFor(() => {
      expect(first.result.current.version?.current).toBe("0.4.28");
      expect(second.result.current.version?.current).toBe("0.4.28");
    });

    expect(getVersion).toHaveBeenCalledTimes(1);
  });
});
