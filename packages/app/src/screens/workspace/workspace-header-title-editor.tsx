import React, {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useTranslation } from "react-i18next";
import {
  Pressable,
  Text,
  View,
  type NativeSyntheticEvent,
  type TextInputKeyPressEventData,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { isWeb } from "@/constants/platform";
import { EditingTextInput } from "@/components/ui/text-input";
import { useWorkspaceHeaderRename } from "@/screens/workspace/use-workspace-header-rename";
import { isImeComposingKeyboardEvent } from "@/utils/keyboard-ime";

/** The same ceiling the tab rename dialog uses; the daemon stores the string verbatim. */
const MAX_TITLE_LENGTH = 200;

export interface WorkspaceHeaderTitleEditorProps {
  serverId: string;
  workspaceId: string;
  title: string;
}

/**
 * The workspace title in the header, editable in place: click it, type, Enter or click away to
 * save, Escape to abandon. The write goes through `setWorkspaceTitle`, so it lands in the same
 * field the sidebar's rename dialog writes and the daemon's descriptor repaints both surfaces.
 *
 * The title is also the workspace's only identity on this screen — it is the focused agent tab's
 * workspace, and there is no second place to click. That is why the edit lives here rather than
 * behind a menu.
 */
export function WorkspaceHeaderTitleEditor({
  serverId,
  workspaceId,
  title,
}: WorkspaceHeaderTitleEditorProps) {
  const { t } = useTranslation();
  const { rename } = useWorkspaceHeaderRename();
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState(title);
  const [isHovered, setIsHovered] = useState(false);
  // The descriptor only carries the new title after the daemon echoes it back, so the header
  // would show the old name for a round trip after a save it already knows succeeded. Hold the
  // written value until the descriptor catches up.
  const [writtenTitle, setWrittenTitle] = useState<string | null>(null);
  // Enter and blur both end an edit, and Escape unmounts the input mid-keystroke. One flag keeps
  // the first outcome and drops the rest.
  const settledRef = useRef(false);
  const titleText = writtenTitle ?? title;

  useEffect(() => {
    setWrittenTitle(null);
  }, [title]);

  const beginEditing = useCallback(() => {
    settledRef.current = false;
    setDraft(titleText);
    setIsEditing(true);
  }, [titleText]);

  const commit = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    setIsEditing(false);
    void rename({ serverId, workspaceId, currentTitle: titleText }, draft).then((settled) => {
      if (settled !== titleText) {
        setWrittenTitle(settled);
      }
      return settled;
    });
  }, [draft, rename, serverId, titleText, workspaceId]);

  const cancel = useCallback(() => {
    if (settledRef.current) {
      return;
    }
    settledRef.current = true;
    setIsEditing(false);
    setDraft(titleText);
  }, [titleText]);

  const handlePointerEnter = useCallback(() => setIsHovered(true), []);
  const handlePointerLeave = useCallback(() => setIsHovered(false), []);
  const handleWebKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || isImeComposingKeyboardEvent(event.nativeEvent)) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      cancel();
    },
    [cancel],
  );

  const handleKeyPress = useCallback(
    (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
      if (event.nativeEvent.key === "Escape") {
        cancel();
      }
    },
    [cancel],
  );

  return (
    // Enter, blur, and Escape are all ways out of the edit. On web the first thing Escape reaches
    // is a DOM keydown: Pressable treats a keydown as a click, so the event would bubble out of
    // the title and back into the button, putting the editor straight back open. This handler runs
    // on the way down and stops that, for both the button and the input it swaps in.
    <View
      style={isEditing ? styles.editorShell : styles.hoverRegion}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      {...(isWeb
        ? {
            onKeyDown: handleWebKeyDown,
          }
        : {})}
    >
      {isEditing ? (
        <EditingTextInput
          autoFocus
          initialValue={titleText}
          onChangeText={setDraft}
          onSubmitEditing={commit}
          onBlur={commit}
          onKeyPress={handleKeyPress}
          selectTextOnFocus
          maxLength={MAX_TITLE_LENGTH}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.editorInput}
          testID="workspace-header-title-input"
        />
      ) : (
        <Pressable
          testID="workspace-header-title-edit"
          onPress={beginEditing}
          accessibilityRole="button"
          accessibilityLabel={t("sidebar.workspace.actions.rename")}
          style={[styles.trigger, isHovered && styles.triggerHovered]}
        >
          <Text style={styles.text} numberOfLines={1} testID="workspace-header-title">
            {titleText}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  hoverRegion: {
    flexShrink: 1,
    minWidth: 0,
  },
  // The padding is constant across the two states: the hover chip appears without moving the
  // title, the project name before it, or the row it sits in.
  trigger: {
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.md,
    flexShrink: 1,
    minWidth: 0,
  },
  triggerHovered: {
    backgroundColor: theme.colors.surface3,
  },
  text: {
    flexShrink: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
  },
  editorShell: {
    flexShrink: 1,
    minWidth: 0,
    flexGrow: 1,
  },
  editorInput: {
    fontSize: theme.fontSize.base,
    fontWeight: {
      xs: "400",
      md: "300",
    },
    color: theme.colors.foreground,
    padding: 0,
    margin: 0,
    minWidth: 120,
    // The inline editor is its own focus ring; the platform one would draw a box around a
    // single line of header text.
    outlineWidth: 0,
    outlineColor: "transparent",
  },
}));
