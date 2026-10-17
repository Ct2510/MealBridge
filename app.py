import hmac
import json
import os
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from pydantic import Field

from common import Store, dump, setup
from domain import Catalog, Preferences, StrictModel, recommend


class RoomInput(StrictModel):
    title: str = Field(min_length=1, max_length=70)


class JoinInput(StrictModel):
    invite: str = Field(min_length=20, max_length=100)


class FreezeInput(StrictModel):
    restaurant_id: str
    room_version: int
    catalog_version: int


class ReportInput(StrictModel):
    restaurant_id: str = Field(max_length=40)
    note: str = Field(min_length=5, max_length=500)


def create_app(path=None, clock=None):
    store = Store(path or os.getenv("MEALBRIDGE_DB", "data/mealbridge.db"), **({"clock": clock} if clock else {}))
    with store.transaction() as connection:
        connection.executescript("""
            CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER, data TEXT);
            CREATE TABLE IF NOT EXISTS rooms (
                id TEXT PRIMARY KEY, title TEXT NOT NULL, host TEXT REFERENCES users(id),
                invite TEXT UNIQUE NOT NULL, version INTEGER NOT NULL DEFAULT 1, snapshot TEXT
            );
            CREATE TABLE IF NOT EXISTS members (
                room TEXT REFERENCES rooms(id), user_id TEXT REFERENCES users(id), preferences TEXT,
                PRIMARY KEY(room,user_id)
            );
            CREATE TABLE IF NOT EXISTS reports (
                id INTEGER PRIMARY KEY, user_id TEXT REFERENCES users(id), restaurant_id TEXT, note TEXT, created INTEGER
            );
        """)
    app = FastAPI(title="MealBridge", version="1.0.0", docs_url=None, redoc_url=None)
    app.state.store = store
    current = setup(app, store, "MealBridge")

    def catalog_row(connection):
        row = connection.execute("SELECT * FROM catalog WHERE id=1").fetchone()
        if not row:
            raise HTTPException(503, "尚未匯入菜單，請先執行 seed.py")
        return row

    def room_member(connection, room_id, user):
        room = connection.execute("SELECT * FROM rooms WHERE id=?", (room_id,)).fetchone()
        member = connection.execute("SELECT * FROM members WHERE room=? AND user_id=?", (room_id, user["id"])).fetchone()
        if not room or not member:
            raise HTTPException(404, "找不到可存取的決策室")
        return room

    def room_results(connection, room):
        catalog = catalog_row(connection)
        members = connection.execute(
            "SELECT nickname,preferences FROM members JOIN users ON users.id=members.user_id WHERE room=? ORDER BY user_id",
            (room["id"],)
        ).fetchall()
        if any(not member["preferences"] for member in members):
            raise HTTPException(409, "所有成員填妥偏好後才能進行比較")
        people = [{"nickname": member["nickname"], "preferences": json.loads(member["preferences"])} for member in members]
        today = datetime.fromtimestamp(store.clock(), timezone.utc).date()
        result = recommend(json.loads(catalog["data"]), people, today)
        return {**result, "room_version": room["version"], "catalog_version": catalog["version"]}

    @app.get("/api/catalog")
    def catalog():
        with store.transaction() as connection:
            row = catalog_row(connection)
            return {"version": row["version"], **json.loads(row["data"])}

    @app.put("/api/catalog")
    def replace_catalog(payload: Catalog, request: Request):
        expected = os.getenv("CATALOG_KEY", "")
        if not expected or not hmac.compare_digest(request.headers.get("x-catalog-key", ""), expected):
            raise HTTPException(403, "需要菜單維護金鑰")
        with store.transaction() as connection:
            connection.execute("INSERT INTO catalog VALUES (1,1,?) ON CONFLICT(id) DO UPDATE SET version=version+1,data=excluded.data",
                               (payload.model_dump_json(),))
            return {"version": catalog_row(connection)["version"]}

    @app.get("/api/rooms")
    def rooms(request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            return [dict(row) for row in connection.execute(
                "SELECT rooms.id,title,version,snapshot IS NOT NULL AS frozen FROM rooms JOIN members ON rooms.id=members.room WHERE user_id=?",
                (user["id"],))]

    @app.post("/api/rooms", status_code=201)
    def create_room(payload: RoomInput, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            count = connection.execute("SELECT count(*) FROM rooms WHERE host=?", (user["id"],)).fetchone()[0]
            if count >= 30:
                raise HTTPException(409, "每個帳號最多建立 30 個決策室")
            room_id, invite = secrets.token_urlsafe(12), secrets.token_urlsafe(24)
            connection.execute("INSERT INTO rooms (id,title,host,invite) VALUES (?,?,?,?)", (room_id, payload.title, user["id"], invite))
            connection.execute("INSERT INTO members VALUES (?,?,NULL)", (room_id, user["id"]))
            return {"id": room_id, "invite": invite}

    @app.post("/api/rooms/join")
    def join_room(payload: JoinInput, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            room = connection.execute("SELECT * FROM rooms WHERE invite=?", (payload.invite,)).fetchone()
            if not room:
                raise HTTPException(404, "邀請不存在")
            if connection.execute("SELECT 1 FROM members WHERE room=? AND user_id=?", (room["id"], user["id"])).fetchone():
                return {"id": room["id"]}
            if room["snapshot"]:
                raise HTTPException(409, "決策已定案，不能再加入")
            if connection.execute("SELECT count(*) FROM members WHERE room=?", (room["id"],)).fetchone()[0] >= 16:
                raise HTTPException(409, "最多 16 人")
            connection.execute("INSERT INTO members VALUES (?,?,NULL)", (room["id"], user["id"]))
            connection.execute("UPDATE rooms SET version=version+1 WHERE id=?", (room["id"],))
            return {"id": room["id"]}

    @app.get("/api/rooms/{room_id}")
    def room_detail(room_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            room = room_member(connection, room_id, user)
            members = [dict(row) for row in connection.execute(
                "SELECT nickname,preferences IS NOT NULL AS ready FROM members JOIN users ON users.id=members.user_id WHERE room=? ORDER BY user_id",
                (room_id,))]
            preferences = connection.execute("SELECT preferences FROM members WHERE room=? AND user_id=?", (room_id, user["id"])).fetchone()[0]
            return {"id": room_id, "title": room["title"], "version": room["version"], "is_host": room["host"] == user["id"],
                    "invite": room["invite"], "members": members, "preferences": json.loads(preferences) if preferences else None,
                    "snapshot": json.loads(room["snapshot"]) if room["snapshot"] else None}

    @app.put("/api/rooms/{room_id}/preferences")
    def update_preferences(room_id: str, payload: Preferences, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            room = room_member(connection, room_id, user)
            if room["snapshot"]:
                raise HTTPException(409, "決策已定案")
            connection.execute("UPDATE members SET preferences=? WHERE room=? AND user_id=?", (payload.model_dump_json(), room_id, user["id"]))
            connection.execute("UPDATE rooms SET version=version+1 WHERE id=?", (room_id,))
            return {"ok": True}

    @app.get("/api/rooms/{room_id}/recommendations")
    def recommendations(room_id: str, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            room = room_member(connection, room_id, user)
            return room_results(connection, room)

    @app.post("/api/rooms/{room_id}/freeze")
    def freeze(room_id: str, payload: FreezeInput, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            room = room_member(connection, room_id, user)
            if room["host"] != user["id"]:
                raise HTTPException(403, "只有發起人可定案")
            if room["snapshot"]:
                raise HTTPException(409, "已定案")
            result = room_results(connection, room)
            if payload.room_version != result["room_version"] or payload.catalog_version != result["catalog_version"]:
                raise HTTPException(409, "偏好或菜單已更新，請重新比較")
            selected = next((item for item in result["eligible"] if item["id"] == payload.restaurant_id), None)
            if not selected:
                raise HTTPException(409, "這間餐廳無法滿足全員條件")
            snapshot = {"selected": selected, "room_version": room["version"], "catalog_version": result["catalog_version"],
                        "decided_at": int(store.clock()), "policy": "hard-constraints/max-min-v1"}
            connection.execute("UPDATE rooms SET snapshot=?,version=version+1 WHERE id=?", (dump(snapshot), room_id))
            return snapshot

    @app.post("/api/reports", status_code=201)
    def report(payload: ReportInput, request: Request):
        with store.transaction() as connection:
            user = current(connection, request)
            catalog = json.loads(catalog_row(connection)["data"])
            if payload.restaurant_id not in {item["id"] for item in catalog["restaurants"]}:
                raise HTTPException(404, "餐廳不存在")
            connection.execute("INSERT INTO reports (user_id,restaurant_id,note,created) VALUES (?,?,?,?)",
                               (user["id"], payload.restaurant_id, payload.note, int(store.clock())))
            return {"status": "received", "message": "尚未人工查核，不會自動改寫菜單"}

    return app


app = create_app()
