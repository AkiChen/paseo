import { useCallback } from "react";
import { useMutation } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

export interface WorkspaceHeaderRenameInput {
  serverId: string;
  /**
   * The descriptor id, not the route id: the route carries an opaque workspace
   * id, and setWorkspaceTitle rejects anything else.
   */
  workspaceId: string;
  currentTitle: string;
}

export interface WorkspaceHeaderRename {
  /**
   * Write `nextTitle` as the workspace title and return the title the write
   * settled on. An empty value clears the title, which puts the header back on
   * the derived name (`moravla5`, the branch).
   */
  rename: (input: WorkspaceHeaderRenameInput, nextTitle: string) => Promise<string>;
}

/**
 * The header's title edit writes through the same `setWorkspaceTitle` mutation the sidebar's
 * rename dialog uses, so both surfaces agree on validation, errors, and what the title means.
 * A failed write surfaces as a toast because the inline editor closes itself before the
 * request settles.
 */
export function useWorkspaceHeaderRename(): WorkspaceHeaderRename {
  const { t } = useTranslation();
  const toast = useToast();
  const mutation = useMutation({
    mutationFn: async (input: { workspace: WorkspaceHeaderRenameInput; title: string | null }) => {
      const client = getHostRuntimeStore().getClient(input.workspace.serverId);
      if (!client) {
        throw new Error(t("sidebar.workspace.toasts.hostDisconnected"));
      }
      await client.setWorkspaceTitle(input.workspace.workspaceId, input.title);
    },
  });
  const mutateAsync = mutation.mutateAsync;

  const rename = useCallback(
    async (input: WorkspaceHeaderRenameInput, nextTitle: string) => {
      const trimmed = nextTitle.trim();
      if (trimmed === input.currentTitle.trim()) {
        return input.currentTitle;
      }
      if (!trimmed) {
        toast.error(t("common.errors.nameRequired"));
        return input.currentTitle;
      }
      try {
        await mutateAsync({ workspace: input, title: trimmed });
      } catch (error) {
        toast.error(
          error instanceof Error && error.message ? error.message : t("common.errors.unableToSave"),
        );
        return input.currentTitle;
      }
      return trimmed;
    },
    [mutateAsync, t, toast],
  );

  return { rename };
}
