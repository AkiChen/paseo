import React from "react";
import { Text, View, type TextStyle, type ViewStyle } from "react-native";

export interface MarkdownMathProps {
  tex: string;
}

const WRAPPER_STYLE: ViewStyle = { paddingVertical: 6 };
const SOURCE_STYLE: TextStyle = {
  fontFamily: "monospace",
  fontSize: 13,
  lineHeight: 20,
  textAlign: "center",
};

/**
 * Native fallback for display math.
 *
 * KaTeX renders into the DOM, which a React Native view cannot host without a
 * WebView. Until the native side gets one, show the formula source in the same
 * monospace treatment as a code block so it is still readable and copyable.
 */
export function MarkdownMath({ tex }: MarkdownMathProps) {
  return (
    <View style={WRAPPER_STYLE}>
      <Text style={SOURCE_STYLE}>{tex}</Text>
    </View>
  );
}
