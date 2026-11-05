import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { TableView, WS_URL } from './api';

const NOT_A_MEMBER = new Set([4001, 4003]);

/** The server always sends the full table, so reconnecting needs no special handling. */
export function useTable(teamId: string, token: string | undefined) {
  const [view, setView] = useState<TableView | null>(null);
  const [connected, setConnected] = useState(false);
  const [removed, setRemoved] = useState(false);
  const [error, setError] = useState('');
  const sock = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!token) return;
    let stopped = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout>;

    const connect = () => {
      if (stopped) return;
      const ws = new WebSocket(`${WS_URL}/ws/${teamId}`);
      sock.current = ws;
      ws.onopen = () => {
        if (sock.current !== ws) {
          ws.close(); // a newer socket took over while this one was still opening
          return;
        }
        attempts = 0;
        ws.send(JSON.stringify({ token }));
        setConnected(true);
      };
      ws.onmessage = (event) => {
        if (sock.current !== ws) return;
        const msg = JSON.parse(event.data);
        if (msg.t === 'view') {
          setView(msg.view);
          setError('');
        } else if (msg.t === 'error') {
          setError(msg.msg);
        }
      };
      ws.onclose = (event) => {
        if (sock.current !== ws) return;
        setConnected(false);
        if (NOT_A_MEMBER.has(event.code)) setRemoved(true);
        else retry = setTimeout(connect, Math.min(500 * 2 ** attempts++, 8000));
      };
    };

    connect();
    // Phones kill sockets in the background, so don't wait for the backoff on return.
    const sub = AppState.addEventListener('change', (state) => {
      const socketState = sock.current?.readyState;
      if (state === 'active' && socketState !== WebSocket.OPEN && socketState !== WebSocket.CONNECTING) {
        clearTimeout(retry);
        const old = sock.current;
        connect();
        old?.close();
      }
    });

    return () => {
      stopped = true;
      clearTimeout(retry);
      sub.remove();
      const ws = sock.current;
      sock.current = null;
      ws?.close();
    };
  }, [teamId, token]);

  const send = useCallback((msg: object) => {
    if (sock.current?.readyState === WebSocket.OPEN) sock.current.send(JSON.stringify(msg));
  }, []);

  return { view, connected, removed, error, send };
}
