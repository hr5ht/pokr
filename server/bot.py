"""Fill a team with bots so one person can try the app.

Run from server/:  .venv/bin/python bot.py 4821 3
Ctrl-C stops them.
"""
import asyncio
import json
import random
import sys

import httpx
import websockets

API = "127.0.0.1:8000"
BOTS = ["Bot Bella", "Bot Otto", "Bot Mia", "Bot Rex", "Bot Kai"]
THINK_SECS = 1.5


def choose(legal: dict) -> tuple:
    roll = random.random()
    if legal["raiseMin"] is not None and roll < 0.2:
        return "raise", min(legal["raiseMin"] * random.choice((1, 1, 2)), legal["raiseMax"])
    if legal["call"] and roll > 0.85:
        return "fold", None
    return ("call" if legal["call"] else "check"), None


async def actor(ws, state: dict) -> None:
    """Acts on the newest view only; reading and thinking are separate so views never queue up."""
    while True:
        await asyncio.sleep(THINK_SECS)
        view = state.pop("view", None)
        if not view or view["paused"]:
            continue
        hand = view["hand"]
        me = next(s for s in view["seats"] if s["id"] == view["you"])
        live = hand and not hand["result"]
        if hand and hand["legal"]:
            action, amount = choose(hand["legal"])
            await ws.send(json.dumps({"t": "act", "seq": hand["seq"], "action": action, "amount": amount}))
        elif me["stack"] == 0 and not (live and me["inHand"]):
            await ws.send(json.dumps({"t": "rebuy"}))


async def play(code: str, name: str) -> None:
    async with httpx.AsyncClient(base_url=f"http://{API}") as http:
        guest = (await http.post("/guests", json={"name": name})).json()
        res = await http.post("/teams/join", json={"code": code}, headers={"Authorization": f"Bearer {guest['token']}"})
        if res.status_code != 200:
            sys.exit(f"{name} could not join: {res.json().get('detail')}")
        team = res.json()

    async with websockets.connect(f"ws://{API}/ws/{team['teamId']}") as ws:
        await ws.send(json.dumps({"token": guest["token"]}))
        print(f"{name} joined {team['code']}")
        state: dict = {}
        thinking = asyncio.create_task(actor(ws, state))
        try:
            async for raw in ws:
                msg = json.loads(raw)
                if msg["t"] == "view":
                    state["view"] = msg["view"]
        except websockets.ConnectionClosed:
            pass
        finally:
            thinking.cancel()
            print(f"{name} left")


async def main() -> None:
    if len(sys.argv) < 2:
        sys.exit("usage: bot.py TEAMCODE [how many bots, 1-5]")
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 2
    await asyncio.gather(*(play(sys.argv[1], bot) for bot in BOTS[:count]))


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
