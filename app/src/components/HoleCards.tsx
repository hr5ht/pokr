import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import { Animated, Easing, Pressable, StyleSheet } from 'react-native';

import { FadeTo, FlipCard } from '@/components/motion';

const TILT_DEG = [-9, 7];
const OVERLAP = 0.28; // share of a card's width that sits under its neighbour

type Props = {
  cards: string[];
  width: number;
  faceUp: boolean; // showdown: stays revealed without holding
  folded: boolean;
  dimmed: (card: string) => boolean;
};

/** Tilted, overlapping and face down. Press and hold to lift and flip them; release to hide. */
export function HoleCards({ cards, width, faceUp, folded, dimmed }: Props) {
  const [held, setHeld] = useState(false);
  const reveal = useRef(new Animated.Value(0)).current;
  const dealt = useRef(new Animated.Value(0)).current;
  const showing = held || faceUp;

  useEffect(() => {
    Animated.spring(dealt, { toValue: 1, speed: 12, bounciness: 8, useNativeDriver: true }).start();
  }, [dealt]);

  useEffect(() => {
    const run = Animated.timing(reveal, {
      toValue: showing ? 1 : 0,
      duration: 240,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    run.start();
    return () => run.stop();
  }, [reveal, showing]);

  const hold = () => {
    setHeld(true);
    Haptics.selectionAsync();
  };

  return (
    <FadeTo value={folded ? 0.4 : 1}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={showing ? `Your cards: ${cards.join(', ')}` : 'Your cards, face down'}
        accessibilityHint="Press and hold to peek"
        onAccessibilityTap={() => setHeld((h) => !h)}
        onPressIn={hold}
        onPressOut={() => setHeld(false)}
        style={styles.hand}>
        {cards.map((card, i) => {
          const side = i === 0 ? -1 : 1;
          return (
            <Animated.View
              key={card}
              style={[
                { width, height: width * 1.4 },
                i > 0 && { marginLeft: -width * OVERLAP },
                {
                  transform: [
                    { translateY: dealt.interpolate({ inputRange: [0, 1], outputRange: [width * 1.6, 0] }) },
                    { translateX: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, side * width * 0.09] }) },
                    { translateY: reveal.interpolate({ inputRange: [0, 1], outputRange: [0, -width * 0.1] }) },
                    {
                      rotate: reveal.interpolate({
                        inputRange: [0, 1],
                        outputRange: [`${TILT_DEG[i]}deg`, `${TILT_DEG[i] / 3}deg`],
                      }),
                    },
                    { scale: reveal.interpolate({ inputRange: [0, 1], outputRange: [1, 1.04] }) },
                  ],
                },
              ]}>
              <FlipCard card={card} width={width} progress={reveal} dim={faceUp && dimmed(card)} />
            </Animated.View>
          );
        })}
      </Pressable>
    </FadeTo>
  );
}

const styles = StyleSheet.create({
  hand: { flexDirection: 'row', justifyContent: 'center', paddingTop: 12 },
});
