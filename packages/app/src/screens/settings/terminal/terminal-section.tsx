import { useCallback, useEffect, useMemo, useState } from "react";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { FormTextInput } from "@/components/ui/form-field";
import {
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
  parseClampedFontSize,
  parseTerminalScrollbackLines,
  sanitizeFontFamily,
  useAppSettings,
} from "@/hooks/use-settings";
import { TERMINAL_CURSOR_STYLES, type TerminalCursorStyle } from "@/terminal/cursor-style";
import { TERMINAL_THEME_OPTIONS, type TerminalThemeId } from "@/terminal/themes";

const TERMINAL_FONT_SIZE_BOUNDS = { min: MIN_TERMINAL_FONT_SIZE, max: MAX_TERMINAL_FONT_SIZE };

export function TerminalSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const [scrollbackValue, setScrollbackValue] = useState(String(settings.terminalScrollbackLines));
  const [fontFamilyValue, setFontFamilyValue] = useState(settings.terminalFontFamily);
  const [fontSizeValue, setFontSizeValue] = useState(String(settings.terminalFontSize));

  const themeOptions = useMemo(
    () => TERMINAL_THEME_OPTIONS.map((option) => ({ value: option.id, label: option.label })),
    [],
  );
  const cursorOptions = useMemo(
    () =>
      TERMINAL_CURSOR_STYLES.map((style) => ({
        value: style,
        label: t(`settings.general.terminalCursor.options.${style}`),
      })),
    [t],
  );

  const handleChangeTheme = useCallback(
    (terminalTheme: TerminalThemeId) => void updateSettings({ terminalTheme }),
    [updateSettings],
  );
  const handleChangeCursor = useCallback(
    (terminalCursorStyle: TerminalCursorStyle) => void updateSettings({ terminalCursorStyle }),
    [updateSettings],
  );
  const handleChangeCloseConfirmation = useCallback(
    (isTerminalCloseConfirmationEnabled: boolean) =>
      void updateSettings({ isTerminalCloseConfirmationEnabled }),
    [updateSettings],
  );

  const handleChangeText = useCallback((value: string) => {
    setScrollbackValue(value.replace(/[^\d]/g, ""));
  }, []);

  const commitScrollback = useCallback(() => {
    const nextValue =
      parseTerminalScrollbackLines(scrollbackValue) ?? settings.terminalScrollbackLines;
    setScrollbackValue(String(nextValue));
    if (nextValue !== settings.terminalScrollbackLines) {
      void updateSettings({ terminalScrollbackLines: nextValue });
    }
  }, [scrollbackValue, settings.terminalScrollbackLines, updateSettings]);

  const commitFontFamily = useCallback(() => {
    // An empty name means "use the platform default", which is how the setting is stored.
    const nextValue = sanitizeFontFamily(fontFamilyValue) ?? "";
    setFontFamilyValue(nextValue);
    if (nextValue !== settings.terminalFontFamily) {
      void updateSettings({ terminalFontFamily: nextValue });
    }
  }, [fontFamilyValue, settings.terminalFontFamily, updateSettings]);

  const commitFontSize = useCallback(() => {
    const nextValue =
      parseClampedFontSize(fontSizeValue, TERMINAL_FONT_SIZE_BOUNDS) ?? settings.terminalFontSize;
    setFontSizeValue(String(nextValue));
    if (nextValue !== settings.terminalFontSize) {
      void updateSettings({ terminalFontSize: nextValue });
    }
  }, [fontSizeValue, settings.terminalFontSize, updateSettings]);

  useEffect(() => {
    setScrollbackValue(String(settings.terminalScrollbackLines));
  }, [settings.terminalScrollbackLines]);

  useEffect(() => {
    setFontFamilyValue(settings.terminalFontFamily);
  }, [settings.terminalFontFamily]);

  useEffect(() => {
    setFontSizeValue(String(settings.terminalFontSize));
  }, [settings.terminalFontSize]);

  return (
    <SettingsSection title={t("settings.sections.terminal")}>
      <SettingsCard>
        <SettingsSelect
          label={t("settings.general.terminalTheme.label")}
          hint={t("settings.general.terminalTheme.description")}
          value={settings.terminalTheme}
          options={themeOptions}
          onValueChange={handleChangeTheme}
        />
        <SettingsSelect
          label={t("settings.general.terminalCursor.label")}
          hint={t("settings.general.terminalCursor.description")}
          value={settings.terminalCursorStyle}
          options={cursorOptions}
          onValueChange={handleChangeCursor}
        />
        <SettingsRow
          label={t("settings.general.terminalFontFamily.label")}
          hint={t("settings.general.terminalFontFamily.description")}
        >
          <FormTextInput
            size="sm"
            initialValue={fontFamilyValue}
            onChangeText={setFontFamilyValue}
            onBlur={commitFontFamily}
            onSubmitEditing={commitFontFamily}
            placeholder={t("settings.general.terminalFontFamily.placeholder")}
            accessibilityLabel={t("settings.general.terminalFontFamily.accessibilityLabel")}
            style={styles.textInput}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.general.terminalFontSize.label")}
          hint={t("settings.general.terminalFontSize.description")}
        >
          <FormTextInput
            size="sm"
            initialValue={fontSizeValue}
            onChangeText={setFontSizeValue}
            onBlur={commitFontSize}
            onSubmitEditing={commitFontSize}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            accessibilityLabel={t("settings.general.terminalFontSize.accessibilityLabel")}
            style={styles.numericInput}
          />
        </SettingsRow>
        <SettingsRow
          label={t("settings.general.terminalScrollback.label")}
          hint={t("settings.general.terminalScrollback.description")}
        >
          <FormTextInput
            size="sm"
            initialValue={scrollbackValue}
            onChangeText={handleChangeText}
            onBlur={commitScrollback}
            onSubmitEditing={commitScrollback}
            keyboardType="number-pad"
            inputMode="numeric"
            selectTextOnFocus
            accessibilityLabel={t("settings.general.terminalScrollback.accessibilityLabel")}
            style={styles.numericInput}
          />
        </SettingsRow>
        <SettingsSwitch
          label={t("settings.general.terminalCloseConfirmation.label")}
          hint={t("settings.general.terminalCloseConfirmation.description")}
          value={settings.isTerminalCloseConfirmationEnabled}
          onValueChange={handleChangeCloseConfirmation}
        />
      </SettingsCard>
    </SettingsSection>
  );
}

const styles = StyleSheet.create({
  textInput: {
    minWidth: 180,
  },
  numericInput: {
    width: 112,
    textAlign: "right",
  },
});
