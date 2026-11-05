import { LinearGradient } from 'expo-linear-gradient';
import { StyleSheet, Text, View } from 'react-native';

import { colors, type } from '@/lib/theme';

// U+FE0E stops iOS drawing the suits as coloured emoji.
const SUITS: Record<string, { glyph: string; name: string; red: boolean }> = {
  s: { glyph: '♠︎', name: 'spades', red: false },
  h: { glyph: '♥︎', name: 'hearts', red: true },
  d: { glyph: '♦︎', name: 'diamonds', red: true },
  c: { glyph: '♣︎', name: 'clubs', red: false },
};
const RANK_NAMES: Record<string, string> = { T: 'Ten', J: 'Jack', Q: 'Queen', K: 'King', A: 'Ace' };
const RING_RADII = [0.3, 0.55, 0.8, 1.05, 1.3, 1.55]; // in card widths

/** Tone-on-tone rings spreading from two opposite corners, blended into the red. */
function CardBack({ width }: { width: number }) {
  const height = width * 1.4;
  const rings = (x: number, y: number, tint: string) =>
    RING_RADII.map((r) => {
      const radius = r * width;
      return (
        <View
          key={`${tint}${r}`}
          style={{
            position: 'absolute',
            left: x - radius,
            top: y - radius,
            width: radius * 2,
            height: radius * 2,
            borderRadius: radius,
            borderWidth: width * 0.09,
            borderColor: tint,
          }}
        />
      );
    });

  return (
    <View style={[StyleSheet.absoluteFill, { borderRadius: width * 0.15, overflow: 'hidden' }]}>
      <LinearGradient
        colors={[colors.cardBack, colors.cardBackDeep]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={StyleSheet.absoluteFill}
      />
      {rings(0, height, 'rgba(255,255,255,0.05)')}
      {rings(width, 0, 'rgba(0,0,0,0.09)')}
      <View style={[styles.backLine, { margin: width * 0.07, borderRadius: width * 0.09 }]} />
    </View>
  );
}

type Props = { card?: string | null; width: number; dim?: boolean };

/** No `card` draws the back. Court cards are typographic: a big letter, no illustration. */
export function PlayingCard({ card, width, dim }: Props) {
  const box = { width, height: width * 1.4, borderRadius: width * 0.15 };
  if (!card) {
    return (
      <View style={[styles.card, styles.back, box]} accessibilityLabel="Face-down card">
        <CardBack width={width} />
      </View>
    );
  }

  const rank = card[0] === 'T' ? '10' : card[0];
  const suit = SUITS[card[1]];
  const color = suit.red ? colors.red : colors.ink;
  const court = 'JQK'.includes(rank);
  const label = `${RANK_NAMES[card[0]] ?? card[0]} of ${suit.name}`;

  if (width < 40) {
    return (
      <View style={[styles.card, box, dim && styles.dim]} accessibilityLabel={label}>
        <Text style={[styles.rank, { color, fontSize: width * 0.44, top: width * 0.1, left: width * 0.12 }]}>{rank}</Text>
        <Text style={{ position: 'absolute', color, fontSize: width * 0.46, right: width * 0.12, bottom: width * 0.1 }}>
          {suit.glyph}
        </Text>
      </View>
    );
  }

  return (
    <View style={[styles.card, box, dim && styles.dim]} accessibilityLabel={label}>
      <Text style={[styles.rank, { color, fontSize: width * 0.32, lineHeight: width * 0.36, top: width * 0.07, left: width * 0.1 }]}>
        {rank}
      </Text>
      <Text
        style={{
          position: 'absolute',
          color,
          fontSize: width * 0.2,
          lineHeight: width * 0.24,
          top: width * 0.41,
          left: width * 0.11,
        }}>
        {suit.glyph}
      </Text>
      <Text
        style={[
          { position: 'absolute', color, right: width * 0.1, bottom: width * 0.02 },
          court ? [type.heavy, { fontSize: width * 0.72, lineHeight: width * 0.86 }] : { fontSize: width * 0.62, lineHeight: width * 0.78 },
        ]}>
        {court ? rank : suit.glyph}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { backgroundColor: colors.cardFace, boxShadow: '0 10px 18px rgba(0,25,16,0.45)' },
  back: { backgroundColor: colors.cardBack },
  backLine: { flex: 1, borderWidth: 1.5, borderColor: colors.cardBackLine },
  dim: { opacity: 0.4 },
  rank: { ...type.heavy, position: 'absolute' },
});
