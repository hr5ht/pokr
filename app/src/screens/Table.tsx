import { useKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/BottomSheet';
import { Game } from '@/components/Game';
import { Lobby } from '@/components/Lobby';
import { Backdrop, Fade, Pulse } from '@/components/motion';
import { PlayingCard } from '@/components/PlayingCard';
import { Button } from '@/components/ui';
import { loadProfile } from '@/lib/api';
import { colors, type } from '@/lib/theme';
import { useTable } from '@/lib/useTable';

export function Table({ teamId, onExit }: { teamId: string; onExit: () => void }) {
  const insets = useSafeAreaInsets();
  const [token, setToken] = useState<string>();
  const { view, connected, removed, error, send } = useTable(teamId, token);
  useKeepAwake();

  useEffect(() => {
    loadProfile().then((p) => (p ? setToken(p.token) : onExit()));
  }, [onExit]);

  const leave = () => {
    send({ t: 'leave' });
    onExit();
  };
  const share = () => view && Share.share({ message: `Join my poker team on Pokr. Team code: ${view.code}` });

  const inGame = !!view && (view.running || (!!view.hand && !view.hand.result));
  const props = view && { view, send, connected, error, onShare: share, onLeave: leave, onExit };

  return (
    <View style={styles.screen}>
      {props ? (
        <Fade key={inGame ? 'game' : 'lobby'}>{inGame ? <Game {...props} /> : <Lobby {...props} />}</Fade>
      ) : (
        <View style={styles.center}>
          <Backdrop />
          <Pulse active>
            <PlayingCard width={84} />
          </Pulse>
          <Text style={styles.text}>Finding your seat…</Text>
        </View>
      )}

      <BottomSheet visible={removed} onClose={onExit}>
        {() => (
          <View style={[styles.sheet, { paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.title}>You're off this table</Text>
            <Text style={styles.note}>
              The host may have removed you, or you were away for too long. Ask for the code to join again.
            </Text>
            <Button label="Back to home" onPress={onExit} />
          </View>
        )}
      </BottomSheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 24 },
  text: { ...type.bold, color: colors.muted, fontSize: 17 },
  sheet: { gap: 10, paddingHorizontal: 24, paddingTop: 4 },
  title: { ...type.heavy, color: colors.cream, fontSize: 28, letterSpacing: -0.5 },
  note: { ...type.medium, color: colors.muted, fontSize: 16, lineHeight: 22, marginBottom: 10 },
});
