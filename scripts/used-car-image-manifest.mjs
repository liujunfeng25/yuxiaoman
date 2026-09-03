/**
 * Used-car image identity manifest.
 *
 * This file deliberately binds every catalog model and seeded inventory record
 * to a stable model id. Image tooling must use this mapping instead of assigning
 * files by array position, modulo arithmetic, body style, or visual similarity.
 */
export const USED_CAR_IMAGE_MODELS = Object.freeze([
  { modelId: "model-audi-a4l", displayName: "奥迪 A4L", listingIds: ["used-car-listing-014"] },
  { modelId: "model-audi-a6l", displayName: "奥迪 A6L", listingIds: ["used-car-listing-030"] },
  { modelId: "model-audi-q5l", displayName: "奥迪 Q5L", listingIds: ["used-car-listing-015"] },

  { modelId: "model-bmw-3-series", displayName: "宝马 3系", listingIds: ["used-car-listing-010"] },
  { modelId: "model-bmw-5-series", displayName: "宝马 5系", listingIds: [] },
  { modelId: "model-bmw-x3", displayName: "宝马 X3", listingIds: ["used-car-listing-011"] },

  { modelId: "model-mercedes-c-class", displayName: "奔驰 C级", listingIds: ["used-car-listing-012"] },
  { modelId: "model-mercedes-e-class", displayName: "奔驰 E级", listingIds: ["used-car-listing-028"] },
  { modelId: "model-mercedes-glc", displayName: "奔驰 GLC", listingIds: ["used-car-listing-013"] },

  { modelId: "model-byd-qin-plus", displayName: "比亚迪 秦PLUS DM-i", listingIds: [] },
  { modelId: "model-byd-han", displayName: "比亚迪 汉DM-i", listingIds: ["used-car-listing-006"] },
  { modelId: "model-byd-song-plus", displayName: "比亚迪 宋PLUS DM-i", listingIds: ["used-car-listing-007"] },
  { modelId: "model-byd-tang", displayName: "比亚迪 唐DM-i", listingIds: ["used-car-listing-027"] },
  { modelId: "model-byd-seal", displayName: "比亚迪 海豹06 DM-i", listingIds: [] },

  { modelId: "model-honda-accord", displayName: "本田 雅阁", listingIds: ["used-car-listing-018"] },
  { modelId: "model-honda-crv", displayName: "本田 CR-V", listingIds: ["used-car-listing-019"] },
  { modelId: "model-honda-odyssey", displayName: "本田 奥德赛", listingIds: ["used-car-listing-026"] },

  { modelId: "model-volkswagen-magotan", displayName: "大众 迈腾", listingIds: ["used-car-listing-020"] },
  { modelId: "model-volkswagen-tiguan-l", displayName: "大众 途观L", listingIds: ["used-car-listing-021"] },
  { modelId: "model-volkswagen-id4x", displayName: "大众 ID.4 X", listingIds: [] },

  { modelId: "model-toyota-camry", displayName: "丰田 凯美瑞", listingIds: ["used-car-listing-016"] },
  { modelId: "model-toyota-rav4", displayName: "丰田 RAV4荣放", listingIds: ["used-car-listing-017"] },
  { modelId: "model-toyota-highlander", displayName: "丰田 汉兰达", listingIds: [] },

  { modelId: "model-hongqi-h5", displayName: "红旗 H5", listingIds: [] },
  { modelId: "model-hongqi-hs5", displayName: "红旗 HS5", listingIds: [] },

  { modelId: "model-zeekr-001", displayName: "极氪 001", listingIds: ["used-car-listing-024"] },
  { modelId: "model-zeekr-007", displayName: "极氪 007", listingIds: [] },
  { modelId: "model-zeekr-7x", displayName: "极氪 7X", listingIds: [] },

  { modelId: "model-li-l6", displayName: "理想 L6", listingIds: [] },
  {
    modelId: "model-li-l7",
    displayName: "理想 L7",
    listingIds: [
      "used-car-listing-001",
      "used-car-listing-002",
      "used-car-listing-003",
      "used-car-listing-004",
    ],
  },
  { modelId: "model-li-l8", displayName: "理想 L8", listingIds: ["used-car-listing-005"] },
  { modelId: "model-li-l9", displayName: "理想 L9", listingIds: [] },

  { modelId: "model-tesla-model-3", displayName: "特斯拉 Model 3", listingIds: ["used-car-listing-008"] },
  {
    modelId: "model-tesla-model-y",
    displayName: "特斯拉 Model Y",
    listingIds: ["used-car-listing-009", "used-car-listing-029"],
  },

  { modelId: "model-aito-m5", displayName: "问界 M5", listingIds: [] },
  { modelId: "model-aito-m7", displayName: "问界 M7", listingIds: ["used-car-listing-025"] },
  { modelId: "model-aito-m9", displayName: "问界 M9", listingIds: [] },

  { modelId: "model-nio-et5", displayName: "蔚来 ET5", listingIds: [] },
  { modelId: "model-nio-et5t", displayName: "蔚来 ET5T", listingIds: [] },
  { modelId: "model-nio-es6", displayName: "蔚来 ES6", listingIds: ["used-car-listing-022"] },

  { modelId: "model-xpeng-mona-m03", displayName: "小鹏 MONA M03", listingIds: [] },
  { modelId: "model-xpeng-p7i", displayName: "小鹏 P7i", listingIds: [] },
  { modelId: "model-xpeng-g6", displayName: "小鹏 G6", listingIds: ["used-car-listing-023"] },
  { modelId: "model-xpeng-g9", displayName: "小鹏 G9", listingIds: [] },

  { modelId: "model-xiaomi-su7", displayName: "小米汽车 SU7", listingIds: [] },
  { modelId: "model-xiaomi-yu7", displayName: "小米汽车 YU7", listingIds: [] },
]);

export const USED_CAR_IMAGE_LISTINGS = Object.freeze(
  USED_CAR_IMAGE_MODELS.flatMap((model) =>
    model.listingIds.map((listingId) => ({
      listingId,
      modelId: model.modelId,
      displayName: model.displayName,
    })),
  ).sort((left, right) => left.listingId.localeCompare(right.listingId)),
);

export function validateUsedCarImageManifest() {
  if (USED_CAR_IMAGE_MODELS.length !== 46) {
    throw new Error(`Expected 46 used-car models, found ${USED_CAR_IMAGE_MODELS.length}`);
  }
  if (USED_CAR_IMAGE_LISTINGS.length !== 30) {
    throw new Error(`Expected 30 used-car listings, found ${USED_CAR_IMAGE_LISTINGS.length}`);
  }

  const modelIds = USED_CAR_IMAGE_MODELS.map((model) => model.modelId);
  if (new Set(modelIds).size !== modelIds.length) {
    throw new Error("Used-car image manifest contains duplicate model ids");
  }

  const listingIds = USED_CAR_IMAGE_LISTINGS.map((listing) => listing.listingId);
  if (new Set(listingIds).size !== listingIds.length) {
    throw new Error("Used-car image manifest contains duplicate listing ids");
  }

  const expectedListingIds = Array.from(
    { length: 30 },
    (_, index) => `used-car-listing-${String(index + 1).padStart(3, "0")}`,
  );
  if (listingIds.join("\n") !== expectedListingIds.join("\n")) {
    throw new Error("Used-car image manifest must cover listing ids 001 through 030 exactly once");
  }
}

