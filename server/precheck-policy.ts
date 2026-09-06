export const precheckGuidance = [
  { code: "license_unclear", label: "行驶证模糊或缺页", action: "materials", effect: "补拍清晰的行驶证资料，重新提交本站审核；不会推荐维修。" },
  { code: "vehicle_photos_incomplete", label: "车辆照片不完整或不清晰", action: "materials", effect: "补充对应照片，重新提交本站审核；不会推荐维修。" },
  { code: "vehicle_information_mismatch", label: "车牌或车辆信息不一致", action: "materials", effect: "核对车辆与照片；涉及车辆身份或计价信息变更时，由车主退款后重新预约。" },
  { code: "booking_information_mismatch", label: "预约车型、动力或用途不一致", action: "materials", effect: "核对预约资料；需要更换车型或计价条件时，由车主退款后重新预约。" },
  { code: "materials_cannot_be_verified", label: "现有资料无法完成核对", action: "materials", effect: "说明无法核对的内容，车主补充资料后再审。" },
  { code: "body_dirty", label: "车身脏污，需清洁后核对", action: "wash", effect: "向车主提供附近洗车店和套餐入口，不竞价；清洁后补拍照片再审。" },
  { code: "body_damage", label: "车损需要进一步处理或核对", action: "repair", effect: "车主可授权发起多店维修咨询报价，也可自行处理；处理后提交照片再审。普通外观划痕不应直接作为退回依据。" },
  { code: "dashboard_warning", label: "仪表盘故障灯，需维修核对", action: "repair", effect: "直接进入维修报价，与车损一并由车主选择门店。门店须注明需要到店检测后确认的项目与费用，不能仅凭照片确定故障原因。" },
  { code: "other", label: "其他待核对问题", action: "materials", effect: "写明具体问题和补充要求；不自动推荐商业服务。" },
] as const;

export type PrecheckAction = typeof precheckGuidance[number]["action"];
export function precheckAction(code: string): PrecheckAction {
  return precheckGuidance.find((item) => item.code === code)?.action ?? "materials";
}
export const precheckVehiclePhotoKinds = ["vehicle_front_left", "vehicle_front_right", "vehicle_rear_left", "vehicle_rear_right", "dashboard_started"];

export const bookingPrecheckMediaKinds = [
  "license_front",
  "license_back",
  ...precheckVehiclePhotoKinds,
] as const;
