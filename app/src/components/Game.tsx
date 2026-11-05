import Slider from '@react-native-community/slider';
import * as Haptics from 'expo-haptics';
import { useEffect, useRef, useState } from 'react';
import {
  Animated,
  Easing,
  Pressable,
  ScrollView,
  ScrollViewInstance,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/BottomSheet';
import { HandRanks } from '@/components/HandRanks';
import { HoleCards } from '@/components/HoleCards';
import { TableProps } from '@/components/Lobby';
import { Backdrop, BoardCard, FadeTo, Pop, Pulse, SlideUp } from '@/components/motion';
import { PlayingCard } from '@/components/PlayingCard';
import { Players } from '@/components/Players';
import { Button, Pill, Row } from '@/components/ui';
import { HandView, Seat, TableView } from '@/lib/api';
import { colors, type } from '@/lib/theme';

const RAIL_ITEM = 92;
const BAR_HEIGHT = 66;
const FOLD_PAUSE_MS = 3000; // matches the server's pause between hands
const SHOWDOWN_PAUSE_MS = 7000;

export function Game({ view, send, connected, error, onShare, onLeave }: TableProps) {
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const [menu, setMenu] = useState(false);
  const rail = useRef<ScrollViewInstance>(null);

  const hand = view.hand;
  const result = hand?.result ?? null;
  const live = !!hand && !result;
  const me = view.seats.find((s) => s.id === view.you);
  const myIndex = view.seats.findIndex((s) => s.id === view.you);
  // Rotate so the rail reads in betting order, starting from the player on my left.
  const others = [...view.seats.slice(myIndex + 1), ...view.seats.slice(0, Math.max(myIndex, 0))];
  const myTurn = hand?.toAct === view.you;

  useEffect(() => {
    if (myTurn) Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  }, [myTurn, hand?.seq]);

  useEffect(() => {
    const index = others.findIndex((s) => s.id === hand?.toAct);
    if (index >= 0) {
      rail.current?.scrollTo({ x: Math.max(index * RAIL_ITEM - (width - RAIL_ITEM) / 2, 0), animated: true });
    }
  }, [hand?.toAct, others.length, width]);

  if (!me) return null;

  const best = result?.winners.find((w) => w.cards.length)?.cards;
  const dimmed = (card: string) => !!best && !best.includes(card);
  const boardCard = Math.min((width - 56) / 5, 68);
  const holeCard = Math.min(width * 0.42, height * 0.2);
  const myWin = result?.winners.find((w) => w.id === view.you);
  const canPeek = live && me.inHand && !me.folded;

  const board = (
    <View style={[styles.board, { height: boardCard * 1.4 }]}>
      {hand?.board.map((card, index) => (
        <BoardCard key={card} card={card} index={index} width={boardCard} dim={dimmed(card)} />
      ))}
    </View>
  );

  return (
    <View style={[styles.screen, { paddingTop: insets.top + 4 }]}>
      <Backdrop />
      <Row style={styles.top}>
        <Text style={styles.topText}>{view.code}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Table menu" onPress={() => setMenu(true)} style={styles.menuButton}>
          <Text style={styles.menuText}>Menu</Text>
        </Pressable>
      </Row>

      <ScrollView
        ref={rail}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={styles.rail}
        contentContainerStyle={styles.railContent}>
        {others.map((seat) => (
          <Opponent key={seat.id} seat={seat} view={view} dimmed={dimmed} />
        ))}
      </ScrollView>

      <View style={styles.middle}>
        {!connected && <Pop><Text style={styles.warn}>Reconnecting…</Text></Pop>}
        {view.paused && <Pop><Text style={styles.warn}>Paused by the host</Text></Pop>}
        {!!error && <Pop key={error}><Text style={styles.warn}>{error}</Text></Pop>}

        {result ? (
          <>
            <Pop key={describeResult(result, view.seats)}>
              {myWin ? (
                <Text style={styles.win}>{myWin.net > 0 ? `+${myWin.net}` : 'Split'}</Text>
              ) : (
                <Text style={styles.pot} numberOfLines={2}>{describeResult(result, view.seats)}</Text>
              )}
            </Pop>
            {!!myWin?.name && <Text style={styles.handName}>{myWin.name}</Text>}
            {board}
          </>
        ) : (
          <>
            <Pop key={hand?.pot ?? 0} from={0.9}>
              <Text style={styles.pot}>{hand ? `Pot ${hand.pot}` : 'Waiting for players…'}</Text>
            </Pop>
            {board}
            <Pop key={hand?.handName ?? ''}>
              <Text style={styles.handName}>{hand?.handName ?? ' '}</Text>
            </Pop>
          </>
        )}
      </View>

      {me.cards && (
        <HoleCards
          key={me.cards.join()}
          cards={me.cards}
          width={holeCard}
          faceUp={!!result?.shown.includes(me.id)}
          folded={me.folded}
          dimmed={dimmed}
        />
      )}

      <Text style={styles.me}>
        {me.name} · {me.stack}
        {me.bet ? ` · bet ${me.bet}` : ''}
        {canPeek && <Text style={styles.hint}> · hold to peek</Text>}
        {!me.cards && <Text style={styles.hint}> · in next hand</Text>}
      </Text>

      <Bottom view={view} me={me} live={live} pad={insets.bottom} send={send} />

      <Menu view={view} visible={menu} onClose={() => setMenu(false)} send={send} onShare={onShare} onLeave={onLeave} />
    </View>
  );
}

function Bottom({ view, me, live, pad, send }: { view: TableView; me: Seat; live: boolean; pad: number; send: (m: object) => void }) {
  const hand = view.hand;
  if (hand?.toAct === view.you && hand.legal && !view.paused) {
    return (
      <Actions key={hand.seq} hand={hand} me={me} bb={view.settings.bb} turnTotal={view.settings.timer * 1000} pad={pad} send={send} />
    );
  }
  if (me.sittingOut) {
    return (
      <View style={styles.bar}>
        <BarButton main pad={pad} label="I'm back" onPress={() => send({ t: 'sit' })} />
      </View>
    );
  }
  if (me.stack === 0 && !(live && me.inHand)) {
    return (
      <View style={styles.bar}>
        <BarButton main pad={pad} label={`Rebuy ${view.settings.stack}`} onPress={() => send({ t: 'rebuy' })} />
      </View>
    );
  }
  if (hand?.result) {
    const ms = hand.result.shown.length ? SHOWDOWN_PAUSE_MS : FOLD_PAUSE_MS;
    return (
      <View style={[styles.strip, { marginBottom: pad + 20 }]}>
        <Countdown ms={ms} total={ms} />
      </View>
    );
  }
  return (
    <View style={styles.bar}>
      <BarButton pad={pad} label="Fold" />
      <BarButton pad={pad} label="Call" />
      <BarButton pad={pad} label="Raise" />
    </View>
  );
}

function BarButton({
  label,
  onPress,
  main,
  pad,
  wide,
}: {
  label: string;
  onPress?: () => void;
  main?: boolean;
  pad: number;
  wide?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !onPress }}
      disabled={!onPress}
      onPress={onPress}
      style={({ pressed }) => [
        styles.barButton,
        { paddingBottom: pad, height: BAR_HEIGHT + pad, flex: wide ? 2 : 1 },
        main && styles.barMain,
        pressed && { opacity: 0.7 },
      ]}>
      <Text
        numberOfLines={1}
        adjustsFontSizeToFit
        style={[styles.barText, main && { color: colors.accentText }, !onPress && { opacity: 0.4 }]}>
        {label}
      </Text>
    </Pressable>
  );
}

function describeResult(result: NonNullable<HandView['result']>, seats: Seat[]) {
  return result.winners
    .map((w) => {
      const name = seats.find((s) => s.id === w.id)?.name ?? 'Someone';
      return `${name} wins ${w.won}${w.name ? ` with ${w.name}` : ''}`;
    })
    .join(' · ');
}

function Opponent({ seat, view, dimmed }: { seat: Seat; view: TableView; dimmed: (c: string) => boolean }) {
  const hand = view.hand;
  const acting = hand?.toAct === seat.id;
  const won = hand?.result?.winners.find((w) => w.id === seat.id);
  const out = seat.folded || !seat.inHand;
  const shownName = hand?.result?.names[seat.id];
  const status = seat.allin
    ? 'All in'
    : !seat.online
      ? 'Offline'
      : seat.sittingOut
        ? 'Away'
        : seat.last;
  const move = won ? (won.net > 0 ? `+${won.net}` : 'Split') : shownName ?? status;

  return (
    <View
      accessible
      accessibilityLabel={`${seat.name}, ${seat.stack} chips${move ? `, ${move}` : ''}${acting ? ', to act' : ''}`}
      style={styles.opponent}>
      <FadeTo value={out ? 0.5 : 1}>
      <Pulse active={acting}>
        <View style={[styles.face, acting && styles.faceActing, seat.cards && styles.faceShown]}>
          {seat.cards ? (
            <View style={styles.shown}>
              {seat.cards.map((card) => (
                <PlayingCard key={card} card={card} width={32} dim={dimmed(card)} />
              ))}
            </View>
          ) : (
            <Text style={styles.initial}>{seat.name[0].toUpperCase()}</Text>
          )}
        </View>
      </Pulse>
      </FadeTo>
      <Text numberOfLines={1} style={styles.seatName}>{seat.name}</Text>
      <Text numberOfLines={1} style={styles.seatStack}>{seat.stack}</Text>
      <View style={styles.moveSlot}>
        {acting && hand && !view.paused ? (
          <View style={styles.turnTrack}>
            <Countdown key={hand.seq} ms={hand.turnMs} total={view.settings.timer * 1000} />
          </View>
        ) : move ? (
          <Pop key={move}>
            <View style={[styles.move, won && styles.moveWon]}>
              <Text numberOfLines={1} style={[styles.moveText, won && { color: colors.accentText }]}>{move}</Text>
            </View>
          </Pop>
        ) : null}
      </View>
    </View>
  );
}

function Countdown({ ms, total }: { ms: number; total: number }) {
  const left = useRef(new Animated.Value(ms / total)).current;
  useEffect(() => {
    const run = Animated.timing(left, { toValue: 0, duration: ms, easing: Easing.linear, useNativeDriver: true });
    run.start();
    return () => run.stop();
  }, [left, ms]);
  return <Animated.View style={[styles.turnFill, { transform: [{ scaleX: left }] }]} />;
}

function Actions({
  hand,
  me,
  bb,
  turnTotal,
  pad,
  send,
}: {
  hand: HandView;
  me: Seat;
  bb: number;
  turnTotal: number;
  pad: number;
  send: (m: object) => void;
}) {
  const legal = hand.legal!;
  const [raising, setRaising] = useState(false);
  const min = legal.raiseMin ?? 0;
  const max = legal.raiseMax ?? 0;
  const [amount, setAmount] = useState(min);
  const [thumb, setThumb] = useState(min); // only follows taps, so dragging doesn't fight its own value
  const clamp = (n: number) => Math.max(min, Math.min(max, Math.round(n)));
  const choose = (n: number) => {
    const next = clamp(n);
    setAmount(next);
    setThumb(next);
  };
  // Drag in big-blind steps, but always let the far end reach all-in.
  const snap = (n: number) => (n >= max ? max : clamp(min + Math.round((n - min) / bb) * bb));
  const act =(action: string, value?: number) => send({ t: 'act', seq: hand.seq, action, amount: value });
  const potAfterCall = hand.pot + legal.call;
  const word = hand.current ? 'Raise' : 'Bet';

  return (
    <View>
      <SlideUp visible={raising} style={styles.raisePanel}>
          <Row style={{ justifyContent: 'center' }}>
            <Pill label="½ Pot" active={false} onPress={() => choose(hand.current + potAfterCall / 2)} />
            <Pill label="Pot" active={false} onPress={() => choose(hand.current + potAfterCall)} />
            <Pill label="All in" active={amount === max} onPress={() => choose(max)} />
          </Row>
          <Row style={{ justifyContent: 'space-between' }}>
            <Button label="−" kind="plain" style={styles.step} onPress={() => choose(amount - bb)} />
            <Text style={styles.amount}>{amount}</Text>
            <Button label="+" kind="plain" style={styles.step} onPress={() => choose(amount + bb)} />
          </Row>
          {max > min && (
            <Slider
              accessibilityLabel={`${word} amount`}
              style={styles.slider}
              minimumValue={min}
              maximumValue={max}
              value={thumb}
              onValueChange={(n) => setAmount(snap(n))}
              onSlidingComplete={(n) => choose(snap(n))}
              minimumTrackTintColor={colors.accent}
              maximumTrackTintColor={colors.line}
              thumbTintColor={colors.accent}
            />
          )}
      </SlideUp>
      <View style={styles.myTimer} accessibilityLabel="Time left for your turn">
        <Countdown ms={hand.turnMs} total={turnTotal} />
      </View>
      <View style={styles.bar}>
        {raising ? (
          <>
            <BarButton pad={pad} label="Back" onPress={() => setRaising(false)} />
            <BarButton
              main
              wide
              pad={pad}
              label={amount === max ? `All in ${amount}` : `${word} to ${amount}`}
              onPress={() => act('raise', amount)}
            />
          </>
        ) : (
          <>
            <BarButton pad={pad} label="Fold" onPress={() => act('fold')} />
            {legal.call ? (
              <BarButton
                pad={pad}
                label={legal.call === me.stack ? `All in ${legal.call}` : `Call ${legal.call}`}
                onPress={() => act('call')}
              />
            ) : (
              <BarButton pad={pad} label="Check" onPress={() => act('check')} />
            )}
            <BarButton
              main={legal.raiseMin !== null}
              pad={pad}
              label={word}
              onPress={legal.raiseMin !== null ? () => setRaising(true) : undefined}
            />
          </>
        )}
      </View>
    </View>
  );
}

type MenuProps = {
  view: TableView;
  visible: boolean;
  onClose: () => void;
  send: (m: object) => void;
  onShare: () => void;
  onLeave: () => void;
};

function Menu({ view, visible, onClose, send, onShare, onLeave }: MenuProps) {
  const insets = useSafeAreaInsets();
  const me = view.seats.find((s) => s.id === view.you);
  const isHost = view.you === view.host;
  const [page, setPage] = useState<'menu' | 'hands'>('menu');
  const close = () => {
    setPage('menu');
    onClose();
  };
  const host = (op: string) => {
    send({ t: 'host', op });
    onClose();
  };

  return (
    <BottomSheet
      visible={visible}
      onClose={close}
      onBack={page === 'hands' ? () => setPage('menu') : close}
      page={page}
      tallPage="hands">
      {(shown) => (
      <ScrollView
        key={shown}
        style={styles.sheetScroll}
        contentContainerStyle={{ gap: 8, paddingHorizontal: 20, paddingTop: 4, paddingBottom: insets.bottom + 20 }}>
        {shown === 'hands' ? (
          <HandRanks current={view.hand?.result ? null : view.hand?.handName} onBack={() => setPage('menu')} />
        ) : (
          <>
            <Button label={`Share code ${view.code}`} onPress={onShare} />
            <Button label="Hand rankings" kind="plain" onPress={() => setPage('hands')} />
            <Button
              label={me?.sittingOut ? "I'm back" : 'Sit out'}
              kind="plain"
              onPress={() => {
                send({ t: me?.sittingOut ? 'sit' : 'sitOut' });
                onClose();
              }}
            />
            {isHost && (
              <>
                <Button
                  label={view.paused ? 'Resume game' : 'Pause game'}
                  kind="plain"
                  onPress={() => host(view.paused ? 'resume' : 'pause')}
                />
                <Button label="End game" kind="plain" onPress={() => host('end')} />
                <Button label="Change code" kind="plain" onPress={() => host('rotate')} />
              </>
            )}
            <Text style={styles.menuHeading}>Players</Text>
            <Players view={view} send={send} />
            <Button label="Leave table" kind="danger" onPress={onLeave} />
            <Button label="Close" kind="plain" onPress={close} />
          </>
        )}
      </ScrollView>
      )}
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  top: { justifyContent: 'space-between', paddingHorizontal: 24 },
  topText: { ...type.bold, color: colors.cream, fontSize: 15 },
  menuButton: { minHeight: 44, minWidth: 44, justifyContent: 'center', alignItems: 'flex-end' },
  menuText: { ...type.bold, color: colors.accent, fontSize: 16 },
  rail: { flexGrow: 0 },
  railContent: { paddingHorizontal: 12, paddingVertical: 10, flexGrow: 1, justifyContent: 'center' },
  opponent: { width: RAIL_ITEM, alignItems: 'center', paddingHorizontal: 3 },
  face: {
    width: 66,
    height: 66,
    borderRadius: 33,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
    borderWidth: 3,
    borderColor: 'transparent',
  },
  faceActing: { borderColor: colors.accent },
  faceShown: { backgroundColor: 'transparent' },
  initial: { ...type.heavy, color: colors.cream, fontSize: 26 },
  shown: { flexDirection: 'row', gap: 2 },
  seatName: { ...type.bold, color: colors.cream, fontSize: 14, marginTop: 4 },
  seatStack: { ...type.medium, color: colors.muted, fontSize: 13 },
  moveSlot: { height: 28, justifyContent: 'center', alignItems: 'center', alignSelf: 'stretch' },
  move: { paddingHorizontal: 9, paddingVertical: 3, borderRadius: 11, backgroundColor: colors.tag },
  moveWon: { backgroundColor: colors.accent },
  moveText: { ...type.bold, color: colors.cream, fontSize: 12.5 },
  turnTrack: { width: 66, height: 4, borderRadius: 2, backgroundColor: colors.line, overflow: 'hidden' },
  turnFill: { height: '100%', width: '100%', backgroundColor: colors.accent, transformOrigin: 'left' },
  middle: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 10, paddingHorizontal: 16 },
  warn: { ...type.bold, color: colors.danger, fontSize: 14 },
  pot: { ...type.heavy, color: colors.cream, fontSize: 24, textAlign: 'center' },
  win: { ...type.heavy, color: colors.accent, fontSize: 68, letterSpacing: -2 },
  board: { flexDirection: 'row', gap: 7, alignSelf: 'stretch', justifyContent: 'center' },
  handName: { ...type.heavy, color: colors.accent, fontSize: 17, textAlign: 'center' },
  me: { ...type.heavy, color: colors.cream, fontSize: 18, textAlign: 'center', paddingVertical: 10 },
  hint: { ...type.medium, color: colors.muted, fontSize: 14 },
  myTimer: { height: 5, backgroundColor: colors.line },
  bar: { flexDirection: 'row', backgroundColor: colors.bar },
  barButton: { alignItems: 'center', justifyContent: 'center', paddingHorizontal: 8 },
  barMain: { backgroundColor: colors.accent },
  barText: { ...type.heavy, color: colors.cream, fontSize: 19 },
  strip: {
    height: 6,
    borderRadius: 3,
    marginHorizontal: 24,
    backgroundColor: colors.line,
    overflow: 'hidden',
  },
  raisePanel: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: '100%',
    gap: 12,
    padding: 16,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: colors.sheet,
  },
  step: { width: 58, paddingHorizontal: 0 },
  slider: { width: '100%', height: 44 },
  amount: { ...type.heavy, color: colors.cream, fontSize: 36 },
  sheetScroll: { flexGrow: 0, flexShrink: 1 },
  menuHeading: { ...type.heavy, color: colors.cream, fontSize: 18, marginTop: 8 },
});
