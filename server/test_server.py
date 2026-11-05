"""Run: .venv/bin/python test_server.py"""
import json
import os
import tempfile

os.environ["POKER_DB"] = os.path.join(tempfile.mkdtemp(), "test.db")

from fastapi.testclient import TestClient

import main


def guest(client, name):
    r = client.post("/guests", json={"name": name}).json()
    return {"id": r["id"], "token": r["token"], "auth": {"Authorization": f"Bearer {r['token']}"}}


def join(client, g, code):
    return client.post("/teams/join", json={"code": code}, headers=g["auth"])


def connect(client, g, team_id):
    ws = client.websocket_connect(f"/ws/{team_id}")
    ws.__enter__()
    ws.send_json({"token": g["token"]})
    return ws


def wait_view(ws, ok, tries=200):
    for _ in range(tries):
        msg = ws.receive_json()
        if msg["t"] == "view" and ok(msg["view"]):
            return msg["view"]
    raise AssertionError("view never arrived")


def wait_error(ws):
    for _ in range(50):
        msg = ws.receive_json()
        if msg["t"] == "error":
            return msg["msg"]
    raise AssertionError("no error arrived")


def test_guest_input_is_validated():
    with TestClient(main.app) as c:
        assert c.post("/guests", json={"name": "   "}).status_code == 422
        assert c.post("/guests", json={"name": "x" * 17}).status_code == 422
        assert c.post("/teams").status_code == 401
        assert c.post("/teams", headers={"Authorization": "Bearer nope"}).status_code == 401


def test_full_flow():
    with TestClient(main.app) as c:
        a, b, intruder = guest(c, "A"), guest(c, "B"), guest(c, "I")
        team = c.post("/teams", headers=a["auth"]).json()
        code, tid = team["code"], team["teamId"]
        assert len(code) == 4 and code.isdigit()
        assert join(c, b, code).status_code == 200
        assert join(c, intruder, "0000").status_code == 404

        # Knowing the team id isn't enough: only members get a socket.
        ws = connect(c, intruder, tid)
        try:
            ws.receive_json()
            raise AssertionError("non-member got a view")
        except Exception as e:
            assert "4003" in repr(e) or getattr(e, "code", None) == 4003
        ws.__exit__(None, None, None)

        wa, wb = connect(c, a, tid), connect(c, b, tid)
        wait_view(wa, lambda v: sum(s["online"] for s in v["seats"]) == 2)

        # Only the host starts.
        wb.send_json({"t": "host", "op": "start"})
        assert wait_error(wb) == "host only"

        wa.send_json({"t": "host", "op": "start"})
        va = wait_view(wa, lambda v: v["hand"] is not None)
        vb = wait_view(wb, lambda v: v["hand"] is not None)
        team_state = main.teams[tid]
        hand = team_state["hand"]

        # Redaction: each player sees only their own cards, and the deck never leaves.
        for view, viewer, other in ((va, a, b), (vb, b, a)):
            wire = json.dumps(view)
            mine = next(p for p in hand.players if p["id"] == viewer["id"])
            theirs = next(p for p in hand.players if p["id"] == other["id"])
            assert all(card in wire for card in mine["cards"])
            assert not any(f'"{card}"' in wire for card in theirs["cards"])
            assert not any(f'"{card}"' in wire for card in hand.deck)

        # Stale tap: a wrong seq is refused and changes nothing.
        actor, ws_actor = (a, wa) if va["hand"]["toAct"] == a["id"] else (b, wb)
        ws_actor.send_json({"t": "act", "seq": 99, "action": "call"})
        assert wait_error(ws_actor) == "too late"
        assert hand.seq == 0

        # Junk must not kill the socket.
        ws_actor.send_json({"t": "act", "seq": "x"})
        wait_error(ws_actor)
        ws_actor.send_text("not json")
        wait_error(ws_actor)

        # Fold ends the hand, and chips move on the server's stacks.
        ws_actor.send_json({"t": "act", "seq": 0, "action": "fold"})
        ended = wait_view(ws_actor, lambda v: v["hand"]["result"] is not None)
        assert sum(s["stack"] for s in ended["seats"]) == 2000
        assert ended["hand"]["result"]["shown"] == []

        # A snapshot written mid-game loads back into an identical table.
        saved = main.db.execute("SELECT data FROM teams WHERE id = ?", (tid,)).fetchone()["data"]
        restored = json.loads(saved)
        assert restored["hand"]["board"] == hand.board and "deck" in restored["hand"]

        # Rotating the code kills the old one; kicking bans the guest.
        wa.send_json({"t": "host", "op": "rotate"})
        rotated = wait_view(wa, lambda v: v["code"] != code)
        assert join(c, intruder, code).status_code == 404
        assert join(c, intruder, rotated["code"]).status_code == 200

        wa.send_json({"t": "host", "op": "kick", "target": intruder["id"]})
        wait_view(wa, lambda v: all(s["id"] != intruder["id"] for s in v["seats"]))
        assert join(c, intruder, rotated["code"]).status_code == 403

        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)


def test_turn_timeout_folds_and_sits_out():
    with TestClient(main.app) as c:
        a, b = guest(c, "A"), guest(c, "B")
        team = c.post("/teams", headers=a["auth"]).json()
        join(c, b, team["code"])
        wa, wb = connect(c, a, team["teamId"]), connect(c, b, team["teamId"])
        wait_view(wa, lambda v: sum(s["online"] for s in v["seats"]) == 2)
        wa.send_json({"t": "host", "op": "start"})
        first = wait_view(wa, lambda v: v["hand"] is not None)

        state = main.teams[team["teamId"]]
        idle = first["hand"]["toAct"]
        state["deadline"] = 0  # the ticker should act for the idle player
        done = wait_view(wa, lambda v: v["hand"]["result"] is not None)
        assert next(s for s in done["seats"] if s["id"] == idle)["last"] == "Fold"
        assert main.member(state, idle)["timeouts"] == 1

        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)


def test_host_handover_and_join_full():
    with TestClient(main.app) as c:
        a = guest(c, "A")
        team = c.post("/teams", headers=a["auth"]).json()
        for i in range(11):
            assert join(c, guest(c, f"P{i}"), team["code"]).status_code == 200
        assert join(c, guest(c, "late"), team["code"]).status_code == 409

        state = main.teams[team["teamId"]]
        state["members"][1]["offlineSince"] = None
        assert not main.ensure_host(state, 0)  # host is still inside the grace period
        state["members"][0]["offlineSince"] = 1
        assert main.ensure_host(state, 1 + main.HOST_ABSENT_SECS + 1)
        assert state["host"] == state["members"][1]["id"]


def test_restart_resumes_hand():
    with TestClient(main.app) as c:
        a, b = guest(c, "A"), guest(c, "B")
        team = c.post("/teams", headers=a["auth"]).json()
        join(c, b, team["code"])
        wa, wb = connect(c, a, team["teamId"]), connect(c, b, team["teamId"])
        wait_view(wa, lambda v: sum(s["online"] for s in v["seats"]) == 2)
        wa.send_json({"t": "host", "op": "start"})
        before = wait_view(wa, lambda v: v["hand"] is not None)
        wa.send_json({"t": "act", "seq": 0, "action": "call"}) if before["hand"]["toAct"] == a["id"] else \
            wb.send_json({"t": "act", "seq": 0, "action": "call"})
        wait_view(wa, lambda v: v["hand"]["seq"] == 1)
        cards = list(main.teams[team["teamId"]]["hand"].players[0]["cards"])
        wa.__exit__(None, None, None)
        wb.__exit__(None, None, None)

    with TestClient(main.app) as c:  # lifespan reloads from SQLite
        hand = main.teams[team["teamId"]]["hand"]
        assert hand.seq == 1 and hand.players[0]["cards"] == cards
        wa = connect(c, a, team["teamId"])
        view = wait_view(wa, lambda v: v["hand"] is not None)
        assert view["hand"]["seq"] == 1 and view["hand"]["turnMs"] > 0
        wa.__exit__(None, None, None)


def test_join_is_rate_limited():
    with TestClient(main.app) as c:
        a = guest(c, "A")
        main.recent_hits.clear()
        codes = [join(c, a, "0000").status_code for _ in range(25)]
        assert codes[:20] == [404] * 20 and codes[20:] == [429] * 5


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            main.recent_hits.clear()
            fn()
            print("ok", name)
