import assert from "node:assert/strict";
import test from "node:test";
import { PLATE_CATEGORIES } from "../miniprogram/utils/plate-categories";
import { formatPlateNumber, plateSlotCount } from "../miniprogram/utils/plate-keyboard-layout";

test("11 类车辆编辑往返保留稳定类别、分段号牌、独立动力与可编辑客车颜色", async () => {
  const globals = globalThis as any;
  let definition: any;
  globals.Page = (options: any) => { definition = options; };
  const notices: string[] = [];
  globals.wx = {
    getAccountInfoSync: () => ({ miniProgram: { envVersion: "develop" } }),
    getSystemInfoSync: () => ({ platform: "devtools" }),
    showToast: ({ title }: any) => notices.push(title), setNavigationBarTitle() {}, navigateBack() {},
  };
  const { api } = await import("../miniprogram/services/api");
  await import("../miniprogram/packages/vehicle/pages/vehicle-form/vehicle-form");
  const originals = { vehicleCatalog: api.vehicleCatalog, vehicles: api.vehicles, updateVehicle: api.updateVehicle, createVehicle: api.createVehicle };
  const stored = new Map<string, any>();
  const save = async (id: string, value: any) => {
    const vehicle = { ...stored.get(id), ...value, id, facts: { powertrainSource: "vehicle_profile" } };
    stored.set(id, vehicle); return vehicle;
  };
  api.vehicleCatalog = async () => ({ brands: [] }) as any;
  api.vehicles = async () => [...stored.values()];
  api.createVehicle = async (value) => save(`car-${stored.size}`, value);
  api.updateVehicle = save;
  const page = () => ({ ...definition, data: structuredClone(definition.data), setData(patch: any) { Object.assign(this.data, patch); } });
  const choose = (instance: any, value: string) => instance.choosePowertrain({ currentTarget: { dataset: { value } } });
  const setPlate = (instance: any, raw: string) => {
    const value = formatPlateNumber(raw);
    instance.onPlateKeyboardChange({ detail: { value, complete: true } });
  };
  try {
    assert.equal(definition.data.plateCategories.length, 11);
    assert.deepEqual(definition.data.plateCategories.map((item: any) => item.label), [
      "蓝牌小型普通客车", "新能源小型普通客车", "蓝牌小型货车", "新能源小型货车",
      "黄牌大型普通客车", "新能源大型普通客车", "黄牌大型牵引车", "新能源大型牵引车",
      "黄牌挂车", "黄牌大型货车", "新能源大型货车",
    ]);
    for (const [index, category] of PLATE_CATEGORIES.entries()) {
      const form = page();
      form.categoryChange({ detail: { value: index } });
      assert.equal(form.data.slotCount, plateSlotCount(category.plateKind), category.label);
      assert.equal(form.data.plateNumber, "");
      assert.equal(form.data.plateComplete, false);
      const plateNumber = category.code === "yellow_trailer"
        ? formatPlateNumber(`津A${String(1000 + index).slice(-4)}挂`)
        : plateSlotCount(category.plateKind) === 8
          ? formatPlateNumber(`津AD${String(10000 + index).slice(-5)}`)
          : formatPlateNumber(`津A${String(10000 + index).slice(-5)}`);
      setPlate(form, plateNumber);
      assert.equal(form.data.plateComplete, true, category.label);
      choose(form, "phev");
      form.usageNatureInput({ detail: { value: "非营运" } });
      form.vehicleTypeInput({ detail: { value: category.vehicleType + "（自填）" } });
      if (category.vehicleClassCode === "passenger_car" || category.vehicleClassCode === "large_bus") {
        form.chooseExteriorColor({ currentTarget: { dataset: { value: "白色" } } });
        form.exteriorColorInput({ detail: { value: `珍珠白双色${index}` } });
      }
      await form.submit();
      const vehicle = [...stored.values()][index];
      assert.equal(vehicle.plateCategory, category.code);
      assert.equal(vehicle.powertrainType, "phev");
      assert.equal(vehicle.plateNumber, plateNumber);
      assert.equal(vehicle.seats, category.defaultSeats);
      assert.equal(vehicle.exteriorColor,
        category.vehicleClassCode === "passenger_car" || category.vehicleClassCode === "large_bus"
          ? `珍珠白双色${index}`
          : null);
      const edit = page();
      await edit.onLoad({ id: vehicle.id });
      assert.equal(edit.data.plateCategory, category.code);
      assert.equal(edit.data.mode, category.plateKind);
      assert.equal(edit.data.slotCount, plateSlotCount(category.plateKind));
      assert.equal(edit.data.plateNumber, vehicle.plateNumber);
      assert.equal(edit.data.powertrainType, "phev");
      assert.equal(edit.data.exteriorColor, vehicle.exteriorColor || "");
      choose(edit, "pure_electric");
      const nextPlate = plateSlotCount(edit.data.mode) === 8
        ? formatPlateNumber(`津BF${String(20000 + index).slice(-5)}`)
        : formatPlateNumber(`津B${String(20000 + index).slice(-5)}`);
      setPlate(edit, nextPlate);
      await edit.submit();
      assert.equal(stored.get(vehicle.id).powertrainType, "pure_electric");
      assert.equal(stored.get(vehicle.id).plateNumber, nextPlate);
    }
    const form = page();
    setPlate(form, "津AIO2345");
    choose(form, "diesel");
    form.categoryChange({ detail: { value: 10 } });
    assert.equal(form.data.plateNumber, "");
    assert.equal(form.data.plateComplete, false);
    assert.equal(form.data.powertrainType, "diesel");
    assert.equal(form.data.slotCount, 8);
    await form.submit();
    assert.ok(notices.includes("请输入车牌号"));
    form.setData({ plateNumber: "津A<script>", plateComplete: true, plateCategoryConfirmed: true });
    await form.submit();
    assert.ok(notices.includes("请只填写实际号牌中的文字、字母、数字或分隔符"));
    const missingPowertrain = page();
    missingPowertrain.categoryChange({ detail: { value: 0 } });
    missingPowertrain.onPlateKeyboardChange({ detail: { value: formatPlateNumber("津A12345"), complete: true } });
    missingPowertrain.usageNatureInput({ detail: { value: "非营运" } });
    missingPowertrain.vehicleTypeInput({ detail: { value: "小型普通客车" } });
    missingPowertrain.setData({ powertrainType: "unknown", powertrainTouched: false });
    await missingPowertrain.submit();
    assert.ok(notices.includes("请选择动力类型"));
    assert.equal(missingPowertrain.data.saving, false);
  } finally {
    Object.assign(api, originals);
    delete globals.Page; delete globals.wx;
  }
});
