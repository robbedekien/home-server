# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp==2.3.0"]
# ///
"""Local stdio MCP for Splitwise, used next to the `actual` MCP to reconcile shared costs.

Auth: the splitwise.com web session (the API key needs Pro). Log in at secure.splitwise.com and
store the `_splitwise_session=...` cookie (valid ~1 year, dies on logout) in
~/.config/splitwise-mcp/cookie, mode 0600. Writes also need the page's CSRF token.
Register with:
    claude mcp add --scope user splitwise -- uv run --script <abs path>/server.py
Self-check (no network): uv run --script server.py --check

No update/delete tools on purpose: fix mistakes in the Splitwise app.
"""
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from decimal import ROUND_HALF_UP, Decimal
from functools import cache
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

SITE = "https://secure.splitwise.com/"
API = SITE + "api/v3.0/"
COOKIE_FILE = Path.home() / ".config/splitwise-mcp/cookie"


@cache
def cookie() -> str:
    if not COOKIE_FILE.exists():
        raise RuntimeError(f"{COOKIE_FILE} missing: paste the _splitwise_session cookie there")
    return COOKIE_FILE.read_text().strip()


def fetch(url: str, body: dict | None = None, csrf: str | None = None):
    headers = {"Cookie": cookie(), "User-Agent": "Mozilla/5.0", "Content-Type": "application/json"}
    if csrf:
        headers["X-CSRF-Token"] = csrf
    data = json.dumps(body).encode() if body is not None else None
    try:
        return urllib.request.urlopen(urllib.request.Request(url, data, headers), timeout=30)
    except urllib.error.HTTPError as error:
        hint = " (session expired? refresh the cookie file)" if error.code in (401, 403) else ""
        raise RuntimeError(f"Splitwise {url.removeprefix(API)}: HTTP {error.code}{hint}") from None


def call(path: str, params: dict | None = None, body: dict | None = None) -> dict:
    csrf = None
    if body is not None:
        page = fetch(SITE).read().decode()
        match = re.search(r'<meta name="csrf-token" content="([^"]+)"', page)
        if not match:
            raise RuntimeError("Splitwise CSRF token not found (session expired?)")
        csrf = match.group(1)
    url = API + path + ("?" + urllib.parse.urlencode(params) if params else "")
    with fetch(url, body, csrf) as response:
        data = json.load(response)
    # Splitwise answers 200 with a non-empty `errors` on failed writes.
    if data.get("errors"):
        raise RuntimeError(f"Splitwise {path}: {data['errors']}")
    return data


def name(user: dict) -> str:
    return " ".join(filter(None, [user.get("first_name"), user.get("last_name")]))


def split(cost: str, my_share: str | None) -> tuple[Decimal, Decimal, Decimal]:
    """Return (total, mine, theirs), rounded to cents; default is an even split, odd cent to me."""
    total = Decimal(cost).quantize(Decimal("0.01"), ROUND_HALF_UP)
    if total <= 0:
        raise ValueError("cost must be positive")
    mine = (Decimal(my_share) if my_share is not None else total / 2).quantize(Decimal("0.01"), ROUND_HALF_UP)
    if not 0 <= mine <= total:
        raise ValueError("my_share must be between 0 and cost")
    return total, mine, total - mine


if sys.argv[1:] == ["--check"]:
    assert split("10", None) == (Decimal("10.00"), Decimal("5.00"), Decimal("5.00"))
    assert split("10.01", None) == (Decimal("10.01"), Decimal("5.01"), Decimal("5.00"))
    assert split("42.5", "0") == (Decimal("42.50"), Decimal("0.00"), Decimal("42.50"))
    for bad in (("0", None), ("10", "11"), ("10", "-1")):
        try:
            split(*bad)
        except ValueError:
            continue
        raise AssertionError(bad)
    print("ok")
    sys.exit()

server = MCPServer(
    "splitwise",
    instructions=(
        "Splitwise for Robbe's shared costs with his girlfriend. Reconcile against the `actual` MCP "
        "(bank data): match on amount and date (a few days' slack), not description. Always show the "
        "user a proposal and get confirmation before calling splitwise_create_expense."
    ),
)
READ = ToolAnnotations(readOnlyHint=True)


@server.tool(annotations=READ)
def splitwise_overview() -> dict:
    """Current user, friends with open balances, and groups (ids needed by the other tools)."""
    me = call("get_current_user")["user"]
    friends = call("get_friends")["friends"]
    groups = call("get_groups")["groups"]
    return {
        "me": {"id": me["id"], "name": name(me), "default_currency": me.get("default_currency")},
        "friends": [
            {"id": f["id"], "name": name(f), "balance": f.get("balance", [])} for f in friends
        ],
        "groups": [
            {"id": g["id"], "name": g["name"], "members": [name(m) for m in g.get("members", [])]}
            for g in groups
        ],
    }


@server.tool(annotations=READ)
def splitwise_expenses(
    dated_after: str, dated_before: str, friend_id: int | None = None, group_id: int | None = None
) -> list[dict]:
    """Non-deleted expenses and payments in a date range (YYYY-MM-DD), optionally per friend or group.

    `my_net` > 0 means the other person owes me that much for the line; < 0 means I owe.
    """
    params = {"dated_after": dated_after, "dated_before": dated_before, "limit": 100}
    if group_id is not None:
        params["group_id"] = group_id
    elif friend_id is not None:
        params["friend_id"] = friend_id
    me = call("get_current_user")["user"]["id"]
    rows, offset = [], 0
    while True:
        page = call("get_expenses", params | {"offset": offset})["expenses"]
        for e in page:
            if e.get("deleted_at"):
                continue
            mine = next((u for u in e["users"] if u["user_id"] == me), None)
            rows.append({
                "id": e["id"],
                "date": e["date"][:10],
                "description": e["description"],
                "cost": e["cost"],
                "currency": e["currency_code"],
                "payment": e["payment"],
                "group_id": e.get("group_id"),
                "category": (e.get("category") or {}).get("name"),
                "paid_by": [name(u["user"]) for u in e["users"] if Decimal(u["paid_share"]) > 0],
                "my_net": mine["net_balance"] if mine else "0",
                "details": e.get("details"),
            })
        if len(page) < params["limit"]:
            return rows
        offset += params["limit"]


@server.tool()
def splitwise_create_expense(
    description: str,
    cost: str,
    date: str,
    friend_id: int,
    paid_by_me: bool = True,
    my_share: str | None = None,
    group_id: int = 0,
    currency_code: str = "EUR",
    details: str | None = None,
) -> dict:
    """Add an expense between me and one friend. Only call after the user confirmed it.

    cost/my_share are decimal strings; my_share defaults to half. date is YYYY-MM-DD.
    group_id 0 = no group. details is a good place for the bank reference.
    """
    total, mine, theirs = split(cost, my_share)
    me = call("get_current_user")["user"]["id"]
    payer_me, payer_friend = (total, Decimal(0)) if paid_by_me else (Decimal(0), total)
    body = {
        "cost": str(total),
        "description": description,
        "date": f"{date}T12:00:00Z",
        "currency_code": currency_code,
        "group_id": group_id,
        "users__0__user_id": me,
        "users__0__paid_share": str(payer_me),
        "users__0__owed_share": str(mine),
        "users__1__user_id": friend_id,
        "users__1__paid_share": str(payer_friend),
        "users__1__owed_share": str(theirs),
    }
    if details:
        body["details"] = details
    created = call("create_expense", body=body)["expenses"][0]
    return {"id": created["id"], "description": created["description"], "cost": created["cost"]}


if __name__ == "__main__":
    server.run()
