"""Game API. Guest profiles and team codes are plain HTTPS; the table runs over a
WebSocket at /ws/{team_id}.

Vercel may run several instances and closes every socket after five minutes, so
nothing that matters lives in memory. The table is in Postgres, NOTIFY tells every
instance when it changes, and each instance sends the new view to its own sockets.

Local run: DATABASE_URL=... .venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import os
import secrets
import threading
import time
import uuid
from typing import Callable, Optional

import psycopg
from fastapi import FastAPI, Header, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles
from psycopg.rows import dict_row
from pydantic import BaseModel, constr

from engine import DECK, Hand, IllegalAction

CODE_LENGTH = 4
MAX_SEATS = 12
SETTING_CHOICES = {"bb": (2, 10, 20, 50, 100), "stack": (500, 1000, 2000, 5000), "timer": (15, 30, 60)}
DEFAULT_SETTINGS = {"bb": 10, "stack": 1000, "timer": 30}
FOLD_PAUSE_SECS = 3  # time to read the result before the next hand
SHOWDOWN_PAUSE_SECS = 7
TIMEOUTS_BEFORE_SIT_OUT = 2
OFFLINE_AFTER_SECS = 13  # phones ping every 5 seconds
SILENT_SOCKET_SECS = 15  # a socket with no ping for this long is dead, whatever TCP thinks
HELLO_TIMEOUT_SECS = 10
SEND_TIMEOUT_SECS = 3
CLOCK_SECS = 0.25  # how often an instance looks for an expired turn timer
RETRY_TIMER_SECS = 3  # a timer that moved nothing, like a deal with too few players
MESSAGES_PER_MINUTE = 120
FROZEN_TRANSACTION_MS = 3000  # Vercel can freeze an instance halfway through a transaction
LOCK_WAIT_MS = 5000  # longer than the above, so a waiter outlasts a frozen lock holder
SEAT_HELD_SECS = 30 * 60
HOST_ABSENT_SECS = 10 * 60
TEAM_EXPIRES_SECS = 4 * 3600  # no phone open and no moves for this long
MAX_MOVES_PER_ADVANCE = 24  # auto-folds one call may catch up on

local = threading.local()  # a transaction belongs to one connection, so threads can't share one
tables_ready = False


def connection() -> psycopg.Connection:
    """One connection per thread. Neon's pooled URL needs prepared statements off."""
    global tables_ready
    db = getattr(local, "conn", None)
    if db is None or db.closed:
        db = local.conn = psycopg.connect(
            os.environ["DATABASE_URL"],
            autocommit=True,
            row_factory=dict_row,
            connect_timeout=10,
            prepare_threshold=None,
        )
    if not tables_ready:
        db.execute("CREATE TABLE IF NOT EXISTS guests(id TEXT PRIMARY KEY, token_hash TEXT UNIQUE, name TEXT)")
        db.execute(
            "CREATE TABLE IF NOT EXISTS teams"
            "(id TEXT PRIMARY KEY, code TEXT UNIQUE, data TEXT, updated_at DOUBLE PRECISION)"
        )
        db.execute(
            "CREATE TABLE IF NOT EXISTS hits(key TEXT, minute BIGINT, count INT, PRIMARY KEY (key, minute))"
        )
        tables_ready = True
    return db


def query(sql: str, args: tuple = ()):
    """Neon closes idle connections, so a dropped one gets a single retry."""
    try:
        return connection().execute(sql, args)
    except psycopg.OperationalError:
        local.conn = None
        return connection().execute(sql, args)


def encode(team: dict) -> str:
    return json.dumps(team, default=vars)


def public(team: dict, now: float) -> dict:
    """The table without its heartbeat fields, which change constantly and show nothing new."""
    members = [
        {**{k: v for k, v in m.items() if k not in ("seen", "socket")}, "online": is_online(m, now)}
        for m in team["members"]
    ]
    return {**json.loads(encode(team)), "members": members}


def with_team(team_id: str, change: Callable[[dict], dict]) -> dict:
    """Runs `change` holding the team's row lock, so two instances can't overwrite
    each other. Phones are told only when something they can see has changed."""
    for attempt in (1, 2):
        try:
            db = connection()
            with db.transaction():
                # A frozen instance would hold this row's lock for good and hang the table.
                db.execute(
                    "SELECT set_config('idle_in_transaction_session_timeout', %s, true),"
                    " set_config('lock_timeout', %s, true)",
                    (str(FROZEN_TRANSACTION_MS), str(LOCK_WAIT_MS)),
                )
                row = db.execute(
                    "SELECT data FROM teams WHERE id = %s AND updated_at >= %s FOR UPDATE",
                    (team_id, time.time() - TEAM_EXPIRES_SECS),
                ).fetchone()
                if not row:
                    raise HTTPException(404, "That table no longer exists")
                team = json.loads(row["data"])
                if team["hand"]:
                    team["hand"] = Hand.from_json(team["hand"])
                result = change(team)
                now = time.time()
                if all(m["gone"] for m in team["members"]):  # everyone has left, so free the code now
                    db.execute("DELETE FROM teams WHERE id = %s", (team_id,))
                    db.execute("SELECT pg_notify('tables', %s)", (team_id,))
                elif encode(team) != row["data"]:
                    if public(team, now) != public(json.loads(row["data"]), now):
                        team["version"] += 1
                        result["version"] = team["version"]
                        db.execute("SELECT pg_notify('tables', %s)", (team_id,))
                    db.execute(
                        "UPDATE teams SET code = %s, data = %s, updated_at = %s WHERE id = %s",
                        (team["code"], encode(team), time.time(), team_id),
                    )
                return result
        except (psycopg.OperationalError, psycopg.errors.IdleInTransactionSessionTimeout):
            local.conn = None
            if attempt == 2:
                raise


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# --- table -------------------------------------------------------------------

def member(team: dict, gid: str) -> Optional[dict]:
    return next((m for m in team["members"] if m["id"] == gid), None)


def is_online(m: dict, now: float) -> bool:
    return bool(m.get("socket")) and now - m["seen"] < OFFLINE_AFTER_SECS


def new_code() -> str:
    # Only 10,000 codes, so give up rather than spin; raise CODE_LENGTH if this ever fires.
    for _ in range(200):
        code = "".join(secrets.choice("0123456789") for _ in range(CODE_LENGTH))
        if not query("SELECT 1 FROM teams WHERE code = %s", (code,)).fetchone():
            return code
    raise IllegalAction("no free team codes right now")


def add_member(team: dict, guest: dict) -> None:
    taken = {m["seat"] for m in team["members"]}
    team["members"].append({
        "id": guest["id"], "name": guest["name"],
        "seat": min(set(range(MAX_SEATS)) - taken),
        "stack": team["settings"]["stack"],
        "sittingOut": False, "timeouts": 0, "gone": False, "seen": time.time(), "socket": None,
    })


def live_hand(team: dict) -> Optional[Hand]:
    h = team["hand"]
    return h if h and not h.result else None


def remove_member(team: dict, gid: str) -> None:
    """A player in a live hand keeps their seat until it ends; advance() folds them on their turn."""
    m = member(team, gid)
    if not m:
        return
    h = live_hand(team)
    if h and any(p["id"] == gid for p in h.players):
        m["gone"] = m["sittingOut"] = True
    else:
        team["members"].remove(m)


def deal(team: dict, now: float) -> bool:
    ready = sorted(
        (m for m in team["members"] if m["stack"] > 0 and not m["sittingOut"] and is_online(m, now)),
        key=lambda m: m["seat"],
    )
    if len(ready) < 2:
        return False
    button_seat = next((m["seat"] for m in ready if m["seat"] > team["buttonSeat"]), ready[0]["seat"])
    button = next(i for i, m in enumerate(ready) if m["seat"] == button_seat)
    n = len(ready)
    if n == 2 and ready[(button + 1) % 2]["id"] == team.get("bigBlind"):
        button = (button + 1) % 2  # going heads-up: nobody posts the big blind twice running
        button_seat = ready[button]["seat"]
    bb = team["settings"]["bb"]
    deck = list(DECK)
    secrets.SystemRandom().shuffle(deck)
    team["buttonSeat"] = button_seat
    team["bigBlind"] = ready[(button + (1 if n == 2 else 2)) % n]["id"]
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


def ensure_host(team: dict, now: float) -> None:
    """With no accounts a host can vanish for good, so someone present takes over."""
    host = member(team, team["host"])
    if not host or now - host["seen"] > HOST_ABSENT_SECS:
        heir = next((m for m in sorted(team["members"], key=lambda m: m["seat"]) if is_online(m, now)), None)
        if heir:
            team["host"] = heir["id"]


def advance(team: dict, now: float) -> None:
    """Everything that happens because time passed. Runs on every message and when a
    timer is due, so time only moves while a phone is connected."""
    ensure_host(team, now)
    for m in list(team["members"]):
        if now - m["seen"] > SEAT_HELD_SECS:
            remove_member(team, m["id"])

    for _ in range(MAX_MOVES_PER_ADVANCE):
        if team["paused"]:
            return
        h = live_hand(team)
        if h:
            p = h.players[h.to_act]
            m = member(team, p["id"])
            away = not m or m["sittingOut"] or m["gone"]
            if not away and now < team["deadline"]:
                return
            if not away:
                m["timeouts"] += 1
                m["sittingOut"] = m["timeouts"] >= TIMEOUTS_BEFORE_SIT_OUT
            left = not m or m["gone"]  # someone who left the table can't play on and win
            h.act(p["id"], "fold" if left or h.legal()["call"] else "check")
            after_action(team)
        elif team["running"] and now >= team["nextHandAt"]:
            if not deal(team, now):
                return
        else:
            return


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


def view_for(team: dict, gid: str, now: float) -> dict:
    """Everything a player may see. All outgoing state goes through here, so this
    is the one place that keeps the deck and other players' cards off the wire."""
    h = team["hand"]
    live = live_hand(team)
    in_hand = {p["id"]: p for p in h.players} if h else {}
    shown = set(h.result["shown"]) if h and h.result else set()

    seats = []
    for m in sorted(team["members"], key=lambda m: m["seat"]):
        p = in_hand.get(m["id"])
        seats.append({
            "id": m["id"], "name": m["name"],
            "online": is_online(m, now),
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
        hand = {
            "board": h.board,
            "pot": h.result["pot"] if h.result else h.pot,
            "seq": h.seq,
            "toAct": turn,
            "turnMs": int(max(team["deadline"] - now, 0) * 1000) if turn else 0,
            "current": h.current,
            "legal": h.legal() if turn == gid else None,
            "handName": h.current_name(gid) if gid in in_hand else None,
            "result": h.result,
        }

    return {
        "you": gid, "code": team["code"], "host": team["host"],
        "settings": team["settings"], "running": team["running"], "paused": team["paused"],
        "seats": seats, "hand": hand,
    }


# --- HTTPS -------------------------------------------------------------------

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


def rate_limit(request: Request, limit: int = 20) -> None:
    """Kept in Postgres because instances share no memory."""
    ip = request.headers.get("x-forwarded-for", "").split(",")[0].strip() or request.client.host
    count = query(
        "INSERT INTO hits VALUES (%s, %s, 1) "
        "ON CONFLICT (key, minute) DO UPDATE SET count = hits.count + 1 RETURNING count",
        (f"{ip}:{request.url.path}", int(time.time() // 60)),
    ).fetchone()["count"]
    if count > limit:
        raise HTTPException(429, "Too many attempts. Try again in a minute.")


def current_guest(authorization: Optional[str]) -> dict:
    token = (authorization or "").replace("Bearer ", "", 1)
    guest = query("SELECT * FROM guests WHERE token_hash = %s", (hash_token(token),)).fetchone() if token else None
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


def seated(team: dict, gid: str) -> dict:
    m = member(team, gid)
    if not m or m["gone"]:
        raise HTTPException(403, "You're not at this table")
    return m


@app.get("/health")
def health():
    return {"ok": True}


@app.post("/guests")
def create_guest(profile: Profile, request: Request):
    rate_limit(request)
    gid, token = str(uuid.uuid4()), secrets.token_urlsafe(32)
    query("INSERT INTO guests VALUES (%s, %s, %s)", (gid, hash_token(token), profile.name))
    return {"id": gid, "token": token}


@app.put("/me")
def update_me(profile: Profile, authorization: Optional[str] = Header(None)):
    guest = current_guest(authorization)
    query("UPDATE guests SET name = %s WHERE id = %s", (profile.name, guest["id"]))
    return {"ok": True}  # a table picks up the new name when the player next connects


@app.delete("/me")
def delete_me(authorization: Optional[str] = Header(None)):
    guest = current_guest(authorization)
    query("DELETE FROM guests WHERE id = %s", (guest["id"],))
    return {"ok": True}  # with no more pings, their seat is released after SEAT_HELD_SECS


def sweep() -> None:
    """Nothing runs in the background, so the requests that need a free code clean up."""
    query("DELETE FROM teams WHERE updated_at < %s", (time.time() - TEAM_EXPIRES_SECS,))
    query("DELETE FROM hits WHERE minute < %s", (int(time.time() // 60) - 10,))


@app.post("/teams")
def create_team(request: Request, authorization: Optional[str] = Header(None)):
    rate_limit(request)
    guest = current_guest(authorization)
    sweep()
    try:
        code = new_code()
    except IllegalAction as e:
        raise HTTPException(503, str(e))
    team = {
        "id": str(uuid.uuid4()), "code": code, "host": guest["id"], "version": 1,
        "settings": dict(DEFAULT_SETTINGS), "members": [], "banned": [],
        "running": False, "paused": False, "hand": None,
        "deadline": 0, "nextHandAt": 0, "buttonSeat": -1,
    }
    add_member(team, guest)
    query("INSERT INTO teams VALUES (%s, %s, %s, %s)", (team["id"], code, encode(team), time.time()))
    return {"teamId": team["id"], "code": code}


@app.post("/teams/join")
def join_team(body: Join, request: Request, authorization: Optional[str] = Header(None)):
    rate_limit(request)
    guest = current_guest(authorization)
    sweep()
    row = query("SELECT id FROM teams WHERE code = %s", (body.code,)).fetchone()
    if not row:
        raise HTTPException(404, "No team with that code")

    def change(team: dict) -> dict:
        if guest["id"] in team["banned"]:
            raise HTTPException(403, "The host removed you from this team")
        existing = member(team, guest["id"])
        if existing:
            existing.update(gone=False, seen=time.time())
        else:
            if len(team["members"]) >= MAX_SEATS:
                raise HTTPException(409, "This table is full")
            add_member(team, guest)
        return {"teamId": team["id"], "code": team["code"]}

    return with_team(row["id"], change)


# --- WebSocket ---------------------------------------------------------------

rooms: dict[str, dict[str, tuple[WebSocket, str]]] = {}  # team id -> socket id -> (socket, guest id)
timers: dict[str, float] = {}  # team id -> when its turn timer or next deal is due
running: set[asyncio.Task] = set()
background: list[asyncio.Task] = []


def spawn(work) -> None:
    task = asyncio.create_task(work)
    running.add(task)  # asyncio only keeps a weak reference to a running task
    task.add_done_callback(running.discard)


def table_response(team: dict, gid: str, now: float, error: str = "") -> dict:
    return {"view": view_for(team, gid, now), "version": team["version"], "error": error}


def read_team(team_id: str) -> Optional[dict]:
    row = query("SELECT data FROM teams WHERE id = %s", (team_id,)).fetchone()
    if not row:
        return None
    team = json.loads(row["data"])
    if team["hand"]:
        team["hand"] = Hand.from_json(team["hand"])
    return team


def next_timer(team: dict) -> Optional[float]:
    if team["paused"]:
        return None
    if live_hand(team):
        return team["deadline"]
    return team["nextHandAt"] if team["running"] else None


def arrive(team: dict, guest: dict, sid: str) -> dict:
    now = time.time()
    seated(team, guest["id"]).update(name=guest["name"], seen=now, socket=sid)
    advance(team, now)
    seated(team, guest["id"])
    return {}


def heartbeat(team: dict, gid: str) -> dict:
    now = time.time()
    seated(team, gid)["seen"] = now
    advance(team, now)
    seated(team, gid)
    return table_response(team, gid, now)


def move(team: dict, gid: str, msg: Msg) -> dict:
    now = time.time()
    seated(team, gid)["seen"] = now
    advance(team, now)
    error = ""
    try:
        seated(team, gid)
        handle(team, gid, msg)
        advance(team, now)
    except IllegalAction as e:
        error = str(e)[:100]
    m = member(team, gid)
    if not m or m["gone"]:
        return {"left": True}
    return table_response(team, gid, now, error)


def depart(team: dict, gid: str, sid: str) -> dict:
    """A phone swapping to a fresh socket has already moved on, so this does nothing then."""
    m = member(team, gid)
    if m and m.get("socket") == sid:
        m["socket"] = None
    return {}


def tick(team: dict) -> dict:
    advance(team, time.time())
    return {}


async def run_timer(team_id: str) -> None:
    try:
        await asyncio.to_thread(with_team, team_id, tick)
    except HTTPException:
        timers.pop(team_id, None)
    except psycopg.Error:
        pass  # the timer stays due, so the next look tries again


async def deliver(sock: WebSocket, data: dict) -> None:
    await asyncio.wait_for(sock.send_json(data), SEND_TIMEOUT_SECS)


async def hang_up(sock: WebSocket, code: int) -> None:
    try:
        await asyncio.wait_for(sock.close(code), SEND_TIMEOUT_SECS)
    except (RuntimeError, asyncio.TimeoutError):
        pass  # already closed


async def push(team_id: str) -> None:
    """Sends each phone on this instance its own view of the table."""
    team = await asyncio.to_thread(read_team, team_id)
    room = dict(rooms.get(team_id, {}))
    if team is None:
        timers.pop(team_id, None)
        await asyncio.gather(*(hang_up(sock, 4004) for sock, _ in room.values()))
        return
    now = time.time()
    at = next_timer(team)
    if at is None:
        timers.pop(team_id, None)
    else:
        timers[team_id] = at

    async def send_one(sock: WebSocket, gid: str) -> None:
        m = member(team, gid)
        try:
            if m and not m["gone"]:
                await deliver(sock, table_response(team, gid, now))
            else:
                await hang_up(sock, 4003)
        except (RuntimeError, asyncio.TimeoutError):
            await hang_up(sock, 1011)  # a stuck phone mustn't hold up the rest of the table

    await asyncio.gather(*(send_one(sock, gid) for sock, gid in room.values()))


async def listen() -> None:
    """One listener per instance. LISTEN needs a lasting session, which Neon's pooled
    URL can't hold, so this one connection goes direct. A notification missed during a
    reconnect only costs a few seconds, because each ping is answered with the table."""
    url = os.environ["DATABASE_URL"].replace("-pooler", "", 1)
    while True:
        try:
            async with await psycopg.AsyncConnection.connect(url, autocommit=True, connect_timeout=10) as db:
                await db.execute("LISTEN tables")
                async for note in db.notifies():
                    if note.payload in rooms:
                        spawn(push(note.payload))
        except psycopg.OperationalError:
            await asyncio.sleep(1)


async def clock() -> None:
    """Turn timers and the next deal have to fire even when no phone sends anything.
    Every instance at a table does this, and the row lock lets only one of them win."""
    while True:
        await asyncio.sleep(CLOCK_SECS)
        now = time.time()
        for team_id, at in list(timers.items()):
            if now >= at:
                timers[team_id] = now + RETRY_TIMER_SECS  # push replaces this if anything moved
                spawn(run_timer(team_id))


def open_socket(team_id: str, sid: str, sock: WebSocket, gid: str) -> None:
    rooms.setdefault(team_id, {})[sid] = (sock, gid)
    if not background:
        background.extend((asyncio.create_task(listen()), asyncio.create_task(clock())))


def close_socket(team_id: str, sid: str) -> None:
    room = rooms.get(team_id, {})
    room.pop(sid, None)
    if not room:
        rooms.pop(team_id, None)
        timers.pop(team_id, None)
    if not rooms:
        for task in background:
            task.cancel()
        background.clear()


CLOSE_CODES = {401: 4001, 403: 4003, 404: 4004}


@app.websocket("/ws/{team_id}")
async def table_socket(sock: WebSocket, team_id: str):
    """The token comes in the first message, because URLs end up in logs."""
    await sock.accept()
    sid = uuid.uuid4().hex
    gid = None
    try:
        hello = await asyncio.wait_for(sock.receive_json(), HELLO_TIMEOUT_SECS)
        guest = await asyncio.to_thread(current_guest, f"Bearer {hello['token']}")
        await asyncio.to_thread(with_team, team_id, lambda team: arrive(team, guest, sid))
        gid = guest["id"]
        open_socket(team_id, sid, sock, gid)
        await push(team_id)

        minute, count = 0, 0
        while True:
            data = await asyncio.wait_for(sock.receive_json(), SILENT_SOCKET_SECS)
            this_minute = int(time.time() // 60)
            minute, count = this_minute, count + 1 if this_minute == minute else 1
            if count > MESSAGES_PER_MINUTE:
                await hang_up(sock, 4029)
                return
            msg = Msg.model_validate(data)
            if msg.t == "ping":
                reply = await asyncio.to_thread(with_team, team_id, lambda team: heartbeat(team, gid))
            else:
                reply = await asyncio.to_thread(with_team, team_id, lambda team: move(team, gid, msg))
            if reply.get("left"):
                await hang_up(sock, 1000)
                return
            await deliver(sock, reply)
    except HTTPException as e:
        await hang_up(sock, CLOSE_CODES.get(e.status_code, 1011))
    except (ValueError, KeyError, TypeError):  # malformed message
        await hang_up(sock, 4400)
    except (WebSocketDisconnect, RuntimeError):
        pass  # the phone went away
    except asyncio.TimeoutError:
        await hang_up(sock, 4008)
    finally:
        close_socket(team_id, sid)
        if gid:
            try:
                await asyncio.to_thread(with_team, team_id, lambda team: depart(team, gid, sid))
            except (HTTPException, psycopg.Error):
                pass  # the table is gone, or the next ping sorts it out


# --- website -----------------------------------------------------------------

# Last, so it only gets the paths nothing above claimed.
app.mount("/", StaticFiles(directory=os.path.join(os.path.dirname(os.path.abspath(__file__)), "web"), html=True))
