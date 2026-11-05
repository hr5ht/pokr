import { ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Animated, Easing, Modal, PanResponder, Pressable, StyleSheet, useWindowDimensions, View } from 'react-native';

import { colors } from '@/lib/theme';

const OPEN_MS = 460;
const CLOSE_MS = 300;
const DRAG_TO_CLOSE = 110;

type Props = {
  visible: boolean;
  onClose: () => void;
  onBack?: () => void; // Android back button; defaults to closing
  page?: string; // changing this slides the sheet down, swaps content, and slides it back up
  tallPage?: string;
  children: (page?: string) => ReactNode;
};

/** Slides up from below over a fading backdrop. Drag the handle down, or tap outside, to close. */
export function BottomSheet({ visible, onClose, onBack, page, tallPage, children }: Props) {
  const { height } = useWindowDimensions();
  const [mounted, setMounted] = useState(visible);
  const [shownPage, setShownPage] = useState(page);
  const open = useRef(new Animated.Value(0)).current;
  const dim = useRef(new Animated.Value(0)).current; // separate, so it holds steady during a page swap
  const drag = useRef(new Animated.Value(0)).current;
  const close = useRef(onClose);

  useEffect(() => {
    close.current = onClose;
  }, [onClose]);

  const slide = (toValue: number) =>
    Animated.timing(open, {
      toValue,
      duration: toValue ? OPEN_MS : CLOSE_MS,
      easing: toValue ? Easing.out(Easing.cubic) : Easing.in(Easing.cubic),
      useNativeDriver: true,
    });

  useEffect(() => {
    if (visible) {
      setMounted(true);
      setShownPage(page);
      drag.setValue(0);
      slide(1).start();
      Animated.timing(dim, { toValue: 1, duration: OPEN_MS, useNativeDriver: true }).start();
    } else {
      Animated.timing(dim, { toValue: 0, duration: CLOSE_MS, useNativeDriver: true }).start();
      slide(0).start(({ finished }) => finished && setMounted(false));
    }
  }, [visible]);

  useEffect(() => {
    if (!visible || page === shownPage) return;
    slide(0).start(({ finished }) => {
      if (!finished) return;
      setShownPage(page);
      drag.setValue(0);
      slide(1).start();
    });
  }, [page]);

  const pan = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onPanResponderMove: (_, g) => drag.setValue(Math.max(g.dy, 0)),
        onPanResponderRelease: (_, g) => {
          if (g.dy > DRAG_TO_CLOSE || g.vy > 1) close.current();
          else Animated.spring(drag, { toValue: 0, bounciness: 4, useNativeDriver: true }).start();
        },
      }),
    [drag],
  );

  const translateY = Animated.add(open.interpolate({ inputRange: [0, 1], outputRange: [height, 0] }), drag);

  return (
    <Modal visible={mounted} transparent animationType="none" statusBarTranslucent onRequestClose={onBack ?? onClose}>
      <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: dim }]}>
        <Pressable accessibilityLabel="Close" style={StyleSheet.absoluteFill} onPress={onClose} />
      </Animated.View>
      <Animated.View style={[styles.sheet, { maxHeight: tallPage && shownPage === tallPage ? '90%' : '78%', transform: [{ translateY }] }]}>
        <View {...pan.panHandlers} accessibilityLabel="Drag down to close" style={styles.handleArea}>
          <View style={styles.handle} />
        </View>
        {children(shownPage)}
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: { backgroundColor: 'rgba(0,0,0,0.55)' },
  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    overflow: 'hidden',
    borderTopLeftRadius: 28,
    borderTopRightRadius: 28,
    backgroundColor: colors.sheet,
  },
  handleArea: { height: 30, alignItems: 'center', justifyContent: 'center' },
  handle: { width: 44, height: 5, borderRadius: 3, backgroundColor: colors.line },
});
