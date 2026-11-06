import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TableResponse, TableView, WS_URL } from './api';

const PING_MS = 5000;
const SILENT_MS = 12000; // on mobile a dead connection can stay "open" for minutes, so go by replies
const SWAP_SOCKET_MS = 270000; // Vercel closes sockets at 5 minutes, so move on first
const WATCH_MS = 1000;
const WARN_AFTER_MS = 2000; // a quick reconnect shouldn't flash a warning
const ERROR_SHOWN_MS = 3000;
const NOT_AT_TABLE = new Set([4001, 4003, 4004]);

/** Every message from the server is the whole table, so reconnecting needs no catching up. */
export function useTable(teamId: string, token: string | undefined) {
  const [view, setView] = useState<TableView | null>(null);
  const [connected, setConnected] = useState(true);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');
  const sock = useRef<WebSocket | null>(null);
  const version = useRef(0);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout>;
    let pending: WebSocket | null = null; // not trusted until the server has answered it
    let startedAt = 0;
    let openedAt = 0;
    let heardAt = Date.now();
    let pingedAt = Date.now();

    const connect = () => {
      const stale = pending;
      const ws = new WebSocket(`${WS_URL}/ws/${teamId}`);
      pending = ws;
      startedAt = Date.now();
      stale?.close();

      ws.onopen = () => ws.send(JSON.stringify({ token }));
      ws.onmessage = (event) => {
        if (ws === pending) {
          const old = sock.current;
          sock.current = ws;
          pending = null;
          openedAt = Date.now();
          old?.close();
        }
        if (ws !== sock.current) return;
        attempts = 0;
        heardAt = Date.now();
        setConnected(true);
        const res: TableResponse = JSON.parse(event.data);
        if (res.version >= version.current) {
          version.current = res.version;
          setView(res.view);
        }
        if (res.error) setError(res.error);
      };
      ws.onclose = (event) => {
        if (stopped) return;
        if (NOT_AT_TABLE.has(event.code)) {
          setRemoved(true);
          return;
        }
        if (ws === sock.current) sock.current = null;
        else if (ws === pending) pending = null;
        else return; // an old socket we already replaced
        // In the background nothing pings, so stay offline until the player comes back.
        if (!sock.current && !pending && AppState.currentState === 'active') {
          retry = setTimeout(connect, Math.min(500 * 2 ** attempts++, 8000));
        }
      };
    };

    // close() on a dead connection can take a minute to report back, so don't wait for it.
    const reconnect = () => {
      const dead = sock.current;
      sock.current = null;
      clearTimeout(retry);
      connect();
      dead?.close();
    };

    const watch = () => {
      if (AppState.currentState !== 'active') return;
      const now = Date.now();
      const ws = sock.current;
      setConnected(!!ws || now - heardAt < WARN_AFTER_MS);
      if (pending) {
        if (now - startedAt > SILENT_MS) connect();
      } else if (ws && now - heardAt > SILENT_MS) {
        reconnect();
      } else if (ws && now - openedAt > SWAP_SOCKET_MS) {
        connect(); // the old socket carries on until this one answers
      }
      if (sock.current?.readyState === WebSocket.OPEN && now - pingedAt >= PING_MS) {
        pingedAt = now;
        sock.current.send(JSON.stringify({ t: 'ping' }));
      }
    };

    connect();
    const watcher = setInterval(watch, WATCH_MS);
    // Phones kill sockets in the background, so don't wait to notice on return.
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active' && (!sock.current || Date.now() - heardAt > PING_MS)) reconnect();
    });

    return () => {
      stopped = true;
      clearTimeout(retry);
      clearInterval(watcher);
      sub.remove();
      pending?.close();
      sock.current?.close();
      sock.current = null;
    };
  }, [teamId, token]);

  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(''), ERROR_SHOWN_MS);
    return () => clearTimeout(timer);
  }, [error]);

  const send = useCallback((msg: object) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify(msg));
    else setError('Reconnecting. Try again in a moment.');
  }, []);

  return { view, connected, removed, error, send };
}
