import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { ApiError, AuthError, pollTable, sendAction, TableResponse, TableView } from './api';

const POLL_MS = 800;
const FAILURES_BEFORE_WARNING = 3;
const ERROR_SHOWN_MS = 3000;

/** Asks the server for the table about once a second while the app is open.
 *  Every answer is the whole table, so a missed one fixes itself on the next. */
export function useTable(teamId: string, token: string | undefined) {
  const [view, setView] = useState<TableView | null>(null);
  const [connected, setConnected] = useState(true);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');
  const version = useRef(0);

  // A poll and a move can pass each other on the network, so never go backwards.
  const apply = useCallback((res: TableResponse) => {
    if (res.view && res.version >= version.current) {
      version.current = res.version;
      setView(res.view);
    }
  }, []);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let failures = 0;
    let timer: ReturnType<typeof setTimeout>;

    const poll = async () => {
      if (AppState.currentState === 'active') {
        try {
          const res = await pollTable(token, teamId);
          if (stopped) return;
          apply(res);
          failures = 0;
          setConnected(true);
        } catch (e) {
          if (stopped) return;
          const gone = e instanceof AuthError || (e instanceof ApiError && [403, 404].includes(e.status));
          if (gone) {
            setRemoved(true);
            return;
          }
          failures += 1;
          if (failures >= FAILURES_BEFORE_WARNING) setConnected(false);
        }
      }
      timer = setTimeout(poll, POLL_MS);
    };

    poll();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [teamId, token, apply]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), ERROR_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const send = useCallback(
    async (msg: object) => {
      if (!token) return;
      try {
        const res = await sendAction(token, teamId, msg);
        apply(res);
        setError(res.error);
      } catch {
        setError("Couldn't reach the server. Try again.");
      }
    },
    [teamId, token, apply],
  );

  return { view, connected, removed, error, send };
}
