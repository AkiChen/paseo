/**
 * @vitest-environment jsdom
 */
import React, { type ReactElement } from "react";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceHeaderTitleEditor } from "@/screens/workspace/workspace-header-title-editor";

const { setWorkspaceTitleMock, toastErrorMock } = vi.hoisted(() => ({
  setWorkspaceTitleMock: vi.fn(async () => {}),
  toastErrorMock: vi.fn(),
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: "en" } }),
}));

vi.mock("@/contexts/toast-context", () => ({
  useToast: () => ({ error: toastErrorMock, show: vi.fn(), copied: vi.fn() }),
}));

vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getClient: () => ({ setWorkspaceTitle: setWorkspaceTitleMock }),
  }),
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) =>
      typeof factory === "function"
        ? factory({
            spacing: { 1: 4, 2: 8 },
            fontSize: { base: 15 },
            borderRadius: { md: 6 },
            colors: { foreground: "#fff", surface3: "#333" },
          })
        : factory,
  },
}));

vi.mock("@/components/ui/text-input", async () => {
  const ReactModule = await import("react");
  const EditingTextInput = ReactModule.forwardRef<HTMLInputElement, Record<string, unknown>>(
    (props, ref) => {
      const p = props as {
        initialValue?: string;
        onChangeText?: (next: string) => void;
        onSubmitEditing?: () => void;
        onBlur?: () => void;
        testID?: string;
      };
      return ReactModule.createElement("input", {
        ref,
        defaultValue: p.initialValue ?? "",
        "data-testid": p.testID,
        onChange: (event: { target: { value: string } }) => p.onChangeText?.(event.target.value),
        onBlur: () => p.onBlur?.(),
        onKeyDown: (event: { key: string }) => {
          if (event.key === "Enter") p.onSubmitEditing?.();
        },
      });
    },
  );
  return { EditingTextInput };
});

function renderEditor(title = "Old title"): ReturnType<typeof render> {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  const ui: ReactElement = (
    <QueryClientProvider client={queryClient}>
      <WorkspaceHeaderTitleEditor serverId="srv_1" workspaceId="wks_1" title={title} />
    </QueryClientProvider>
  );
  return render(ui);
}

function beginEditing(container: HTMLElement): HTMLInputElement {
  const trigger = container.querySelector<HTMLElement>(
    '[data-testid="workspace-header-title-edit"]',
  );
  if (!trigger) throw new Error("title trigger missing");
  act(() => {
    fireEvent.click(trigger);
  });
  const input = container.querySelector<HTMLInputElement>(
    '[data-testid="workspace-header-title-input"]',
  );
  if (!input) throw new Error("inline editor did not open");
  return input;
}

describe("WorkspaceHeaderTitleEditor", () => {
  beforeEach(() => {
    setWorkspaceTitleMock.mockReset();
  });

  // RTL's automatic cleanup does not run without the globals wiring; tests that leave an editor
  // open would otherwise stack a second header into the document.
  afterEach(() => {
    cleanup();
    toastErrorMock.mockReset();
  });

  it("shows the title and opens the inline editor when clicked", () => {
    const { container, getByTestId } = renderEditor();
    expect(getByTestId("workspace-header-title").textContent).toBe("Old title");

    const input = beginEditing(container);

    expect(input.value).toBe("Old title");
  });

  it("writes the trimmed title through setWorkspaceTitle on Enter", async () => {
    const { container, getByTestId } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.change(input, { target: { value: "  New title  " } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await vi.waitFor(() => {
      expect(setWorkspaceTitleMock).toHaveBeenCalledWith("wks_1", "New title");
    });
    await vi.waitFor(() => {
      expect(getByTestId("workspace-header-title").textContent).toBe("New title");
    });
  });

  it("saves once when Enter is followed by the blur it causes", async () => {
    const { container } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.change(input, { target: { value: "Renamed" } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
      fireEvent.blur(input);
    });

    await vi.waitFor(() => {
      expect(setWorkspaceTitleMock).toHaveBeenCalledTimes(1);
    });
  });

  it("abandons the draft on Escape", () => {
    const { container, getByTestId } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.change(input, { target: { value: "Discarded" } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Escape" });
    });

    expect(getByTestId("workspace-header-title").textContent).toBe("Old title");
    expect(setWorkspaceTitleMock).not.toHaveBeenCalled();
  });

  it("refuses an empty title and keeps the current one", async () => {
    const { container, getByTestId } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.change(input, { target: { value: "   " } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    expect(toastErrorMock).toHaveBeenCalledWith("common.errors.nameRequired");
    expect(setWorkspaceTitleMock).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      expect(getByTestId("workspace-header-title").textContent).toBe("Old title");
    });
  });

  it("keeps the current title and reports the failure when the daemon rejects", async () => {
    setWorkspaceTitleMock.mockRejectedValueOnce(new Error("Host is not connected"));
    const { container, getByTestId } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.change(input, { target: { value: "Another" } });
    });
    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await vi.waitFor(() => {
      expect(toastErrorMock).toHaveBeenCalledWith("Host is not connected");
    });
    expect(getByTestId("workspace-header-title").textContent).toBe("Old title");
  });

  it("does not write when the title is unchanged", async () => {
    const { container, getByTestId } = renderEditor();
    const input = beginEditing(container);

    act(() => {
      fireEvent.keyDown(input, { key: "Enter" });
    });

    await vi.waitFor(() => {
      expect(container.querySelector('[data-testid="workspace-header-title-input"]')).toBeNull();
    });
    expect(setWorkspaceTitleMock).not.toHaveBeenCalled();
    expect(getByTestId("workspace-header-title").textContent).toBe("Old title");
  });
});
