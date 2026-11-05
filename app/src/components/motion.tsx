import { LinearGradient } from 'expo-linear-gradient';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Animated, Easing, StyleSheet, ViewStyle } from 'react-native';

import { PlayingCard } from '@/components/PlayingCard';
import { colors } from '@/lib/theme';

const SWAP = [0, 0.5, 0.501, 1]; // the card is edge-on at 0.5, which hides the face swap

export function Backdrop() {
  return <LinearGradient colors={[...colors.gradient]} locations={[0, 0.42, 1]} style={StyleSheet.absoluteFill} />;
}

/** Turns from its back (progress 0) to its face (progress 1). */
export function FlipCard({
  card,
  width,
  progress,
  dim,
}: {
  card: string;
  width: number;
  progress: Animated.Value;
  dim?: boolean;
}) {
  const face = (outputRange: string[], opacity: number[]) => ({
    opacity: progress.interpolate({ inputRange: SWAP, outputRange: opacity }),
    transform: [{ perspective: 800 }, { rotateY: progress.interpolate({ inputRange: SWAP, outputRange }) }],
  });

  return (
    <>
      <Animated.View style={[StyleSheet.absoluteFill, face(['0deg', '90deg', '90deg', '90deg'], [1, 1, 0, 0])]}>
        <PlayingCard width={width} />
      </Animated.View>
      <Animated.View style={[StyleSheet.absoluteFill, face(['-90deg', '-90deg', '-90deg', '0deg'], [0, 0, 1, 1])]}>
        <PlayingCard card={card} width={width} dim={dim} />
      </Animated.View>
    </>
  );
}

/** A community card: drops in, then flips over. `index` staggers the three flop cards. */
export function BoardCard({ card, width, dim, index }: { card: string; width: number; dim: boolean; index: number }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(progress, {
      toValue: 1,
      duration: 380,
      delay: index < 3 ? index * 130 : 0,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [progress, index]);

  return (
    <Animated.View
      style={{
        width,
        height: width * 1.4,
        transform: [{ translateY: progress.interpolate({ inputRange: [0, 1], outputRange: [-18, 0] }) }],
      }}>
      <FlipCard card={card} width={width} progress={progress} dim={dim} />
    </Animated.View>
  );
}

/** Springs in when mounted. Give it a `key` that changes to replay it. */
export function Pop({ children, from = 0.8 }: { children: ReactNode; from?: number }) {
  const scale = useRef(new Animated.Value(from)).current;

  useEffect(() => {
    Animated.spring(scale, { toValue: 1, speed: 14, bounciness: 5, useNativeDriver: true }).start();
  }, [scale]);

  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}

/** Fades a whole screen in when it mounts. */
export function Fade({ children }: { children: ReactNode }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 280, useNativeDriver: true }).start();
  }, [opacity]);

  return <Animated.View style={{ flex: 1, opacity }}>{children}</Animated.View>;
}

/** Eases to a new opacity instead of jumping, e.g. when a player folds. */
export function FadeTo({ value, children }: { value: number; children: ReactNode }) {
  const opacity = useRef(new Animated.Value(value)).current;

  useEffect(() => {
    Animated.timing(opacity, { toValue: value, duration: 280, useNativeDriver: true }).start();
  }, [opacity, value]);

  return <Animated.View style={{ opacity }}>{children}</Animated.View>;
}

/** Slides up when shown and back down when hidden, staying mounted until it's gone. */
export function SlideUp({ visible, style, children }: { visible: boolean; style?: ViewStyle; children: ReactNode }) {
  const [mounted, setMounted] = useState(visible);
  const shown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (visible) setMounted(true);
    const run = Animated.timing(shown, {
      toValue: visible ? 1 : 0,
      duration: visible ? 320 : 220,
      easing: visible ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });
    run.start(({ finished }) => finished && !visible && setMounted(false));
    return () => run.stop();
  }, [shown, visible]);

  if (!mounted) return null;
  return (
    <Animated.View
      style={[
        style,
        {
          opacity: shown,
          transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [60, 0] }) }],
        },
      ]}>
      {children}
    </Animated.View>
  );
}

/** Breathes gently while `active`, for the player whose turn it is. */
export function Pulse({ active, children }: { active: boolean; children: ReactNode }) {
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (!active) return;
    const step = (toValue: number) =>
      Animated.timing(scale, { toValue, duration: 520, easing: Easing.inOut(Easing.sin), useNativeDriver: true });
    const loop = Animated.loop(Animated.sequence([step(1.08), step(1)]));
    loop.start();
    return () => {
      loop.stop();
      scale.setValue(1);
    };
  }, [active, scale]);

  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}
