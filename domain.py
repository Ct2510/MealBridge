from datetime import date
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True)


class Dish(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9-]{1,40}$")
    name: str = Field(min_length=1, max_length=60)
    price: int = Field(strict=True, ge=1, le=10000)
    diet: Literal["vegetarian", "omnivore", "unknown"]
    proteins: list[Literal["beef", "pork", "chicken", "fish", "none"]] = Field(min_length=1, max_length=5)
    spicy: bool | None


class Restaurant(StrictModel):
    id: str = Field(pattern=r"^[a-z0-9-]{1,40}$")
    name: str = Field(min_length=1, max_length=60)
    cuisine: str = Field(min_length=1, max_length=30)
    walk_minutes: int = Field(ge=0, le=120)
    source_label: str = Field(min_length=1, max_length=100)
    source_url: HttpUrl | None = None
    verified_on: date
    fictional: bool
    dishes: list[Dish] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def unique_dishes(self):
        if len({dish.id for dish in self.dishes}) != len(self.dishes):
            raise ValueError("餐點代碼重複")
        if any(dish.diet == "vegetarian" and dish.proteins != ["none"] for dish in self.dishes):
            raise ValueError("蛋奶素餐點不得標示肉類")
        return self


class Catalog(StrictModel):
    restaurants: list[Restaurant] = Field(min_length=1, max_length=30)

    @model_validator(mode="after")
    def unique_restaurants(self):
        if len({restaurant.id for restaurant in self.restaurants}) != len(self.restaurants):
            raise ValueError("餐廳代碼重複")
        return self


class Preferences(StrictModel):
    budget: int = Field(strict=True, ge=50, le=3000)
    vegetarian: bool = False
    no_beef: bool = False
    no_pork: bool = False
    no_spicy: bool = False
    max_walk: int = Field(ge=0, le=60, default=15)
    cuisines: list[str] = Field(default_factory=list, max_length=8)


def recommend(catalog, people, today):
    eligible = []
    rejected = []
    for restaurant in catalog["restaurants"]:
        reasons = []
        age = (today - date.fromisoformat(restaurant["verified_on"])).days
        if age < 0 or age > 30:
            reasons.append("菜單查核日期超過 30 天或在未來，請先重新確認")
        choices = []
        for person in people:
            preferences = person["preferences"]
            fitting = []
            for dish in restaurant["dishes"]:
                if dish["price"] > preferences["budget"] or restaurant["walk_minutes"] > preferences["max_walk"]:
                    continue
                if preferences["vegetarian"] and dish["diet"] != "vegetarian":
                    continue
                if (preferences["no_beef"] or preferences["no_pork"]) and dish["diet"] == "unknown":
                    continue
                if preferences["no_beef"] and "beef" in dish["proteins"]:
                    continue
                if preferences["no_pork"] and "pork" in dish["proteins"]:
                    continue
                if preferences["no_spicy"] and dish["spicy"] is not False:
                    continue
                fitting.append(dish)
            if not fitting:
                reasons.append(person["nickname"] + " 沒有符合預算、飲食偏好及步行範圍的餐點")
                continue
            dish = min(fitting, key=lambda item: (item["price"], item["id"]))
            cuisine_score = 50 if restaurant["cuisine"] in preferences["cuisines"] else 25
            score = round(cuisine_score + 35 * (preferences["budget"] - dish["price"]) / preferences["budget"]
                          + max(0, 15 - restaurant["walk_minutes"]), 2)
            choices.append({"nickname": person["nickname"], "dish": dish, "score": score,
                            "remaining_budget": preferences["budget"] - dish["price"]})
        if reasons:
            rejected.append({"id": restaurant["id"], "name": restaurant["name"], "reasons": reasons})
        else:
            eligible.append({**restaurant, "choices": choices,
                             "min_score": min(choice["score"] for choice in choices),
                             "mean_score": round(sum(choice["score"] for choice in choices) / len(choices), 2),
                             "group_total": sum(choice["dish"]["price"] for choice in choices)})
    eligible.sort(key=lambda item: (-item["min_score"], -item["mean_score"], item["walk_minutes"], item["id"]))
    return {"eligible": eligible, "rejected": rejected}
