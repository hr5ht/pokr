"""Texas Hold'em rules. Pure: no I/O or clock, and all state is JSON-serialisable."""
from __future__ import annotations

from collections import Counter
from itertools import combinations

RANKS = "23456789TJQKA"
DECK = [r + s for r in RANKS for s in "shdc"]
HAND_NAMES = [
    "High Card", "Pair", "Two Pair", "Three of a Kind", "Straight",
    "Flush", "Full House", "Four of a Kind", "Straight Flush",
]


class IllegalAction(ValueError):
    pass


def score5(cards: list[str]) -> tuple:
    """Comparable score for exactly five cards; higher wins."""
    ranks = sorted((RANKS.index(c[0]) for c in cards), reverse=True)
    counts = Counter(ranks)
    groups = sorted(counts, key=lambda r: (counts[r], r), reverse=True)
    shape = sorted(counts.values(), reverse=True)
    flush = len({c[1] for c in cards}) == 1

    straight = None
    if len(counts) == 5:
        if ranks[0] - ranks[4] == 4:
            straight = ranks[0]
        elif ranks == [12, 3, 2, 1, 0]:  # A-2-3-4-5, the ace plays low
            straight = 3

    if straight is not None:
        return (8 if flush else 4, straight)
    if flush:
        return (5, *groups)
    category = {(4, 1): 7, (3, 2): 6, (3, 1, 1): 3, (2, 2, 1): 2, (2, 1, 1, 1): 1}.get(tuple(shape), 0)
    return (category, *groups)


def best5(cards: list[str]) -> tuple[tuple, list[str]]:
    """Best five-card hand out of 5-7 cards, as (score, those five cards)."""
    five = max(combinations(cards, 5), key=score5)
    return score5(five), list(five)


class Hand:
    """One hand. `players` is in seat order; `button` indexes into it."""

    def __init__(self, stacks: list[tuple[str, int]], button: int, sb: int, bb: int, deck: list[str]):
        n = len(stacks)
        if n < 2:
            raise ValueError("need two players")
        self.players = [
            dict(id=pid, stack=stack, bet=0, total=0, cards=[], folded=False, allin=False, acted=False, last="")
            for pid, stack in stacks
        ]
        self.button, self.bb, self.deck = button, bb, list(deck)
        self.board: list[str] = []
        self.street = "preflop"
        self.seq = 0  # bumps on every action, so stale taps are rejected
        self.current = bb  # the bet to match this street
        self.min_raise = bb
        self.to_act = None
        self.result = None

        for p in self.players:
            p["cards"] = [self.deck.pop(), self.deck.pop()]

        sb_i = button if n == 2 else (button + 1) % n  # heads-up: the button is the small blind
        bb_i = (sb_i + 1) % n
        self._pay(self.players[sb_i], sb)
        self._pay(self.players[bb_i], bb)
        self.players[sb_i]["last"] = f"Blind {self.players[sb_i]['bet']}"
        self.players[bb_i]["last"] = f"Blind {self.players[bb_i]['bet']}"

        self.to_act = self._next(bb_i)
        if self.to_act is None:
            self._end_street()

    @classmethod
    def from_json(cls, data: dict) -> "Hand":
        hand = cls.__new__(cls)
        hand.__dict__.update(data)
        return hand

    @property
    def pot(self) -> int:
        return sum(p["total"] for p in self.players)

    def legal(self) -> dict | None:
        """What the player to act may do. Raise amounts are the total bet this street."""
        if self.to_act is None:
            return None
        p = self.players[self.to_act]
        all_in_to = p["bet"] + p["stack"]
        others_can_respond = any(self._can_act(o) for o in self.players if o is not p)
        # `acted` stays True after a short all-in, so that doesn't reopen raising.
        can_raise = all_in_to > self.current and not p["acted"] and others_can_respond
        return {
            "call": min(self.current - p["bet"], p["stack"]),
            "raiseMin": min(self.current + self.min_raise, all_in_to) if can_raise else None,
            "raiseMax": all_in_to if can_raise else None,
        }

    def act(self, pid: str, action: str, amount: int | None = None) -> None:
        if self.to_act is None or self.players[self.to_act]["id"] != pid:
            raise IllegalAction("not your turn")
        i, p, legal = self.to_act, self.players[self.to_act], self.legal()

        if action == "fold":
            p["folded"], p["last"] = True, "Fold"
        elif action == "check":
            if legal["call"]:
                raise IllegalAction("can't check")
            p["last"] = "Check"
        elif action == "call":
            if not legal["call"]:
                raise IllegalAction("nothing to call")
            self._pay(p, legal["call"])
            p["last"] = f"Call {legal['call']}"
        elif action == "raise":
            low, high = legal["raiseMin"], legal["raiseMax"]
            if low is None or type(amount) is not int or not low <= amount <= high:
                raise IllegalAction("bad raise")
            raised_by = amount - self.current
            word = "Raise" if self.current else "Bet"
            self._pay(p, amount - p["bet"])
            self.current = amount
            # short all-ins that add up to a full raise don't reopen betting.
            if raised_by >= self.min_raise:
                self.min_raise = raised_by
                for other in self.players:
                    other["acted"] = False
            p["last"] = f"{word} {amount}"
        else:
            raise IllegalAction("unknown action")

        p["acted"] = True
        self.seq += 1

        if sum(not o["folded"] for o in self.players) == 1:
            self._finish_by_fold()
            return
        self.to_act = self._next(i)
        if self.to_act is None:
            self._end_street()

    def current_name(self, pid: str) -> str | None:
        """Name of a player's best hand so far, from the flop onwards."""
        p = next(o for o in self.players if o["id"] == pid)
        if len(self.board) < 3 or p["folded"]:
            return None
        return HAND_NAMES[best5(p["cards"] + self.board)[0][0]]

    def _can_act(self, p: dict) -> bool:
        return not p["folded"] and not p["allin"]

    def _pay(self, p: dict, amount: int) -> None:
        amount = min(amount, p["stack"])
        p["stack"] -= amount
        p["bet"] += amount
        p["total"] += amount
        p["allin"] = p["stack"] == 0

    def _next(self, i: int) -> int | None:
        """Next seat after i that still has a decision, or None if the street is over."""
        n = len(self.players)
        actors = [p for p in self.players if self._can_act(p)]
        if len(actors) == 1 and actors[0]["bet"] >= self.current:
            return None  # the last player able to act has nobody to bet against
        for k in range(1, n + 1):
            j = (i + k) % n
            p = self.players[j]
            if self._can_act(p) and (not p["acted"] or p["bet"] < self.current):
                return j
        return None

    def _end_street(self) -> None:
        for p in self.players:
            p["bet"] = 0
            if self._can_act(p):
                p["acted"], p["last"] = False, ""
        self.current, self.min_raise, self.to_act = 0, self.bb, None

        if sum(self._can_act(p) for p in self.players) <= 1:  # all-in: run out the board
            self.board += [self.deck.pop() for _ in range(5 - len(self.board))]
            self.street = "river"
        elif self.street != "river":
            self.street = {"preflop": "flop", "flop": "turn", "turn": "river"}[self.street]
            self.board += [self.deck.pop() for _ in range(3 if self.street == "flop" else 1)]
            self.to_act = self._next(self.button)
            return
        self._showdown()

    def _refund_uncalled(self) -> None:
        top = max(self.players, key=lambda p: p["total"])
        second = max(p["total"] for p in self.players if p is not top)
        top["stack"] += top["total"] - second
        top["total"] = second

    def _finish_by_fold(self) -> None:
        self._refund_uncalled()
        winner = next(p for p in self.players if not p["folded"])
        self._settle({winner["id"]: self.pot}, shown=[], names={}, fives={})

    def _pots(self) -> list[tuple[int, list[dict]]]:
        """Main pot then side pots, as (amount, players who can win it)."""
        live = [p for p in self.players if not p["folded"]]
        pots, floor = [], 0
        for level in sorted({p["total"] for p in live}):
            amount = sum(min(p["total"], level) - min(p["total"], floor) for p in self.players)
            pots.append((amount, [p for p in live if p["total"] >= level]))
            floor = level
        return pots

    def _showdown(self) -> None:
        self._refund_uncalled()
        live = [p for p in self.players if not p["folded"]]
        scored = {p["id"]: best5(p["cards"] + self.board) for p in live}
        seats_from_button = [
            self.players[(self.button + 1 + k) % len(self.players)] for k in range(len(self.players))
        ]

        wins: Counter = Counter()
        for amount, contenders in self._pots():
            top = max(scored[p["id"]][0] for p in contenders)
            winners = [
                p for p in seats_from_button
                if p in contenders and scored[p["id"]][0] == top
            ]
            share, odd = divmod(amount, len(winners))
            for k, p in enumerate(winners):
                wins[p["id"]] += share + (1 if k < odd else 0)  # odd chips go left of the button

        self._settle(
            wins,
            shown=[p["id"] for p in live],
            names={pid: HAND_NAMES[s[0][0]] for pid, s in scored.items()},
            fives={pid: s[1] for pid, s in scored.items()},
        )

    def _settle(self, wins: dict, shown: list[str], names: dict, fives: dict) -> None:
        winners = []
        for p in self.players:
            won = wins.get(p["id"], 0)
            p["stack"] += won
            if won:
                winners.append({
                    "id": p["id"],
                    "won": won,
                    "net": won - p["total"],
                    "name": names.get(p["id"]),
                    "cards": fives.get(p["id"], []),
                })
        self.to_act = None
        self.result = {"winners": winners, "shown": shown, "names": names, "pot": sum(wins.values())}
