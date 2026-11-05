import { useFonts } from 'expo-font';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { BackHandler, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { colors } from '@/lib/theme';
import { Home } from '@/screens/Home';
import { Table } from '@/screens/Table';

SplashScreen.preventAutoHideAsync();

/** Two screens, so plain state does the routing: home, or the table you're at. */
export default function App() {
  const [teamId, setTeamId] = useState<string | null>(null);
  const [loaded, error] = useFonts({
    BricolageGrotesque_500Medium: require('../assets/fonts/BricolageGrotesque_500Medium.ttf'),
    BricolageGrotesque_700Bold: require('../assets/fonts/BricolageGrotesque_700Bold.ttf'),
    BricolageGrotesque_800ExtraBold: require('../assets/fonts/BricolageGrotesque_800ExtraBold.ttf'),
  });
  const ready = loaded || !!error;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!teamId) return false;
      setTeamId(null);
      return true;
    });
    return () => sub.remove();
  }, [teamId]);

  return (
    <SafeAreaProvider>
      <View style={{ flex: 1, backgroundColor: colors.bg }}>
        <StatusBar style="light" />
        {ready && (teamId ? <Table teamId={teamId} onExit={() => setTeamId(null)} /> : <Home onOpen={setTeamId} />)}
      </View>
    </SafeAreaProvider>
  );
}
