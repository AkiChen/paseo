import React, { useCallback, useMemo } from "react";
import { View } from "react-native";
import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import {
  ClipboardList,
  Copy,
  Ellipsis,
  Globe,
  Import as ImportIcon,
  Settings,
  Trash2,
} from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
  iconButtonChromeStyle,
  useIconButtonChromeStyle,
} from "@/components/ui/icon-button-chrome";
import { TerminalProfileIcon } from "@/components/terminal-profile-icon";
import { useDaemonConfig } from "@/hooks/use-daemon-config";
import {
  getTerminalProfileIcon,
  resolveTerminalProfiles,
} from "@getpaseo/protocol/terminal-profiles";
import { buildSettingsHostSectionRoute } from "@/utils/host-routes";
import type { Theme } from "@/styles/theme";
import {
  useWorkspaceScriptsMenuPages,
  type UseWorkspaceScriptsMenuPagesInput,
} from "@/screens/workspace/scripts";

const ThemedEllipsis = withUnistyles(Ellipsis);
const ThemedCopy = withUnistyles(Copy);
const ThemedGlobe = withUnistyles(Globe);
const ThemedImport = withUnistyles(ImportIcon);
const ThemedSettings = withUnistyles(Settings);
const ThemedTrash = withUnistyles(Trash2);
const ThemedClipboardList = withUnistyles(ClipboardList);

const mutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });

const MENU_NEW_BROWSER_ICON = <ThemedGlobe size={16} uniProps={mutedColorMapping} />;
const MENU_IMPORT_ICON = <ThemedImport size={16} uniProps={mutedColorMapping} />;
const MENU_COPY_ICON = <ThemedCopy size={16} uniProps={mutedColorMapping} />;
const MENU_SETTINGS_ICON = <ThemedSettings size={16} uniProps={mutedColorMapping} />;
const MENU_DELETE_AGENT_ICON = <ThemedTrash size={16} uniProps={destructiveColorMapping} />;
const MENU_WORK_LEDGER_ICON = <ThemedClipboardList size={16} uniProps={mutedColorMapping} />;
function WorkspaceHeaderMenuTriggerIcon() {
  return (
    <ThemedEllipsis
      size={iconButtonChromeGlyphSize("large")}
      uniProps={extraMutedIconColorMapping}
    />
  );
}

/** The ⋯ with a dot on it, for when something inside the menu needs looking at. */
function WorkspaceHeaderMenuAttentionTriggerIcon() {
  return (
    <View>
      <WorkspaceHeaderMenuTriggerIcon />
      <View style={styles.attentionDot} testID="workspace-header-menu-attention" />
    </View>
  );
}

/**
 * The compact header buttons draw at 32pt, under the 44pt touch minimum, and sit flush against
 * each other — so the slop can only grow vertically. Widening it would put two buttons' slop over
 * the same pixels, which is a worse miss than a small target.
 */
const COMPACT_HEADER_BUTTON_HIT_SLOP = { top: 8, bottom: 8 } as const;

/**
 * Actions that belong to the workspace itself rather than to a tab. Both header menus render them,
 * from the same callbacks, so the two surfaces can't drift.
 */
export interface WorkspaceHeaderWorkspaceActions {
  currentBranchName: string | null;
  showWorkspaceSetup: boolean;
  importAgentDisabled: boolean;
  copyPathDisabled: boolean;
  onOpenImportSheet: () => void;
  onCopyWorkspacePath: () => void;
  onCopyBranchName: () => void;
  onOpenSetupTab: () => void;
}

function WorkspaceHeaderWorkspaceActionItems({
  currentBranchName,
  showWorkspaceSetup,
  importAgentDisabled,
  copyPathDisabled,
  onOpenImportSheet,
  onCopyWorkspacePath,
  onCopyBranchName,
  onOpenSetupTab,
}: WorkspaceHeaderWorkspaceActions) {
  const { t } = useTranslation();
  const router = useRouter();
  // The work index spans every connected daemon, so it is not a workspace action a
  // caller passes in; it lives here because this menu is always reachable.
  const onOpenWorkLedger = useCallback(() => {
    router.push("/work-ledger" as Href);
  }, [router]);
  return (
    <>
      <DropdownMenuItem
        testID="workspace-header-copy-path"
        leading={MENU_COPY_ICON}
        disabled={copyPathDisabled}
        onSelect={onCopyWorkspacePath}
      >
        {t("workspace.header.actions.copyPath")}
      </DropdownMenuItem>
      {currentBranchName ? (
        <DropdownMenuItem
          testID="workspace-header-copy-branch-name"
          leading={MENU_COPY_ICON}
          onSelect={onCopyBranchName}
        >
          {t("workspace.header.actions.copyBranchName")}
        </DropdownMenuItem>
      ) : null}
      <DropdownMenuItem
        testID="workspace-header-import-agent"
        leading={MENU_IMPORT_ICON}
        disabled={importAgentDisabled}
        onSelect={onOpenImportSheet}
      >
        {t("workspace.header.actions.importSession")}
      </DropdownMenuItem>
      {/* The header popup is scoped to this host; this is where a user goes to see
          the index across every connected daemon. */}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        testID="workspace-header-open-work-ledger"
        leading={MENU_WORK_LEDGER_ICON}
        onSelect={onOpenWorkLedger}
      >
        {t("workLedger.popup.open")}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      {showWorkspaceSetup ? (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            testID="workspace-header-show-setup"
            leading={MENU_SETTINGS_ICON}
            onSelect={onOpenSetupTab}
          >
            {t("workspace.header.actions.showSetup")}
          </DropdownMenuItem>
        </>
      ) : null}
    </>
  );
}

/**
 * Agent-scoped actions live in the same header menu as the workspace ones, but only while an
 * agent tab is focused. The menu must not offer to delete an agent when the focused tab is a
 * terminal or a file.
 */
export interface WorkspaceHeaderAgentActions {
  onDelete: () => void;
}

function WorkspaceHeaderAgentActionItem({ onDelete }: WorkspaceHeaderAgentActions) {
  const { t } = useTranslation();
  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        destructive
        leading={MENU_DELETE_AGENT_ICON}
        onSelect={onDelete}
        testID="workspace-header-delete-agent"
      >
        {t("agentDelete.currentAgentAction")}
      </DropdownMenuItem>
    </>
  );
}

function workspaceHeaderMenuButtonStyle({
  hovered,
  pressed,
  open,
}: {
  hovered: boolean;
  pressed: boolean;
  open: boolean;
}) {
  return iconButtonChromeStyle({ size: "large", state: { hovered, pressed, open } });
}

/**
 * Wide layouts make tabs from the tab strip's `+` menu, so this one carries workspace actions only.
 */
export interface WorkspaceHeaderMenuDesktopProps extends WorkspaceHeaderWorkspaceActions {
  agentActions?: WorkspaceHeaderAgentActions | null;
}

export function WorkspaceHeaderMenuDesktop({
  agentActions,
  ...workspaceActions
}: WorkspaceHeaderMenuDesktopProps) {
  const { t } = useTranslation();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID="workspace-header-menu-trigger"
        style={workspaceHeaderMenuButtonStyle}
        accessibilityRole="button"
        accessibilityLabel={t("workspace.header.actions.workspaceActions")}
      >
        <WorkspaceHeaderMenuTriggerIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" width={220} testID="workspace-header-menu">
        <WorkspaceHeaderWorkspaceActionItems {...workspaceActions} />
        {agentActions ? <WorkspaceHeaderAgentActionItem {...agentActions} /> : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

interface HeaderMenuProfileItemProps {
  profile: TerminalProfile;
  disabled: boolean;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
}

function HeaderMenuProfileItem({
  profile,
  disabled,
  onCreateTerminalWithProfile,
}: HeaderMenuProfileItemProps) {
  const handleSelect = useCallback(() => {
    onCreateTerminalWithProfile(profile);
  }, [onCreateTerminalWithProfile, profile]);

  const leading = useMemo(
    () => (
      <View style={styles.headerMenuProfileIconWrapper}>
        <TerminalProfileIcon iconKey={getTerminalProfileIcon(profile)} size={16} />
      </View>
    ),
    [profile],
  );

  return (
    <DropdownMenuItem leading={leading} disabled={disabled} onSelect={handleSelect}>
      {profile.name}
    </DropdownMenuItem>
  );
}

export interface WorkspaceHeaderMenuMobileProps extends WorkspaceHeaderWorkspaceActions {
  normalizedServerId: string;
  scripts: UseWorkspaceScriptsMenuPagesInput;
  showCreateBrowserTab: boolean;
  createTerminalDisabled: boolean;
  agentActions?: WorkspaceHeaderAgentActions | null;
  onCreateDraftTab: () => void;
  onCreateTerminal: () => void;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
  onCreateBrowser: () => void;
}

/**
 * Compact layouts have no tab strip. New agent and New terminal sit in the tab switcher's footer;
 * the rarer launches stay here alongside the workspace actions.
 *
 * The header has no room for a scripts button either, so scripts are a page of this menu, and the
 * ⋯ carries a dot while a running service is unhealthy.
 */
export function WorkspaceHeaderMenuMobile({
  normalizedServerId,
  scripts,
  showCreateBrowserTab,
  createTerminalDisabled,
  onCreateTerminalWithProfile,
  onCreateBrowser,
  agentActions,
  ...workspaceActions
}: WorkspaceHeaderMenuMobileProps) {
  const { t } = useTranslation();
  const router = useRouter();
  const triggerStyle = useIconButtonChromeStyle({ size: "large" });
  const { config } = useDaemonConfig(normalizedServerId);
  const profiles = useMemo(
    () => resolveTerminalProfiles(config?.terminalProfiles),
    [config?.terminalProfiles],
  );

  const handleEditProfiles = useCallback(() => {
    router.push(buildSettingsHostSectionRoute(normalizedServerId, "terminals") as Href);
  }, [normalizedServerId, router]);
  const scriptsMenu = useWorkspaceScriptsMenuPages(scripts);

  return (
    <DropdownMenu compactMode="sheet">
      <DropdownMenuTrigger
        testID="workspace-header-menu-trigger"
        style={triggerStyle}
        hitSlop={COMPACT_HEADER_BUTTON_HIT_SLOP}
        accessibilityRole="button"
        accessibilityLabel={
          scriptsMenu.needsAttention
            ? t("workspace.header.actions.workspaceActionsUnhealthy")
            : t("workspace.header.actions.workspaceActions")
        }
      >
        {scriptsMenu.needsAttention ? (
          <WorkspaceHeaderMenuAttentionTriggerIcon />
        ) : (
          <WorkspaceHeaderMenuTriggerIcon />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        width={220}
        testID="workspace-header-menu"
        pages={scriptsMenu.pages}
        sheetTitle={t("workspace.header.actions.workspaceActions")}
      >
        {scriptsMenu.trigger}
        {showCreateBrowserTab ? (
          <DropdownMenuItem
            testID="workspace-header-new-browser"
            leading={MENU_NEW_BROWSER_ICON}
            onSelect={onCreateBrowser}
          >
            {t("workspace.header.actions.newBrowser")}
          </DropdownMenuItem>
        ) : null}
        <WorkspaceHeaderWorkspaceActionItems {...workspaceActions} />
        {agentActions ? <WorkspaceHeaderAgentActionItem {...agentActions} /> : null}
        <DropdownMenuSeparator />
        <DropdownMenuLabel>{t("workspace.tabs.actions.terminalProfilesMenu")}</DropdownMenuLabel>
        {profiles.map((profile) => (
          <HeaderMenuProfileItem
            key={profile.id}
            profile={profile}
            disabled={createTerminalDisabled}
            onCreateTerminalWithProfile={onCreateTerminalWithProfile}
          />
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          testID="workspace-header-edit-terminal-profiles"
          onSelect={handleEditProfiles}
        >
          {t("workspace.tabs.actions.editTerminalProfiles")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const ATTENTION_DOT_SIZE = 6;

const styles = StyleSheet.create((theme) => ({
  headerMenuProfileIconWrapper: {
    width: 16,
    height: 16,
  },
  // Same red as the Scripts row's unhealthy ▶, so the dot and the row it leads to agree.
  attentionDot: {
    position: "absolute",
    top: -1,
    right: -2,
    width: ATTENTION_DOT_SIZE,
    height: ATTENTION_DOT_SIZE,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.palette.red[500],
  },
}));
