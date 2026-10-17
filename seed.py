import argparse
import json
import os
from datetime import date, timedelta

from common import Store
from domain import Catalog


def fixture(today):
    restaurants = []
    specifications = [
        ("green", "青禾食堂", "台式", 6, [("蔬食飯", 95, "vegetarian", ["none"], False), ("香煎雞腿飯", 125, "omnivore", ["chicken"], False)]),
        ("noodle", "小巷麵屋", "日式", 9, [("野菇烏龍麵", 110, "vegetarian", ["none"], False), ("豚骨拉麵", 150, "omnivore", ["pork"], False)]),
        ("spice", "辣日咖哩", "咖哩", 4, [("牛肉咖哩", 135, "omnivore", ["beef"], True), ("雞肉咖哩", 125, "omnivore", ["chicken"], True)]),
        ("old", "昨日小館", "台式", 3, [("鮮蔬飯", 80, "vegetarian", ["none"], False)]),
        ("unknown", "未明料理所", "台式", 5, [("今日特餐", 90, "unknown", ["none"], None)]),
    ]
    for index, (identifier, name, cuisine, walk, dishes) in enumerate(specifications):
        restaurants.append({"id": identifier, "name": name, "cuisine": cuisine, "walk_minutes": walk,
                            "coordinates": {"latitude": 25.033 + [0.0018, -0.003, 0.005, -0.008, 0.012][index], "longitude": 121.5654 + [0.002, 0.004, -0.003, 0.008, 0.012][index]},
                            "source_label": "原創虛構測試菜單，非真實店家或價格", "source_url": None, "fictional": True,
                            "verified_on": str(today - timedelta(days=45) if identifier == "old" else today),
                            "dishes": [{"id": f"dish-{index}", "name": dish[0], "price": dish[1], "diet": dish[2],
                                        "proteins": dish[3], "spicy": dish[4]} for index, dish in enumerate(dishes)]})
    return Catalog(restaurants=restaurants).model_dump(mode="json")


def main():
    parser = argparse.ArgumentParser(description="匯入原創虛構菜單；不包含真實餐廳資訊")
    parser.add_argument("--replace", action="store_true", help="明確取代既有菜單")
    arguments = parser.parse_args()
    store = Store(os.getenv("MEALBRIDGE_DB", "data/mealbridge.db"))
    from app import create_app
    create_app(store.path)
    with store.transaction() as connection:
        if connection.execute("SELECT 1 FROM catalog").fetchone() and not arguments.replace:
            raise SystemExit("已有菜單；要取代請加 --replace")
        connection.execute("INSERT INTO catalog VALUES (1,1,?) ON CONFLICT(id) DO UPDATE SET version=version+1,data=excluded.data",
                           (json.dumps(fixture(date.today()), ensure_ascii=False),))
    print("已匯入 5 間虛構餐廳；日期為測試基準，不代表實地查核。")


if __name__ == "__main__":
    main()
