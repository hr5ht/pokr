"""Run: .venv/bin/python test_engine.py"""
import json
import os
import random

from engine import DECK, HAND_NAMES, Hand, IllegalAction, best5


FUZZ_HANDS = int(os.environ.get("FUZZ_HANDS", 100_000))


def expect_illegal(fn):
    try:
        fn()
    except IllegalAction:
        return
    raise AssertionError("expected IllegalAction")


def stacked(*top):
    """A deck that deals `top` first; cards are popped from the end."""
    rest = [c for c in DECK if c not in top]
    return rest + list(reversed(top))


def test_hand_ranking():
    cases = [
        ("Ah Kh Qh Jh Th 2c 3d", "Straight Flush"),
        ("Ad Ah As Ac 2d 3c 4h", "Four of a Kind"),
        ("Kd Kh Ks 2c 2d 3c 4h", "Full House"),
        ("2h 7h 9h Jh Kh Ac Ad", "Flush"),
        ("Ad 2c 3h 4s 5d 9c Kh", "Straight"),
        ("7d 7h 7s 2c 9d Jc Kh", "Three of a Kind"),
        ("7d 7h 9s 9c 2d Jc Kh", "Two Pair"),
        ("7d 7h 2s 4c 9d Jc Kh", "Pair"),
        ("2d 4h 6s 8c Td Qc Kh", "High Card"),
    ]
    for cards, name in cases:
        assert HAND_NAMES[best5(cards.split())[0][0]] == name, cards
    wheel = best5("Ad 2c 3h 4s 5d".split())[0]
    six_high = best5("2d 3c 4h 5s 6d".split())[0]
    assert six_high > wheel
    assert best5("Ah Kd 9c 9h 2s".split())[0] > best5("Qh Kd 9c 9s 2d".split())[0]  # kicker decides


def test_heads_up_blinds():
    h = Hand([("a", 100), ("b", 100)], 0, 5, 10, stacked())
    assert h.players[0]["bet"] == 5 and h.players[1]["bet"] == 10
    assert h.players[h.to_act]["id"] == "a"  # button acts first preflop
    h.act("a", "call")
    assert h.players[h.to_act]["id"] == "b"  # big blind keeps its option
    h.act("b", "check")
    assert h.street == "flop" and h.players[h.to_act]["id"] == "b"  # button acts last after that


def test_big_blind_option_and_turn_order():
    h = Hand([("a", 100), ("b", 100), ("c", 100)], 0, 5, 10, stacked())
    assert h.players[h.to_act]["id"] == "a"
    expect_illegal(lambda: h.act("b", "fold"))
    expect_illegal(lambda: h.act("a", "check"))
    h.act("a", "call")
    h.act("b", "call")
    assert h.street == "preflop" and h.players[h.to_act]["id"] == "c"
    assert h.legal()["call"] == 0 and h.legal()["raiseMin"] == 20
    h.act("c", "raise", 30)
    assert h.legal()["call"] == 20 and h.legal()["raiseMin"] == 50  # min raise = last raise size


def test_short_all_in_does_not_reopen_raising():
    h = Hand([("a", 100), ("b", 35), ("c", 100)], 0, 5, 10, stacked())
    h.act("a", "raise", 30)
    h.act("b", "raise", 35)  # all-in, 5 more: less than a full raise
    h.act("c", "fold")
    assert h.players[h.to_act]["id"] == "a"
    assert h.legal()["call"] == 5 and h.legal()["raiseMin"] is None


def test_uncalled_bet_returned_and_fold_win():
    h = Hand([("a", 100), ("b", 100)], 0, 5, 10, stacked())
    h.act("a", "raise", 60)
    h.act("b", "fold")
    assert h.result["winners"][0]["net"] == 10
    assert [p["stack"] for p in h.players] == [110, 90]
    assert h.result["shown"] == []


def test_side_pot():
    # c has the best hand but is all-in for 50, so a and b play for the side pot.
    deck = stacked("2c", "4c", "3d", "4d", "Ah", "As", "Ac", "Kd", "9h", "7s", "Td")
    h = Hand([("a", 200), ("b", 200), ("c", 50)], 0, 5, 10, deck)
    h.act("a", "raise", 100)
    h.act("b", "call")
    h.act("c", "call")  # all-in for 50 total
    assert h.street == "flop"
    while h.result is None:
        h.act(h.players[h.to_act]["id"], "check")
    stacks = {p["id"]: p["stack"] for p in h.players}
    assert stacks["c"] == 150  # wins the main pot 50*3, no more
    assert stacks["a"] + stacks["b"] == 300  # the 100 side pot went between a and b
    assert h.result["shown"] == ["a", "b", "c"]


def test_split_pot_odd_chip_goes_left_of_button():
    # The royal flush on the board plays for a and c; b's folded blind makes the pot odd.
    deck = stacked("2c", "3d", "2d", "3c", "4h", "5h", "Ts", "Js", "Qs", "Ks", "As")
    h = Hand([("a", 100), ("b", 100), ("c", 100)], 0, 5, 10, deck)
    h.act("a", "call")
    h.act("b", "fold")
    h.act("c", "check")
    while h.result is None:
        h.act(h.players[h.to_act]["id"], "check")
    assert {p["id"]: p["stack"] for p in h.players} == {"a": 102, "b": 95, "c": 103}


def play_random_hand(rng, seats):
    n = len(seats)
    stacks = [(f"p{i}", s) for i, s in enumerate(seats)]
    deck = list(DECK)
    rng.shuffle(deck)
    start = sum(seats)
    h = Hand(stacks, rng.randrange(n), 5, 10, deck)
    steps = 0
    while h.result is None:
        steps += 1
        assert steps < 500, "hand did not terminate"
        legal = h.legal()
        p = h.players[h.to_act]
        options = ["fold"] + (["call"] if legal["call"] else ["check"])
        if legal["raiseMin"] is not None:
            options += ["raise", "raise"]
        action = rng.choice(options)
        amount = None
        if action == "raise":
            amount = rng.choice([legal["raiseMin"], legal["raiseMax"], rng.randint(legal["raiseMin"], legal["raiseMax"])])
        h.act(p["id"], action, amount)
        if rng.random() < 0.05:  # snapshots must survive a restart at any point
            h = Hand.from_json(json.loads(json.dumps(vars(h))))
        total = sum(q["stack"] for q in h.players) + (0 if h.result else h.pot)
        assert total == start, (total, start)
        assert all(q["stack"] >= 0 for q in h.players)
    assert sum(q["stack"] for q in h.players) == start
    assert h.result["winners"]
    return h


def test_fuzz():
    rng = random.Random(1)
    for _ in range(FUZZ_HANDS):
        n = rng.randint(2, 12)
        play_random_hand(rng, [rng.choice([1, 3, 7, 20, 50, 200, 1000]) for _ in range(n)])


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_"):
            fn()
            print("ok", name)
