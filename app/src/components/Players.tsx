import { StyleSheet, Text, View } from 'react-native';

import { Pop } from '@/components/motion';
import { Button, Row } from '@/components/ui';
import { TableView } from '@/lib/api';
import { colors, type } from '@/lib/theme';

export function Players({ view, send }: { view: TableView; send: (msg: object) => void }) {
  const isHost = view.you === view.host;
  return (
    <View style={{ gap: 6 }}>
      {view.seats.map((seat) => (
        <Pop key={seat.id} from={0.94}>
        <Row style={styles.row}>
          <View style={styles.badge}>
            <Text style={styles.initial}>{seat.name[0].toUpperCase()}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={styles.name}>
              {seat.name}
              {seat.id === view.you ? ' (you)' : ''}
            </Text>
            {(seat.id === view.host || !seat.online) && (
              <Text style={styles.status}>{seat.online ? 'Host' : 'Offline'}</Text>
            )}
          </View>
          {isHost && seat.id !== view.you && (
            <Button
              label="Kick"
              kind="danger"
              onPress={() => send({ t: 'host', op: 'kick', target: seat.id })}
              style={{ minHeight: 44, width: 76 }}
            />
          )}
        </Row>
        </Pop>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 60, backgroundColor: colors.surface, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 6 },
  badge: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  initial: { ...type.heavy, color: colors.cream, fontSize: 18 },
  name: { ...type.bold, color: colors.cream, fontSize: 16 },
  status: { ...type.medium, color: colors.muted, fontSize: 13 },
});
