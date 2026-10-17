from copy import deepcopy
from datetime import datetime, timedelta, timezone

import pytest

from common import dump
from domain import Catalog, Preferences, recommend
from seed import fixture
from test_security import account, environment


@pytest.fixture
def meal_room(environment):
    application, timer = environment
    today = datetime.fromtimestamp(timer[0], timezone.utc).date()
    catalog = fixture(today)
    with application.state.store.transaction() as connection:
        connection.execute("INSERT INTO catalog VALUES (1,1,?)", (dump(catalog),))
    host, host_user = account(application, "host", "小安")
    member, member_user = account(application, "member", "小林")
    outsider, outsider_user = account(application, "outsider")
    room = host.post("/api/rooms", json={"title": "週五午餐"}).json()
    member.post("/api/rooms/join", json={"invite": room["invite"]})
    return application, timer, host, member, outsider, room, catalog


def preferences(**changes):
    return Preferences(budget=140, **changes).model_dump()


def ready(host, member, room):
    host.put(f"/api/rooms/{room['id']}/preferences", json=preferences())
    member.put(f"/api/rooms/{room['id']}/preferences", json=preferences(vegetarian=True, no_spicy=True))


def test_group_workflow_and_privacy(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    assert host.get(f"/api/rooms/{room['id']}/recommendations").status_code == 409
    ready(host, member, room)
    detail = host.get(f"/api/rooms/{room['id']}").json()
    assert len(detail["members"]) == 2
    assert all("preferences" not in person for person in detail["members"])
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    assert {item["id"] for item in result["eligible"]} == {"green", "noodle"}
    assert len(result["rejected"]) == 3
    assert outsider.get(f"/api/rooms/{room['id']}").status_code == 404
    assert outsider.put(f"/api/rooms/{room['id']}/preferences", json=preferences()).status_code == 404
    assert member.post("/api/rooms/join", json={"invite": room["invite"]}).json()["id"] == room["id"]


def test_snapshot_is_immutable_and_host_only(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    ready(host, member, room)
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    payload = {"restaurant_id": "green", "room_version": result["room_version"], "catalog_version": result["catalog_version"]}
    assert member.post(f"/api/rooms/{room['id']}/freeze", json=payload).status_code == 403
    snapshot = host.post(f"/api/rooms/{room['id']}/freeze", json=payload)
    assert snapshot.status_code == 200
    assert member.put(f"/api/rooms/{room['id']}/preferences", json=preferences()).status_code == 409
    assert outsider.post("/api/rooms/join", json={"invite": room["invite"]}).status_code == 409
    with application.state.store.transaction() as connection:
        catalog["restaurants"][0]["name"] = "已改名"
        connection.execute("UPDATE catalog SET version=2,data=?", (dump(catalog),))
    assert host.get(f"/api/rooms/{room['id']}").json()["snapshot"] == snapshot.json()
    assert host.post(f"/api/rooms/{room['id']}/freeze", json=payload).status_code == 409


@pytest.mark.parametrize("change", ["preferences", "catalog"])
def test_stale_decision_rejected(meal_room, change):
    application, timer, host, member, outsider, room, catalog = meal_room
    ready(host, member, room)
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    if change == "preferences":
        host.put(f"/api/rooms/{room['id']}/preferences", json=preferences(no_pork=True))
    else:
        with application.state.store.transaction() as connection:
            connection.execute("UPDATE catalog SET version=version+1")
    payload = {"restaurant_id": "green", "room_version": result["room_version"], "catalog_version": result["catalog_version"]}
    assert host.post(f"/api/rooms/{room['id']}/freeze", json=payload).status_code == 409


def test_ineligible_cannot_freeze(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    ready(host, member, room)
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    assert host.post(f"/api/rooms/{room['id']}/freeze", json={"restaurant_id": "spice", "room_version": result["room_version"], "catalog_version": result["catalog_version"]}).status_code == 409


@pytest.mark.parametrize("constraint", [{"vegetarian": True}, {"no_beef": True}, {"no_pork": True}, {"no_spicy": True}, {"max_walk": 0}])
def test_hard_constraints(environment, constraint):
    application, timer = environment
    today = datetime.fromtimestamp(timer[0], timezone.utc).date()
    result = recommend(fixture(today), [{"nickname": "甲", "preferences": preferences(**constraint)}], today)
    for restaurant in result["eligible"]:
        dish = restaurant["choices"][0]["dish"]
        assert dish["price"] <= 140
        if constraint.get("vegetarian"):
            assert dish["diet"] == "vegetarian"
        if constraint.get("no_beef"):
            assert "beef" not in dish["proteins"] and dish["diet"] != "unknown"
        if constraint.get("no_pork"):
            assert "pork" not in dish["proteins"] and dish["diet"] != "unknown"
        if constraint.get("no_spicy"):
            assert dish["spicy"] is False
    if constraint.get("max_walk") == 0:
        assert result["eligible"] == []


def test_max_min_fairness_and_determinism(environment):
    application, timer = environment
    today = datetime.fromtimestamp(timer[0], timezone.utc).date()
    people = [{"nickname": "甲", "preferences": preferences(cuisines=["台式"])}, {"nickname": "乙", "preferences": preferences(cuisines=["日式"])}]
    result = recommend(fixture(today), people, today)
    ranks = [(item["min_score"], item["mean_score"]) for item in result["eligible"]]
    assert ranks == sorted(ranks, reverse=True)
    assert result == recommend(fixture(today), people, today)


@pytest.mark.parametrize("days,expected", [(30, True), (31, False), (-1, False)])
def test_menu_evidence_boundary(environment, days, expected):
    application, timer = environment
    today = datetime.fromtimestamp(timer[0], timezone.utc).date()
    catalog = fixture(today)
    catalog["restaurants"] = [catalog["restaurants"][0]]
    catalog["restaurants"][0]["verified_on"] = str(today - timedelta(days=days))
    result = recommend(catalog, [{"nickname": "甲", "preferences": preferences()}], today)
    assert bool(result["eligible"]) == expected


def test_catalog_authorization_validation_atomicity(meal_room, monkeypatch):
    application, timer, host, member, outsider, room, catalog = meal_room
    assert host.put("/api/catalog", json=catalog).status_code == 403
    monkeypatch.setenv("CATALOG_KEY", "unit-test-operator-key")
    invalid = deepcopy(catalog)
    invalid["restaurants"].append(invalid["restaurants"][0])
    assert host.put("/api/catalog", json=invalid, headers={"X-Catalog-Key": "unit-test-operator-key"}).status_code == 422
    assert host.get("/api/catalog").json()["version"] == 1
    assert host.put("/api/catalog", json=catalog, headers={"X-Catalog-Key": "unit-test-operator-key"}).json()["version"] == 2


def test_report_does_not_change_catalog(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    response = member.post("/api/reports", json={"restaurant_id": "green", "note": "這張菜單的價格需要重新確認"})
    assert response.status_code == 201
    assert member.get("/api/catalog").json()["version"] == 1
    assert member.post("/api/reports", json={"restaurant_id": "missing", "note": "無效餐廳測試資料"}).status_code == 404


@pytest.mark.parametrize("value", [0, -1, True, "100"])
def test_price_is_positive_integer(environment, value):
    application, timer = environment
    catalog = fixture(datetime.fromtimestamp(timer[0], timezone.utc).date())
    catalog["restaurants"][0]["dishes"][0]["price"] = value
    with pytest.raises(ValueError):
        Catalog.model_validate(catalog)
