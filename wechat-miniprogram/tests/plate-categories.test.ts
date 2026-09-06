import assert from "node:assert/strict";
import test from "node:test";
import { PLATE_CATEGORIES } from "../miniprogram/utils/plate-categories";

test("11 类车辆编辑往返保留稳定类别、自由号牌、独立动力与可编辑客车颜色", async () => {
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
      const plateNumber = index === 0
        ? "京使1234"
        : category.code === "yellow_trailer"
          ? `津${index}临时挂`
          : `津${index}A${index % 2 ? "D" : "F"}特别号`;
      form.plateNumberInput({ detail: { value: plateNumber } });
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
      assert.equal(edit.data.plateNumber, vehicle.plateNumber);
      assert.equal(edit.data.powertrainType, "phev");
      assert.equal(edit.data.exteriorColor, vehicle.exteriorColor || "");
      choose(edit, "pure_electric");
      edit.plateNumberInput({ detail: { value: `WJ${index}-D${index}F` } });
      await edit.submit();
      assert.equal(stored.get(vehicle.id).powertrainType, "pure_electric");
      assert.equal(stored.get(vehicle.id).plateNumber, `WJ${index}-D${index}F`);
    }
    const form = page();
    form.plateNumberInput({ detail: { value: "津AIO2345" } });
    choose(form, "diesel");
    form.categoryChange({ detail: { value: 10 } });
    assert.equal(form.data.plateNumber, "津AIO2345");
    assert.equal(form.data.powertrainType, "diesel");
    form.plateNumberInput({ detail: { value: "" } });
    await form.submit();
    assert.ok(notices.includes("请输入车牌号"));
    form.plateNumberInput({ detail: { value: "津A<script>" } });
    await form.submit();
    assert.ok(notices.includes("请只填写实际号牌中的文字、字母、数字或分隔符"));
  } finally {
    Object.assign(api, originals);
    delete globals.Page; delete globals.wx;
  }
});
