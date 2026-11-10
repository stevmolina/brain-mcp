"""Seed or remove the invented demo chats in the sessions database.

    doppler run -p sessions -c prd -- uv run --with 'psycopg[binary]' python seed.py add <owner WorkOS id>
    doppler run -p sessions -c prd -- uv run --with 'psycopg[binary]' python seed.py remove <owner WorkOS id>

Every row it writes has an id starting with `demo-` and the given owner, and
`remove` deletes only rows (and their shares) matching both.
"""

import json
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path

import psycopg
from psycopg.types.json import Jsonb

FOLLOW_UPS = [
    ("user", "Looks good. Anything else to check?"),
    ("assistant", "One small thing: the tests for this part now run on every change, so a regression shows up right away."),
    ("user", "Add a short note to the project page."),
    ("assistant", "Added a two-line note with what changed and why."),
]


def turns_of(chat):
    turns = [{"role": r, "text": t} for r, t in chat["turns"]]
    i = 0
    while len(turns) < chat.get("pad", 0):
        role, text = FOLLOW_UPS[i % len(FOLLOW_UPS)]
        turns.append({"role": role, "text": text})
        i += 1
    return turns


def add(conn, owner):
    chats = json.loads((Path(__file__).parent / "chats.json").read_text())["chats"]
    for chat in chats:
        assert chat["id"].startswith("demo-")
        turns = turns_of(chat)
        started = datetime.fromisoformat(chat["started_at"].replace("Z", "+00:00"))
        body = "\n\n".join(f"{t['role']}: {t['text']}" for t in turns)
        conn.execute(
            """insert into sessions (source, id, machine, provider, cwd, title, clean_fingerprint,
                                     started_at, updated_at, body, turns, owner, brain)
               values (%s, %s, 'demo', %s, %s, %s, 'demo', %s, %s, %s, %s, %s, %s)
               on conflict (source, id) do update set
                 provider = excluded.provider, cwd = excluded.cwd, title = excluded.title,
                 started_at = excluded.started_at, updated_at = excluded.updated_at,
                 body = excluded.body, turns = excluded.turns, owner = excluded.owner, brain = excluded.brain""",
            (chat["source"], chat["id"], chat["provider"], chat["cwd"], chat["title"], started,
             started + timedelta(minutes=chat["minutes"]), body, Jsonb(turns), owner, chat["brain"]),
        )
    print(f"seeded {len(chats)} demo chats for {owner}")


def remove(conn, owner):
    shares = conn.execute(
        "delete from brain_mcp.session_shares where owner = %s and session_id like 'demo-%%'", (owner,)
    ).rowcount
    rows = conn.execute("delete from sessions where owner = %s and id like 'demo-%%'", (owner,)).rowcount
    print(f"removed {rows} demo chats and {shares} shares for {owner}")


if __name__ == "__main__":
    action, owner = sys.argv[1], sys.argv[2]
    with psycopg.connect(os.environ["DATABASE_URL"]) as conn:
        {"add": add, "remove": remove}[action](conn, owner)
