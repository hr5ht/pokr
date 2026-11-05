import { useEffect, useState } from 'react';
import {
  Image,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BottomSheet } from '@/components/BottomSheet';
import { Backdrop, Fade, Pop } from '@/components/motion';
import { Button, Row } from '@/components/ui';
import {
  AuthError,
  clearLocalData,
  createGuest,
  createTeam,
  deleteGuest,
  forgetTeam,
  joinTeam,
  loadProfile,
  loadRecent,
  Profile,
  RecentTeam,
  rememberTeam,
  saveProfile,
  updateGuest,
} from '@/lib/api';
import { colors, type } from '@/lib/theme';

const NAMES = ['Lucky Duck', 'River Rat', 'Big Blind', 'Card Shark', 'Pocket Rocket', 'Slow Roll', 'Fish Taco', 'Ace Ventura'];
const pick = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

export function Home({ onOpen }: { onOpen: (teamId: string) => void }) {
  const insets = useSafeAreaInsets();
  const [ready, setReady] = useState(false);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [editing, setEditing] = useState(false);
  const [recent, setRecent] = useState<RecentTeam[]>([]);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setProfile(await loadProfile());
      setRecent(await loadRecent());
      setReady(true);
    })();
  }, []);

  const resetLocal = async () => {
    await clearLocalData();
    setProfile(null);
    setRecent([]);
    setEditing(false);
  };

  const enter = async (open: (token: string) => Promise<RecentTeam>) => {
    if (!profile) return;
    setBusy(true);
    setError('');
    try {
      const team = await open(profile.token);
      setRecent(await rememberTeam(team));
      setCode('');
      onOpen(team.teamId);
    } catch (e) {
      if (e instanceof AuthError) await resetLocal();
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const openRecent = async (team: RecentTeam) => {
    await enter((token) => joinTeam(token, team.code));
  };

  if (!ready) return <View style={styles.screen} />;

  if (!profile || editing) {
    return (
      <Fade key="profile">
      <ProfileForm
        profile={profile}
        onSaved={(p) => {
          setProfile(p);
          setEditing(false);
          setError('');
        }}
        onCancel={profile ? () => setEditing(false) : undefined}
        onReset={resetLocal}
      />
      </Fade>
    );
  }

  return (
    <Fade key="home">
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Backdrop />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Image source={require('../../assets/logo.png')} style={styles.logo} accessibilityIgnoresInvertColors />
        <Text style={[styles.title, { textAlign: 'center' }]}>Pokr</Text>
        <Text style={[styles.note, { textAlign: 'center', marginBottom: 28 }]}>Private poker with friends</Text>

        <Button label="Create a team" onPress={() => enter(createTeam)} disabled={busy} />

        <Text style={[styles.heading, { textAlign: 'center' }]}>Got a code?</Text>
        <Row>
          <TextInput
            accessibilityLabel="Team code"
            value={code}
            onChangeText={(t) => setCode(t.replace(/[^0-9]/g, ''))}
            maxLength={4}
            keyboardType="number-pad"
            placeholder="4821"
            placeholderTextColor={colors.muted}
            style={[styles.input, styles.codeInput]}
          />
          <Button
            label="Join"
            kind="plain"
            disabled={busy || code.length !== 4}
            onPress={() => enter((t) => joinTeam(t, code))}
            style={{ width: 96 }}
          />
        </Row>

        {!!error && <Pop key={error}><Text style={styles.error}>{error}</Text></Pop>}

        {recent.length > 0 && (
          <>
            <Text style={styles.heading}>Your teams</Text>
            {recent.map((team) => (
              <Row key={team.teamId}>
                <Button
                  label={team.code}
                  kind="plain"
                  disabled={busy}
                  onPress={() => openRecent(team)}
                  style={{ flex: 1 }}
                />
                <Button
                  label="✕"
                  kind="plain"
                  onPress={async () => {
                    await forgetTeam(team.teamId);
                    setRecent(await loadRecent());
                  }}
                  style={{ width: 52 }}
                />
              </Row>
            ))}
          </>
        )}
      </ScrollView>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Profile: ${profile.name}`}
        onPress={() => setEditing(true)}
        style={[styles.profile, { top: insets.top + 8 }]}>
        <Text style={styles.profileInitial}>{profile.name[0].toUpperCase()}</Text>
      </Pressable>
    </KeyboardAvoidingView>
    </Fade>
  );
}

type FormProps = {
  profile: Profile | null;
  onSaved: (p: Profile) => void;
  onCancel?: () => void;
  onReset: () => void;
};

function ProfileForm({ profile, onSaved, onCancel, onReset }: FormProps) {
  const insets = useSafeAreaInsets();
  const [name, setName] = useState(() => profile?.name ?? pick(NAMES));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [confirmingReset, setConfirmingReset] = useState(false);

  const save = async () => {
    const clean = name.trim();
    setBusy(true);
    setError('');
    try {
      let next: Profile;
      if (profile) {
        await updateGuest(profile.token, clean);
        next = { ...profile, name: clean };
      } else {
        next = { ...(await createGuest(clean)), name: clean };
      }
      await saveProfile(next);
      onSaved(next);
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const reset = async () => {
    setBusy(true);
    try {
      await deleteGuest(profile!.token);
    } catch {
      // Already gone or offline: this device forgets it either way.
    }
    setConfirmingReset(false);
    onReset();
  };

  return (
    <KeyboardAvoidingView style={styles.screen} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <Backdrop />
      <ScrollView
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={[styles.content, { paddingTop: insets.top + 24, paddingBottom: insets.bottom + 24 }]}>
        <Text style={styles.title}>{profile ? 'Your profile' : 'Pick a name'}</Text>
        <Text style={styles.note}>No sign-up. Your profile stays on this phone.</Text>
        <TextInput
          accessibilityLabel="Your name"
          value={name}
          onChangeText={setName}
          maxLength={16}
          style={styles.input}
        />
        {!!error && <Pop key={error}><Text style={styles.error}>{error}</Text></Pop>}
        <Button label={profile ? 'Save' : "Let's play"} onPress={save} disabled={busy || !name.trim()} />
        {onCancel && <Button label="Cancel" kind="plain" onPress={onCancel} />}
        {profile && <Button label="Reset profile" kind="danger" onPress={() => setConfirmingReset(true)} />}
      </ScrollView>

      <BottomSheet visible={confirmingReset} onClose={() => setConfirmingReset(false)}>
        {() => (
          <View style={[styles.resetSheet, { paddingBottom: insets.bottom + 20 }]}>
            <Text style={styles.resetTitle}>Reset your profile?</Text>
            <Text style={styles.resetNote}>
              Your name and your list of teams will be removed from this phone. You'll leave any table you're at. This
              can't be undone.
            </Text>
            <Button label="Reset profile" kind="destructive" disabled={busy} onPress={reset} />
            <Button label="Keep my profile" kind="plain" onPress={() => setConfirmingReset(false)} />
          </View>
        )}
      </BottomSheet>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  content: { paddingHorizontal: 20, gap: 12 },
  logo: { width: 160, height: 160, alignSelf: 'center', marginTop: 12 },
  title: { ...type.heavy, color: colors.cream, fontSize: 52, letterSpacing: -1.5 },
  note: { ...type.medium, color: colors.muted, fontSize: 17 },
  heading: { ...type.bold, color: colors.muted, fontSize: 15, marginTop: 20 },
  profile: {
    position: 'absolute',
    right: 20,
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accent,
  },
  profileInitial: { ...type.heavy, color: colors.accentText, fontSize: 20 },
  input: {
    minHeight: 58,
    backgroundColor: colors.surface,
    borderRadius: 29,
    paddingHorizontal: 22,
    color: colors.cream,
    fontSize: 18,
    ...type.bold,
  },
  codeInput: { flex: 1, letterSpacing: 4, fontSize: 22, ...type.heavy },
  error: { ...type.bold, color: colors.danger, fontSize: 15, textAlign: 'center' },
  resetSheet: { gap: 10, paddingHorizontal: 24, paddingTop: 4 },
  resetTitle: { ...type.heavy, color: colors.cream, fontSize: 28, letterSpacing: -0.5 },
  resetNote: { ...type.medium, color: colors.muted, fontSize: 16, lineHeight: 22, marginBottom: 10 },
});
