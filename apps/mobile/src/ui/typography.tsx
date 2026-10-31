import { createContext, forwardRef, useContext } from 'react';
import type { ComponentRef } from 'react';
import { StyleSheet, Text as NativeText, TextInput as NativeTextInput } from 'react-native';
import type { TextProps, TextInputProps, TextStyle, StyleProp } from 'react-native';
import { colors } from './theme';

export const FontReadyContext = createContext(false);

function fontStyle(style: StyleProp<TextStyle>, ready: boolean): TextStyle {
  const value = StyleSheet.flatten(style) ?? {};
  if (!ready || value.fontFamily) return {};
  const weight = value.fontWeight === 'bold' ? 700 : Number(value.fontWeight) || 400;
  const face = weight >= 700 ? 'Bold' : weight >= 600 ? 'SemiBold' : weight >= 500 ? 'Medium' : 'Regular';
  // Static faces are registered separately: avoid platform-generated synthetic bold.
  return { fontFamily: `Pretendard-${face}`, fontWeight: 'normal' };
}

export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(function Text({ style, ...props }, ref) {
  const ready = useContext(FontReadyContext);
  return <NativeText ref={ref} {...props} style={[{ color: colors.text, fontSize: 15 }, style, fontStyle(style, ready)]} />;
});

export const TextInput = forwardRef<ComponentRef<typeof NativeTextInput>, TextInputProps>(function TextInput({ style, ...props }, ref) {
  const ready = useContext(FontReadyContext);
  return <NativeTextInput ref={ref} placeholderTextColor={colors.muted} selectionColor={colors.primary}
    {...props} style={[{ color: colors.text, fontSize: 16 }, style, fontStyle(style, ready)]} />;
});
