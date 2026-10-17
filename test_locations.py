import json
import sqlite3
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

import pytest
from fastapi import HTTPException

from app import create_app
from common import dump
from domain import recommend
from location import Coordinates, NearbyInput, NoRedirect, SearchArea, distance_meters, fetch_openstreetmap, within_area
from seed import fixture
from test_meals import meal_room, preferences, ready
from test_security import environment

AREA = {"latitude": 25.033, "longitude": 121.5654, "radius_m": 1000, "label": "示範共同集合點"}


@pytest.mark.parametrize("changes", [{"latitude": 91}, {"longitude": -181}, {"latitude": True}, {"latitude": "25"}, {"radius_m": 99}, {"radius_m": 5001}, {"radius_m": True}, {"label": ""}])
def test_invalid_area_is_rejected(changes):
    with pytest.raises(ValueError):
        SearchArea.model_validate(AREA | changes)


@pytest.mark.parametrize("origin,destination,expected", [
    ({"latitude": 0, "longitude": 0}, {"latitude": 0, "longitude": 0}, 0),
    ({"latitude": 0, "longitude": 0}, {"latitude": 0, "longitude": 1}, 111195),
    ({"latitude": 0, "longitude": 179.999}, {"latitude": 0, "longitude": -179.999}, 222),
    ({"latitude": 90, "longitude": 0}, {"latitude": 90, "longitude": 100}, 0),
])
def test_spherical_distance(origin, destination, expected):
    assert distance_meters(origin, destination) == pytest.approx(expected, abs=1)


def test_nearby_radius_and_zero_coordinate():
    area = {"latitude": 0, "longitude": 0, "radius_m": 1000}
    restaurants = [{"id": "near", "coordinates": {"latitude": 0, "longitude": .001}},
                   {"id": "far", "coordinates": {"latitude": 0, "longitude": .1}}, {"id": "unknown"}]
    assert [item["id"] for item in within_area(restaurants, area)] == ["near"]


def test_nearby_catalog_does_not_persist_private_position(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    response = host.post("/api/nearby/catalog", json=AREA)
    assert response.status_code == 200
    assert response.headers["cache-control"] == "no-store"
    assert all(item["distance_m"] <= 1000 for item in response.json()["restaurants"])
    assert response.json()["distance_kind"] == "straight_line"
    with application.state.store.transaction() as connection:
        assert connection.execute("SELECT area FROM rooms WHERE id=?", (room["id"],)).fetchone()[0] is None


def test_shared_area_requires_host_and_invalidates_old_comparison(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    ready(host, member, room)
    old = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    assert member.put(f"/api/rooms/{room['id']}/area", json=AREA).status_code == 403
    assert outsider.put(f"/api/rooms/{room['id']}/area", json=AREA).status_code == 404
    assert host.put(f"/api/rooms/{room['id']}/area", json=AREA).status_code == 200
    assert member.get(f"/api/rooms/{room['id']}").json()["area"] == AREA
    stale = {"restaurant_id": "green", "room_version": old["room_version"], "catalog_version": old["catalog_version"]}
    assert host.post(f"/api/rooms/{room['id']}/freeze", json=stale).status_code == 409
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    snapshot = host.post(f"/api/rooms/{room['id']}/freeze", json=stale | {"room_version": result["room_version"]})
    assert snapshot.status_code == 200
    assert snapshot.json()["area"] == AREA
    assert host.put(f"/api/rooms/{room['id']}/area", json=AREA | {"radius_m": 2000}).status_code == 409


def test_per_member_distance_is_a_hard_constraint(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    ready(host, member, room)
    host.put(f"/api/rooms/{room['id']}/area", json=AREA)
    member.put(f"/api/rooms/{room['id']}/preferences", json=preferences(vegetarian=True) | {"max_distance_m": 300})
    result = host.get(f"/api/rooms/{room['id']}/recommendations").json()
    assert [item["id"] for item in result["eligible"]] == ["green"]


def test_unknown_coordinates_are_not_invented(environment):
    application, timer = environment
    today = datetime.fromtimestamp(timer[0], timezone.utc).date()
    catalog = fixture(today)
    catalog["restaurants"][0]["coordinates"] = None
    result = recommend(catalog, [{"nickname": "測試", "preferences": preferences()}], today, AREA)
    assert "green" not in {item["id"] for item in result["eligible"]}
    assert any("缺少店家座標" in reason for item in result["rejected"] for reason in item["reasons"])


def test_rotate_invite_revokes_old_link_not_existing_members(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    assert member.post(f"/api/rooms/{room['id']}/rotate-invite").status_code == 403
    rotated = host.post(f"/api/rooms/{room['id']}/rotate-invite").json()
    assert outsider.post("/api/rooms/join", json={"invite": room["invite"]}).status_code == 404
    assert member.get(f"/api/rooms/{room['id']}").status_code == 200
    assert outsider.post("/api/rooms/join", json={"invite": rotated["invite"]}).status_code == 200


def test_external_lookup_requires_consent_and_has_no_fake_fallback(meal_room):
    application, timer, host, member, outsider, room, catalog = meal_room
    calls = []
    application.state.nearby_provider = lambda payload: calls.append(payload) or []
    assert host.post("/api/nearby/openstreetmap", json=AREA).status_code == 422
    assert host.post("/api/nearby/openstreetmap", json=AREA | {"external_consent": "true"}).status_code == 422
    assert calls == []
    response = host.post("/api/nearby/openstreetmap", json=AREA | {"external_consent": True})
    assert response.status_code == 200 and response.json()["restaurants"] == []
    assert len(calls) == 1
    def fail(payload):
        raise HTTPException(503, "Provider unavailable")
    application.state.nearby_provider = fail
    assert host.post("/api/nearby/openstreetmap", json=AREA | {"external_consent": True}).status_code == 503


def test_provider_normalizes_nodes_and_way_centers(monkeypatch):
    requests = []
    document = {"elements": [
        {"type": "node", "id": 1, "lat": 25.0331, "lon": 121.5654, "tags": {"name": "Cafe <test>", "amenity": "cafe"}},
        {"type": "way", "id": 2, "center": {"lat": 25.0335, "lon": 121.5655}, "tags": {"name:zh": "測試餐廳", "amenity": "restaurant"}},
        {"type": "node", "id": 3, "lat": 95, "lon": 121.5, "tags": {"amenity": "restaurant"}},
        {"type": "node", "id": 4, "lat": 25.033, "lon": 121.5654, "tags": {"amenity": "bank"}},
    ]}
    class ProviderResponse:
        def __enter__(self):
            return self
        def __exit__(self, *arguments):
            return False
        def read(self, size):
            return json.dumps(document).encode()
    class Opener:
        def open(self, request, timeout):
            requests.append(request)
            return ProviderResponse()
    monkeypatch.setattr("urllib.request.build_opener", lambda *arguments: Opener())
    results = fetch_openstreetmap(NearbyInput(**AREA, external_consent=True))
    assert [item["id"] for item in results] == ["osm-node-1", "osm-way-2"]
    assert all(item["price"] is None and item["dishes"] == [] and item["menu_status"] == "unverified" for item in results)
    assert requests[0].full_url == "https://overpass-api.de/api/interpreter"
    assert requests[0].method == "POST"
    query = urllib.parse.parse_qs(requests[0].data.decode())["data"][0]
    assert "around:2600,25.030000,121.570000" in query
    assert "out center 80" in query
    assert AREA["label"] not in query and "121.565400" not in query


def test_provider_redirects_are_not_followed():
    request = urllib.request.Request("https://overpass-api.de/api/interpreter")
    with pytest.raises(urllib.error.HTTPError):
        NoRedirect().redirect_request(request, None, 307, "redirect", {}, "https://other.example/")


def test_external_lookup_respects_daily_budget_and_resets(environment):
    application, timer = environment
    store = application.state.store
    for unused in range(80):
        store.throttle("nearby:global", 80, 86400)
    with pytest.raises(HTTPException) as error:
        store.throttle("nearby:global", 80, 86400)
    assert error.value.status_code == 429
    timer[0] += 86400
    store.throttle("nearby:global", 80, 86400)


def test_provider_errors_return_503(monkeypatch):
    class Unavailable:
        def open(self, request, timeout):
            raise TimeoutError("network")
    monkeypatch.setattr("urllib.request.build_opener", lambda *arguments: Unavailable())
    with pytest.raises(HTTPException) as error:
        fetch_openstreetmap(NearbyInput(**AREA, external_consent=True))
    assert error.value.status_code == 503


def test_existing_database_adds_area_without_reset(tmp_path):
    path = tmp_path / "legacy.db"
    with sqlite3.connect(path) as connection:
        connection.execute("CREATE TABLE rooms(id TEXT PRIMARY KEY,title TEXT,host TEXT,invite TEXT,version INTEGER,snapshot TEXT)")
        connection.execute("INSERT INTO rooms VALUES('old','既有決策室',NULL,'legacy',1,NULL)")
    application = create_app(path)
    with application.state.store.transaction() as connection:
        row = connection.execute("SELECT * FROM rooms WHERE id='old'").fetchone()
        assert row["title"] == "既有決策室" and row["area"] is None
