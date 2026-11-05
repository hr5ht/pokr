"""Game server: guest profiles, team codes and the live table.

Run: .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import secrets
import sqlite3
import time
import uuid
from collections import defaultdict, deque
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel, ValidationError, constr

from engine import DECK, Hand, IllegalAction

log = logging.getLogger("poker")

CODE_LENGTH = 4
MAX_SEATS = 12
SETTING_CHOICES = {"bb": (2, 10, 20, 50, 100), "stack": (500, 1000, 2000, 5000), "timer": (15, 30, 60)}
DEFAULT_SETTINGS = {"bb": 10, "stack": 1000, "timer": 30}
FOLD_PAUSE_SECS = 3  # time to read the result before the next hand
SHOWDOWN_PAUSE_SECS = 7
TIMEOUTS_BEFORE_SIT_OUT = 2
SEAT_HELD_SECS = 30 * 60
HOST_ABSENT_SECS = 10 * 60
TEAM_EXPIRES_SECS = 90 * 24 * 3600

# One connection, used only from the event loop: every route must be `async def`, because
# FastAPI runs plain `def` routes on worker threads and sharing this across threads corrupts it.
db = sqlite3.connect(os.environ.get("POKER_DB", "poker.db"), isolation_level=None, check_same_thread=False)
db.row_factory = sqlite3.Row
db.executescript("""
    PRAGMA journal_mode=WAL;
    PRAGMA synchronous=NORMAL;
    CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, name TEXT);
    CREATE TABLE IF NOT EXISTS teams(id TEXT PRIMARY KEY, code TEXT UNIQUE, data TEXT);
""")

teams: dict[str, dict] = {}
conns: dict[str, dict[str, WebSocket]] = defaultdict(dict)  # team id -> guest id -> socket


# --- persistence -------------------------------------------------------------

def save(team: dict) -> None:
    """Runs after every change, so a restart resumes mid-hand."""
    team["lastActive"] = time.time()
    db.execute("INSERT OR REPLACE INTO teams VALUES (?, ?, ?)", (team["id"], team["code"], json.dumps(team, default=vars)))


def load_teams() -> None:
    teams.clear()
    now = time.time()
    for row in db.execute("SELECT data FROM teams"):
        team = json.loads(row["data"])
        if team["hand"]:
            team["hand"] = Hand.from_json(team["hand"])
        for m in team["members"]:
            m["offlineSince"] = m["offlineSince"] or now  # nobody is connected yet
        if team["deadline"]:
            team["deadline"] = now + team["settings"]["timer"]  # give everyone time to reconnect
        teams[team["id"]] = team


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def guest_for_token(token: object) -> Optional[sqlite3.Row]:
    if not isinstance(token, str):
        return None
    return db.execute("SELECT * FROM guests WHERE token_hash = ?", (hash_token(token),)).fetchone()


# --- table -------------------------------------------------------------------

def member(team: dict, gid: str) -> Optional[dict]:
    return next((m for m in team["members"] if m["id"] == gid), None)


def new_code() -> str:
    # only 10,000 codes, so give up rather than spin; lengthen CODE_LENGTH if this fires.
    for _ in range(200):
        code = "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))
        if not db.execute("SELECT 1 FROM teams WHERE code = ?", (code,)).fetchone():
            return code
    raise IllegalAction("no free team codes right now")


def add_member(team: dict, guest: sqlite3.Row) -> None:
    taken = {m["seat"] for m in team["members"]}
    team["members"].append({
        "id": guest["id"], "name": guest["name"],
        "seat": min(set(range(MAX_SEATS)) - taken),
        "stack": team["settings"]["stack"],
        "sittingOut": False, "timeouts": 0, "gone": False, "offlineSince": time.time(),
    })


def live_hand(team: dict) -> Optional[Hand]:
    h = team["hand"]
    return h if h and not h.result else None


def remove_member(team: dict, gid: str) -> None:
    """A player in a live hand stays until it ends; the ticker folds them on their turn."""
    m = member(team, gid)
    if not m:
        return
    h = live_hand(team)
    if h and any(p["id"] == gid for p in h.players):
        m["gone"] = m["sittingOut"] = True
    else:
        team["members"].remove(m)


def deal(team: dict) -> bool:
    ready = sorted(
        (m for m in team["members"] if m["stack"] > 0 and not m["sittingOut"] and not m["offlineSince"]),
        key=lambda m: m["seat"],
    )
    if len(ready) < 2:
        return False
    button_seat = next((m["seat"] for m in ready if m["seat"] > team["buttonSeat"]), ready[0]["seat"])
    button = next(i for i, m in enumerate(ready) if m["seat"] == button_seat)
    bb = team["settings"]["bb"]
    deck = list(DECK)
    secrets.SystemRandom().shuffle(deck)
    team["buttonSeat"] = button_seat
    team["hand"] = Hand([(m["id"], m["stack"]) for m in ready], button, max(bb // 2, 1), bb, deck)
    after_action(team)
    return True


def after_action(team: dict) -> None:
    h = team["hand"]
    if not h.result:
        team["deadline"] = time.time() + team["settings"]["timer"]
        return
    for p in h.players:
        m = member(team, p["id"])
        if m:
            m["stack"] = p["stack"]
    team["members"] = [m for m in team["members"] if not m["gone"]]
    team["deadline"] = 0
    team["nextHandAt"] = time.time() + (SHOWDOWN_PAUSE_SECS if h.result["shown"] else FOLD_PAUSE_SECS)


def handle_host(team: dict, msg: "Msg") -> None:
    op = msg.op
    if op == "start":
        if team["running"] or live_hand(team):
            raise IllegalAction("game already running")
        for m in team["members"]:
            m.update(stack=team["settings"]["stack"], sittingOut=False, timeouts=0)
        team.update(running=True, paused=False, nextHandAt=0, hand=None)
    elif op == "end":
        team["running"] = False  # a live hand plays out, then the table returns to the lobby
    elif op == "pause":
        team["paused"] = True
    elif op == "resume":
        team["paused"] = False
        if live_hand(team):
            team["deadline"] = time.time() + team["settings"]["timer"]
    elif op == "settings":
        if team["running"]:
            raise IllegalAction("end the game first")
        for key, value in (msg.settings or {}).items():
            if value not in SETTING_CHOICES.get(key, ()):
                raise IllegalAction("bad setting")
            team["settings"][key] = value
        for m in team["members"]:
            m["stack"] = team["settings"]["stack"]
    elif op == "kick":
        if msg.target == team["host"] or not member(team, msg.target or ""):
            raise IllegalAction("can't kick that player")
        team["banned"].append(msg.target)
        remove_member(team, msg.target)
    elif op == "rotate":
        team["code"] = new_code()
    else:
        raise IllegalAction("unknown host action")


def handle(team: dict, gid: str, msg: "Msg") -> None:
    m = member(team, gid)
    if not m:
        raise IllegalAction("not at this table")
    if msg.t == "act":
        h = live_hand(team)
        if not h or team["paused"] or msg.seq != h.seq:
            raise IllegalAction("too late")
        h.act(gid, msg.action or "", msg.amount)
        m["timeouts"] = 0
        after_action(team)
    elif msg.t == "sit":
        m.update(sittingOut=False, timeouts=0)
    elif msg.t == "sitOut":
        m["sittingOut"] = True
    elif msg.t == "rebuy":
        if m["stack"] > 0 or live_hand(team) and any(p["id"] == gid for p in live_hand(team).players):
            raise IllegalAction("you still have chips")
        m["stack"] = team["settings"]["stack"]
    elif msg.t == "leave":
        remove_member(team, gid)
    elif msg.t == "host":
        if gid != team["host"]:
            raise IllegalAction("host only")
        handle_host(team, msg)
    else:
        raise IllegalAction("unknown message")


def view_for(team: dict, gid: str) -> dict:
    """Everything a player may see. All outgoing state goes through here, so this
    is the one place that keeps the deck and other players' cards off the wire."""
    h = team["hand"]
    live = live_hand(team)
    in_hand = {p["id"]: p for p in h.players} if h else {}
    shown = set(h.result["shown"]) if h and h.result else set()
    online = conns[team["id"]]

    seats = []
    for m in sorted(team["members"], key=lambda m: m["seat"]):
        p = in_hand.get(m["id"])
        seats.append({
            "id": m["id"], "name": m["name"],
            "online": m["id"] in online,
            "sittingOut": m["sittingOut"],
            "stack": p["stack"] if p and live else m["stack"],
            "inHand": bool(p),
            "folded": bool(p and p["folded"]),
            "allin": bool(p and p["allin"]),
            "bet": p["bet"] if p and live else 0,
            "last": p["last"] if p else "",
            "cards": p["cards"] if p and (m["id"] == gid or m["id"] in shown) else None,
        })

    hand = None
    if h:
        turn = h.players[h.to_act]["id"] if h.to_act is not None else None
        mine = gid in in_hand
        hand = {
            "board": h.board,
            "pot": h.result["pot"] if h.result else h.pot,
            "seq": h.seq,
            "toAct": turn,
            "turnMs": int(max(team["deadline"] - time.time(), 0) * 1000) if turn else 0,
            "current": h.current,
            "legal": h.legal() if turn == gid else None,
            "handName": h.current_name(gid) if mine else None,
            "result": h.result,
        }

    return {
        "you": gid, "code": team["code"], "host": team["host"],
        "settings": team["settings"], "running": team["running"], "paused": team["paused"],
        "seats": seats, "hand": hand,
    }


async def push(team: dict) -> None:
    save(team)
    sockets = conns[team["id"]]
    for gid, sock in list(sockets.items()):
        m = member(team, gid)
        try:
            if not m or m["gone"]:
                del sockets[gid]
                await sock.close(code=4003)
            else:
                await asyncio.wait_for(sock.send_json({"t": "view", "view": view_for(team, gid)}), 5)
        except Exception:
            sockets.pop(gid, None)


def ensure_host(team: dict, now: float) -> bool:
    """With no accounts a host can vanish for good, so someone present takes over."""
    host = member(team, team["host"])
    absent = not host or (host["offlineSince"] and now - host["offlineSince"] > HOST_ABSENT_SECS)
    heir = next((m for m in sorted(team["members"], key=lambda m: m["seat"]) if not m["offlineSince"]), None)
    if absent and heir:
        team["host"] = heir["id"]
        return True
    return False


async def tick(team: dict) -> None:
    now = time.time()
    changed = ensure_host(team, now)

    for m in list(team["members"]):
        if m["offlineSince"] and now - m["offlineSince"] > SEAT_HELD_SECS:
            remove_member(team, m["id"])
            changed = True

    h = live_hand(team)
    if h and not team["paused"]:
        p = h.players[h.to_act]
        m = member(team, p["id"])
        away = not m or m["sittingOut"] or m["gone"]
        if away or now >= team["deadline"]:
            if not away:
                m["timeouts"] += 1
                m["sittingOut"] = m["timeouts"] >= TIMEOUTS_BEFORE_SIT_OUT
            h.act(p["id"], "fold" if h.legal()["call"] else "check")
            after_action(team)
            changed = True
    elif not h and team["running"] and not team["paused"] and now >= team["nextHandAt"]:
        changed = deal(team) or changed

    if changed:
        await push(team)


async def ticker() -> None:
    # scans every team twice a second; fine for thousands of teams on one box.
    while True:
        await asyncio.sleep(0.5)
        now = time.time()
        for team in list(teams.values()):
            try:
                if not conns[team["id"]] and now - team["lastActive"] > TEAM_EXPIRES_SECS:
                    del teams[team["id"]]
                    db.execute("DELETE FROM teams WHERE id = ?", (team["id"],))
                else:
                    await tick(team)
            except Exception:
                log.exception("tick failed for team %s", team["id"])


# --- HTTP --------------------------------------------------------------------

@asynccontextmanager
async def lifespan(_: FastAPI):
    load_teams()
    task = asyncio.create_task(ticker())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

recent_hits: dict[str, deque] = defaultdict(deque)


def rate_limit(request: Request, limit: int = 20, window: int = 60) -> None:
    # per-process and per-IP. Behind a proxy, run uvicorn with --proxy-headers.
    now = time.time()
    hits = recent_hits[f"{request.client.host}:{request.url.path}"]
    while hits and now - hits[0] > window:
        hits.popleft()
    if len(hits) >= limit:
        raise HTTPException(429, "Too many attempts. Try again in a minute.")
    hits.append(now)


def current_guest(authorization: Optional[str]) -> sqlite3.Row:
    guest = guest_for_token((authorization or "").replace("Bearer ", "", 1))
    if not guest:
        raise HTTPException(401, "Unknown guest")
    return guest


Name = constr(strip_whitespace=True, min_length=1, max_length=16)


class Profile(BaseModel):
    name: Name


class Join(BaseModel):
    code: constr(strip_whitespace=True, pattern=r"^[0-9]{4}$")


class Msg(BaseModel):
    t: str
    seq: Optional[int] = None
    action: Optional[str] = None
    amount: Optional[int] = None
    op: Optional[str] = None
    target: Optional[str] = None
    settings: Optional[dict] = None


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/guests")
async def create_guest(profile: Profile, request: Request):
    rate_limit(request)
    gid, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
    db.execute("INSERT INTO guests(id, token_hash, name) VALUES (?, ?, ?)", (gid, hash_token(token), profile.name))
    return {"id": gid, "token": token}


@app.put("/me")
async def update_me(profile: Profile, authorization: Optional[str] = Header(None)):
    guest = current_guest(authorization)
    db.execute("UPDATE guests SET name = ? WHERE id = ?", (profile.name, guest["id"]))
    for team in teams.values():
        m = member(team, guest["id"])
        if m:
            m["name"] = profile.name
            await push(team)
    return {"ok": True}


@app.delete("/me")
async def delete_me(authorization: Optional[str] = Header(None)):
    guest = current_guest(authorization)
    for team in teams.values():
        if member(team, guest["id"]):
            remove_member(team, guest["id"])
            await push(team)
    db.execute("DELETE FROM guests WHERE id = ?", (guest["id"],))
    return {"ok": True}


@app.post("/teams")
async def create_team(request: Request, authorization: Optional[str] = Header(None)):
    rate_limit(request)
    guest = current_guest(authorization)
    try:
        code = new_code()
    except IllegalAction as e:
        raise HTTPException(503, str(e))
    team = {
        "id": str(uuid.uuid4()), "code": code, "host": guest["id"],
        "settings": dict(DEFAULT_SETTINGS), "members": [], "banned": [],
        "running": False, "paused": False, "hand": None,
        "deadline": 0, "nextHandAt": 0, "buttonSeat": -1, "lastActive": time.time(),
    }
    add_member(team, guest)
    teams[team["id"]] = team
    save(team)
    return {"teamId": team["id"], "code": team["code"]}


@app.post("/teams/join")
async def join_team(body: Join, request: Request, authorization: Optional[str] = Header(None)):
    rate_limit(request)
    guest = current_guest(authorization)
    row = db.execute("SELECT id FROM teams WHERE code = ?", (body.code,)).fetchone()
    team = teams.get(row["id"]) if row else None
    if not team:
        raise HTTPException(404, "No team with that code")
    if guest["id"] in team["banned"]:
        raise HTTPException(403, "The host removed you from this team")
    existing = member(team, guest["id"])
    if existing:
        existing["gone"] = False
    else:
        if len(team["members"]) >= MAX_SEATS:
            raise HTTPException(409, "This table is full")
        add_member(team, guest)
    await push(team)
    return {"teamId": team["id"], "code": team["code"]}


# --- live table --------------------------------------------------------------

@app.websocket("/ws/{team_id}")
async def table_socket(sock: WebSocket, team_id: str):
    """The first message must be {token}; the token stays out of URLs and access logs."""
    await sock.accept()
    try:
        hello = await asyncio.wait_for(sock.receive_json(), 10)
        guest = guest_for_token(hello.get("token"))
    except Exception:
        await sock.close(code=4001)
        return

    team = teams.get(team_id)
    if not guest or not team or not member(team, guest["id"]):
        await sock.close(code=4003)
        return

    gid = guest["id"]
    previous = conns[team_id].get(gid)
    if previous:
        await previous.close(code=4000)
    conns[team_id][gid] = sock
    member(team, gid)["offlineSince"] = None
    await push(team)

    try:
        while True:
            try:
                raw = await sock.receive_json()
                handle(team, gid, Msg(**raw))
            except (IllegalAction, ValidationError, TypeError, ValueError) as e:
                await sock.send_json({"t": "error", "msg": str(e)[:100]})
                continue
            await push(team)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        if conns[team_id].get(gid) in (sock, None):
            conns[team_id].pop(gid, None)
            m = member(team, gid)
            if m:
                m["offlineSince"] = time.time()
                await push(team)
