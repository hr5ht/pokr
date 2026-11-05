import { useEffect, useRef } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { PlayingCard } from '@/components/PlayingCard';
import { Button } from '@/components/ui';
import { colors, type } from '@/lib/theme';

const CARD_WIDTH = 34;
const STAGGER_MS = 70;

// Strongest first. `counts` is how many cards make the hand; the rest are dimmed.
const HANDS = [
  { name: 'Royal Flush', note: '10 to Ace, same suit', cards: ['As', 'Ks', 'Qs', 'Js', 'Ts'], counts: 5 },
  { name: 'Straight Flush', note: 'Five in a row, same suit', cards: ['9h', '8h', '7h', '6h', '5h'], counts: 5 },
  { name: 'Four of a Kind', note: 'Four of one rank', cards: ['Kd', 'Kh', 'Ks', 'Kc', '3d'], counts: 4 },
  { name: 'Full House', note: 'Three plus a pair', cards: ['Qd', 'Qh', 'Qs', '7c', '7d'], counts: 5 },
  { name: 'Flush', note: 'Five of the same suit', cards: ['Ad', 'Jd', '8d', '5d', '2d'], counts: 5 },
  { name: 'Straight', note: 'Five in a row', cards: ['Tc', '9d', '8h', '7s', '6c'], counts: 5 },
  { name: 'Three of a Kind', note: 'Three of one rank', cards: ['8c', '8d', '8h', 'Ks', '4d'], counts: 3 },
  { name: 'Two Pair', note: 'Two different pairs', cards: ['Jc', 'Jh', '4d', '4s', 'Ah'], counts: 4 },
  { name: 'Pair', note: 'Two of one rank', cards: ['As', 'Ad', 'Qc', '8h', '3s'], counts: 2 },
  { name: 'High Card', note: 'Nothing else: highest card', cards: ['Ah', 'Jd', '8c', '5s', '2h'], counts: 1 },
];

function HandRow({ hand, order, current }: { hand: (typeof HANDS)[number]; order: number; current: boolean }) {
  const shown = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(shown, {
      toValue: 1,
      duration: 320,
      delay: order * STAGGER_MS,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
  }, [shown, order]);

  return (
    <Animated.View
      accessible
      accessibilityLabel={`${hand.name}: ${hand.note}${current ? ', your current hand' : ''}`}
      style={[
        styles.row,
        current && styles.rowCurrent,
        {
          opacity: shown,
          transform: [{ translateY: shown.interpolate({ inputRange: [0, 1], outputRange: [28, 0] }) }],
        },
      ]}>
      <View style={{ flex: 1 }}>
        <Text numberOfLines={1} style={styles.name}>{hand.name}</Text>
        <Text numberOfLines={2} style={styles.note}>{current ? 'You have this now' : hand.note}</Text>
      </View>
      <View style={styles.cards}>
        {hand.cards.map((card, i) => (
          <PlayingCard key={card} card={card} width={CARD_WIDTH} dim={i >= hand.counts} />
        ))}
      </View>
    </Animated.View>
  );
}

/** Rows rise in from the bottom: High Card first, Royal Flush last. */
export function HandRanks({ current, onBack }: { current?: string | null; onBack: () => void }) {
  return (
    <>
      <Text style={styles.title}>Hand rankings</Text>
      <Text style={styles.subtitle}>Best at the top, weakest at the bottom</Text>
      {HANDS.map((hand, index) => (
        <HandRow key={hand.name} hand={hand} order={HANDS.length - 1 - index} current={hand.name === current} />
      ))}
      <Button label="Back" kind="plain" onPress={onBack} style={{ marginTop: 6 }} />
    </>
  );
}

const styles = StyleSheet.create({
  title: { ...type.heavy, color: colors.cream, fontSize: 26 },
  subtitle: { ...type.medium, color: colors.muted, fontSize: 15, marginBottom: 6 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 7,
    paddingHorizontal: 12,
    borderRadius: 16,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: 'transparent',
  },
  rowCurrent: { borderColor: colors.accent },
  name: { ...type.heavy, color: colors.cream, fontSize: 15 },
  note: { ...type.medium, color: colors.muted, fontSize: 12.5 },
  cards: { flexDirection: 'row', gap: 2 },
});
