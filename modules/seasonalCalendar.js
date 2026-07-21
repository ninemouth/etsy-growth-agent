/* SPDX-License-Identifier: MIT | Copyright (c) 2026 Yang Cao <cao.x.yang@gmail.com> */

export const SEASONAL_PEAKS = {
  // Mapping current month (0-indexed, 0 = Jan, 11 = Dec) to target seasons
  6: { // July
    seasonName: "Autumn & Back to School",
    timeframe: "Aug - Nov",
    events: ["Back to School", "Fall Weddings", "Halloween", "Thanksgiving"],
    seedKeywords: [
      "personalized teacher gifts",
      "fall home decor",
      "halloween sweatshirt",
      "cozy blanket custom",
      "rustic wedding favors",
      "pumpkin spice candle"
    ]
  },
  7: { // August
    seasonName: "Autumn & Early Holidays",
    timeframe: "Sept - Dec",
    events: ["Halloween", "Thanksgiving", "Early Christmas prep"],
    seedKeywords: [
      "spooky decor",
      "thanksgiving table runner",
      "christmas stockings personalized",
      "autumn wedding sign",
      "fall knit sweater",
      "custom name pumpkin"
    ]
  },
  8: { // September
    seasonName: "Halloween & Winter Holidays",
    timeframe: "Oct - Dec",
    events: ["Halloween", "Thanksgiving", "Christmas", "Black Friday"],
    seedKeywords: [
      "halloween decorations outdoor",
      "personalized christmas ornaments",
      "holiday gift tags",
      "thanksgiving gifts",
      "cozy winter socks",
      "custom wood sign"
    ]
  },
  9: { // October
    seasonName: "Holiday Season Peak",
    timeframe: "Nov - Jan",
    events: ["Thanksgiving", "Christmas", "New Year", "Valentine's Day prep"],
    seedKeywords: [
      "christmas gifts for her",
      "personalized jewelry box",
      "ugly christmas sweater",
      "new year planner",
      "winter cabin decor",
      "custom wrapping paper"
    ]
  },
  10: { // November
    seasonName: "Late Holiday & Valentine's Day",
    timeframe: "Dec - Feb",
    events: ["Christmas", "New Year", "Valentine's Day"],
    seedKeywords: [
      "last minute christmas gifts",
      "personalized couples gift",
      "valentines day card custom",
      "winter mug personalized",
      "new year resolution tracker"
    ]
  },
  11: { // December
    seasonName: "Valentine's Day & Spring",
    timeframe: "Jan - Apr",
    events: ["Valentine's Day", "St Patrick's Day", "Spring home decor", "Easter"],
    seedKeywords: [
      "valentines day gift for him",
      "personalized promise ring",
      "st patricks day shirt",
      "spring wreath",
      "easter basket personalized"
    ]
  },
  0: { // January
    seasonName: "Spring & Mother's Day",
    timeframe: "Feb - May",
    events: ["Mother's Day prep", "Spring weddings", "Easter", "Graduation"],
    seedKeywords: [
      "mothers day gift personalized",
      "spring wedding decor",
      "easter egg custom",
      "graduation gift for him",
      "floral nursery decor"
    ]
  },
  1: { // February
    seasonName: "Mother's Day & Father's Day",
    timeframe: "Mar - Jun",
    events: ["Mother's Day", "Father's Day prep", "Spring garden"],
    seedKeywords: [
      "mothers day necklace",
      "fathers day gift custom",
      "personalized gardening tools",
      "spring candle",
      "bridal shower gift"
    ]
  },
  2: { // March
    seasonName: "Graduation & Summer Weddings",
    timeframe: "Apr - Jul",
    events: ["Graduation", "Father's Day", "Summer Weddings", "Memorial Day"],
    seedKeywords: [
      "graduation cap custom",
      "fathers day key ring",
      "summer wedding guest book",
      "outdoor patio decor",
      "personalized beach towel"
    ]
  },
  3: { // April
    seasonName: "Summer & Father's Day",
    timeframe: "May - Aug",
    events: ["Summer travel", "Father's Day", "4th of July"],
    seedKeywords: [
      "personalized travel pouch",
      "fathers day leather wallet",
      "4th of july shirt",
      "summer straw bag",
      "custom grill set"
    ]
  },
  4: { // May
    seasonName: "High Summer & Back to school prep",
    timeframe: "Jun - Sept",
    events: ["Summer weddings", "4th of July", "Back to school prep"],
    seedKeywords: [
      "bridesmaid pajamas custom",
      "patriotic decor",
      "personalized pencil case",
      "custom water bottle kids",
      "beach wedding favors"
    ]
  },
  5: { // June
    seasonName: "Late Summer & Back to School",
    timeframe: "Jul - Oct",
    events: ["Back to school", "Late summer wedding", "Halloween prep"],
    seedKeywords: [
      "back to school backpack kids",
      "custom name sticker",
      "fall wedding invitation",
      "halloween bag custom",
      "summer clearance sale"
    ]
  }
};

export function getUpcomingSeasonalContext(currentMonth = new Date().getMonth()) {
  return SEASONAL_PEAKS[currentMonth] || SEASONAL_PEAKS[6]; // default to July (autumn prep)
}
