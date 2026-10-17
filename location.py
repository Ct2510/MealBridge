import json
import http.client
import math
import urllib.error
import urllib.parse
import urllib.request

from fastapi import HTTPException
from pydantic import BaseModel, ConfigDict, Field


class Coordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")
    latitude: float = Field(ge=-90, le=90, allow_inf_nan=False, strict=True)
    longitude: float = Field(ge=-180, le=180, allow_inf_nan=False, strict=True)


class SearchArea(Coordinates):
    radius_m: int = Field(ge=100, le=5000, strict=True, default=1000)
    label: str = Field(min_length=1, max_length=70, default="共同集合點")


class NearbyInput(SearchArea):
    external_consent: bool = Field(default=False, strict=True)


def distance_meters(origin, destination):
    origin_latitude = math.radians(origin["latitude"])
    destination_latitude = math.radians(destination["latitude"])
    latitude_delta = destination_latitude - origin_latitude
    longitude_delta = math.radians(destination["longitude"] - origin["longitude"])
    haversine = math.sin(latitude_delta / 2) ** 2 + math.cos(origin_latitude) * math.cos(destination_latitude) * math.sin(longitude_delta / 2) ** 2
    return 6371008.8 * 2 * math.atan2(math.sqrt(min(1, haversine)), math.sqrt(max(0, 1 - haversine)))


def within_area(restaurants, area):
    results = []
    for restaurant in restaurants:
        point = restaurant.get("coordinates")
        if not point:
            continue
        distance = distance_meters(area, point)
        if distance <= area["radius_m"]:
            results.append({**restaurant, "distance_m": round(distance)})
    return sorted(results, key=lambda item: (item["distance_m"], item["id"]))


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        raise urllib.error.HTTPError(request.full_url, code, "Redirect refused", headers, response)


def fetch_openstreetmap(area):
    latitude, longitude, radius = round(area.latitude, 2), round(area.longitude, 2), area.radius_m + 1600
    query = (f'[out:json][timeout:12];nwr["amenity"~"^(restaurant|cafe|fast_food)$"]'
             f'(around:{radius},{latitude:.6f},{longitude:.6f});out center 80;')
    request = urllib.request.Request(
        "https://overpass-api.de/api/interpreter",
        data=urllib.parse.urlencode({"data": query}).encode(),
        headers={"User-Agent": "MealBridge/1.1 (+https://github.com/Ct2510/MealBridge)",
                 "Content-Type": "application/x-www-form-urlencoded", "Accept": "application/json"},
        method="POST"
    )
    try:
        with urllib.request.build_opener(NoRedirect()).open(request, timeout=15) as response:
            content = response.read(1_048_577)
        if len(content) > 1_048_576:
            raise ValueError("Response too large")
        document = json.loads(content)
        if not isinstance(document, dict) or not isinstance(document.get("elements"), list) or document.get("remark"):
            raise ValueError("Incomplete provider response")
    except (OSError, ValueError, urllib.error.URLError, http.client.HTTPException) as error:
        raise HTTPException(503, "OpenStreetMap 店家服務暫時無法使用；沒有以虛構資料替代，請稍後再試") from error
    restaurants = []
    seen = set()
    for element in document["elements"][:80]:
        if not isinstance(element, dict) or element.get("type") not in {"node", "way", "relation"}:
            continue
        identifier = element.get("id")
        if not isinstance(identifier, int) or isinstance(identifier, bool) or identifier < 1:
            continue
        tags = element.get("tags", {})
        center = element if element["type"] == "node" else element.get("center", {})
        if not isinstance(tags, dict) or not isinstance(center, dict):
            continue
        if tags.get("amenity") not in {"restaurant", "cafe", "fast_food"}:
            continue
        try:
            point = Coordinates(latitude=center.get("lat"), longitude=center.get("lon")).model_dump()
        except ValueError:
            continue
        key = f"osm-{element['type']}-{identifier}"
        if key in seen:
            continue
        seen.add(key)
        name = tags.get("name:zh") or tags.get("name") or "未命名店家"
        cuisine = tags.get("cuisine") or ("咖啡" if tags.get("amenity") == "cafe" else "料理未分類")
        address = "".join(str(tags.get(part, "")) for part in ("addr:city", "addr:district", "addr:street", "addr:housenumber"))[:200]
        restaurants.append({"id": key, "name": str(name)[:100], "cuisine": str(cuisine)[:80],
                            "coordinates": point, "address": address, "fictional": False,
                            "source_url": f"https://www.openstreetmap.org/{element['type']}/{identifier}",
                            "source_label": "© OpenStreetMap contributors · ODbL", "dishes": [],
                            "menu_status": "unverified", "price": None})
    return within_area(restaurants, area.model_dump())
