import { ReactNode, useRef } from 'react';
import { Animated, Pressable, StyleSheet, Text, View, ViewStyle } from 'react-native';

import { colors, type } from '@/lib/theme';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

type ButtonProps = {
  label: string;
  onPress: () => void;
  kind?: 'primary' | 'plain' | 'danger' | 'destructive';
  disabled?: boolean;
  style?: ViewStyle;
};

export function Button({ label, onPress, kind = 'primary', disabled, style }: ButtonProps) {
  const scale = useRef(new Animated.Value(1)).current;
  const press = (toValue: number) =>
    Animated.spring(scale, { toValue, speed: 40, bounciness: 0, useNativeDriver: true }).start();

  return (
    <AnimatedPressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      onPressIn={() => press(0.97)}
      onPressOut={() => press(1)}
      style={[
        styles.button,
        kind === 'primary' ? styles.primary : kind === 'destructive' ? styles.destructive : styles.plain,
        disabled && styles.dim,
        style,
        { transform: [{ scale }] },
      ]}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[
          styles.label,
          kind === 'primary' && { color: colors.accentText },
          kind === 'danger' && { color: colors.danger },
        ]}>
        {label}
      </Text>
    </AnimatedPressable>
  );
}

export function Pill({ label, active, onPress }: { label: string; active: boolean; onPress?: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: active }}
      disabled={!onPress}
      onPress={onPress}
      style={[styles.pill, active && styles.pillActive]}>
      <Text style={[styles.pillText, active && { color: colors.accentText }]}>{label}</Text>
    </Pressable>
  );
}

export function Row({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  return <View style={[{ flexDirection: 'row', alignItems: 'center', gap: 8 }, style]}>{children}</View>;
}

const styles = StyleSheet.create({
  button: {
    minHeight: 58,
    paddingHorizontal: 20,
    borderRadius: 29,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: { backgroundColor: colors.accent, boxShadow: '0 10px 20px rgba(0,25,16,0.4)' },
  plain: { backgroundColor: colors.surface },
  destructive: { backgroundColor: colors.red },
  dim: { opacity: 0.5 },
  label: { ...type.heavy, color: colors.cream, fontSize: 18 },
  pill: {
    minHeight: 42,
    minWidth: 50,
    paddingHorizontal: 16,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  pillActive: { backgroundColor: colors.accent },
  pillText: { ...type.bold, color: colors.cream, fontSize: 15 },
});
