import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Backdrop, Pop } from '@/components/motion';
import { Players } from '@/components/Players';
import { Button, Pill, Row } from '@/components/ui';
import { TableView } from '@/lib/api';
import { colors, type } from '@/lib/theme';

export type TableProps = {
  view: TableView;
  send: (msg: object) => void;
  connected: boolean;
  error: string;
  onShare: () => void;
  onLeave: () => void;
  onExit: () => void;
};

const OPTIONS = [
  { key: 'bb', title: 'Big blind', values: [2, 10, 20, 50, 100] },
  { key: 'stack', title: 'Starting chips', values: [500, 1000, 2000, 5000] },
  { key: 'timer', title: 'Seconds per turn', values: [15, 30, 60] },
] as const;

export function Lobby({ view, send, connected, error, onShare, onLeave, onExit }: TableProps) {
  const insets = useSafeAreaInsets();
  const isHost = view.you === view.host;
  const ready = view.seats.filter((s) => s.online).length;

  return (
    <View style={styles.screen}>
      <Backdrop />
      <ScrollView contentContainerStyle={[styles.content, { paddingTop: insets.top + 8, paddingBottom: insets.bottom + 24 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel="Close" onPress={onExit} style={styles.close}>
          <Text style={styles.closeText}>✕</Text>
        </Pressable>

        <Text
          accessibilityLabel={`Team code ${view.code.split('').join(' ')}`}
          selectable
          numberOfLines={1}
          adjustsFontSizeToFit
          style={styles.code}>
          {view.code.slice(0, 2)}
          <Text style={{ color: colors.accent }}>{view.code.slice(2)}</Text>
        </Text>
        <Text style={styles.note}>Share this code with your friends</Text>
        <Button label="Share code" onPress={onShare} style={{ marginTop: 12 }} />
        {isHost && <Button label="Change code" kind="plain" onPress={() => send({ t: 'host', op: 'rotate' })} />}

        {!connected && <Pop><Text style={styles.error}>Reconnecting…</Text></Pop>}
        {!!error && <Pop key={error}><Text style={styles.error}>{error}</Text></Pop>}

        <Text style={styles.heading}>Players {view.seats.length}/12</Text>
        <Players view={view} send={send} />

        <Text style={styles.heading}>Table</Text>
        {OPTIONS.map(({ key, title, values }) => (
          <View key={key} style={styles.option}>
            <Text style={styles.label}>{title}</Text>
            {isHost ? (
              <Row style={{ flexWrap: 'wrap' }}>
                {values.map((value) => (
                  <Pill
                    key={value}
                    label={String(value)}
                    active={view.settings[key] === value}
                    onPress={() => send({ t: 'host', op: 'settings', settings: { [key]: value } })}
                  />
                ))}
              </Row>
            ) : (
              <Text style={styles.value}>{view.settings[key]}</Text>
            )}
          </View>
        ))}

        <View style={{ height: 8 }} />
        {isHost ? (
          <Button
            label={ready < 2 ? 'Waiting for one more player' : 'Start game'}
            disabled={ready < 2}
            onPress={() => send({ t: 'host', op: 'start' })}
          />
        ) : (
          <Text style={styles.waiting}>Waiting for the host to start</Text>
        )}
        <Button label="Leave table" kind="danger" onPress={onLeave} />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 24, gap: 12 },
  close: { width: 44, height: 44, justifyContent: 'center' },
  closeText: { ...type.bold, color: colors.cream, fontSize: 22 },
  code: { ...type.heavy, color: colors.cream, fontSize: 112, letterSpacing: 2, textAlign: 'center', marginTop: 16 },
  note: { ...type.medium, color: colors.muted, fontSize: 17, textAlign: 'center' },
  heading: { ...type.heavy, color: colors.cream, fontSize: 21, marginTop: 20 },
  label: { ...type.medium, color: colors.muted, fontSize: 15 },
  value: { ...type.bold, color: colors.cream, fontSize: 18 },
  option: { gap: 8 },
  waiting: { ...type.medium, color: colors.muted, fontSize: 16, textAlign: 'center', paddingVertical: 12 },
  error: { ...type.bold, color: colors.danger, fontSize: 15, textAlign: 'center' },
});
