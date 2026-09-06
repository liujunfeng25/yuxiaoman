/**
 * Owner vehicle identity catalog: common China-market series, including older cars.
 * These are series names, not model years, trims, sale status or pricing facts.
 * IDs are persisted on vehicles: never derive them from array order or rename them.
 * Maintenance notes and reference sources: docs/vehicle-catalog.md.
 */
export type CatalogVehicleClassCode =
  | "passenger_car"
  | "small_truck"
  | "large_bus"
  | "large_tractor"
  | "trailer"
  | "large_truck";

export type VehicleBrandSeed = {
  id: string;
  name: string;
  keywords: string[];
  /** Explicit stable model slug:name pairs, separated by |. */
  models: string;
  /** Existing passenger-car seeds default to passenger_car. */
  vehicleClassCodes?: CatalogVehicleClassCode[];
  /** Optional per-model override, keyed by the stable model slug. */
  modelVehicleClassCodes?: Record<string, CatalogVehicleClassCode[]>;
};

export const VEHICLE_BRAND_SEEDS: VehicleBrandSeed[] = [
  { id: "mercedes", name: "奔驰", keywords: ["benz", "benchi", "梅赛德斯"], models:
    "s:S级|e:E级|glc:GLC|a:A级|b:B级|c:C级|cla:CLA|cls:CLS|gla:GLA|glb:GLB|gle:GLE|gls:GLS|g:G级|v:V级|vito:威霆|eqc:EQC|eqa:EQA|eqb:EQB|eqe:EQE|eqe-suv:EQE SUV|eqs:EQS|eqs-suv:EQS SUV|sl:SL|slc:SLC|slk:SLK|glk:GLK|ml:ML级|gl:GL级|r:R级|amg-gt:AMG GT" },
  { id: "bmw", name: "宝马", keywords: ["baoma"], models:
    "3:3系|5:5系|x3:X3|1:1系|2:2系|4:4系|6:6系|7:7系|8:8系|x1:X1|x2:X2|x4:X4|x5:X5|x6:X6|x7:X7|z4:Z4|i3:i3|i4:i4|i5:i5|i7:i7|ix:iX|ix1:iX1|ix3:iX3|i8:i8|m2:M2|m3:M3|m4:M4|m5:M5|xm:XM" },
  { id: "audi", name: "奥迪", keywords: ["aodi"], models:
    "a4l:A4L|a6l:A6L|q5l:Q5L|a1:A1|a3:A3|a4:A4|a5:A5|a5l:A5L|a6:A6|a7:A7|a7l:A7L|a8l:A8L|q2l:Q2L|q3:Q3|q5:Q5|q6:Q6|q7:Q7|q8:Q8|q4-e-tron:Q4 e-tron|q5-e-tron:Q5 e-tron|q6l-e-tron:Q6L e-tron|e-tron:e-tron|e-tron-gt:e-tron GT|tt:TT|r8:R8|s3:S3|s4:S4|s5:S5|s6:S6|s7:S7|rs3:RS 3|rs4:RS 4|rs5:RS 5|rs6:RS 6|rs7:RS 7" },
  { id: "tesla", name: "特斯拉", keywords: ["tesila"], models:
    "model-y:Model Y|model-3:Model 3|model-s:Model S|model-x:Model X|model-yl:Model Y L" },
  { id: "byd", name: "比亚迪", keywords: ["biyadi"], models:
    "han:汉|han-l:汉L|qin:秦|qin-pro:秦Pro|qin-plus:秦PLUS|qin-l:秦L|tang:唐|tang-l:唐L|song:宋|song-pro:宋Pro|song-plus:宋PLUS|song-l:宋L|song-max:宋MAX|yuan:元|yuan-pro:元Pro|yuan-plus:元PLUS|yuan-up:元UP|seagull:海鸥|dolphin:海豚|seal:海豹|seal-05:海豹05|seal-06:海豹06|seal-07:海豹07|sealion-05:海狮05|sealion-06:海狮06|sealion-07:海狮07|destroyer-05:驱逐舰05|frigate-07:护卫舰07|xia:夏|e1:e1|e2:e2|e3:e3|e5:e5|e6:e6|f0:F0|f3:F3|f6:F6|g3:G3|g6:G6|l3:L3|s6:S6|s7:S7|surui:速锐|sirui:思锐" },
  { id: "li", name: "理想", keywords: ["lixiang", "li auto"], models:
    "l7:L7|l6:L6|l8:L8|l9:L9|one:ONE|mega:MEGA|i6:i6|i8:i8" },
  { id: "volkswagen", name: "大众", keywords: ["vw", "dazhong", "一汽大众", "上汽大众"], models:
    "lavida:朗逸|sagitar:速腾|bora:宝来|magotan:迈腾|passat:帕萨特|golf:高尔夫|polo:Polo|lamando:凌渡|santana:桑塔纳|jetta:捷达|cc:CC|phaeton:辉腾|phideon:辉昂|beetle:甲壳虫|tiguan:途观|tiguan-l:途观L|tiguan-x:途观X|tharu:途岳|t-cross:途铠|teramont:途昂|teramont-x:途昂X|tayron:探岳|tayron-x:探岳X|t-roc:探歌|tacqua:探影|talagon:揽境|tavendor:揽巡|touareg:途锐|touran:途安|touran-l:途安L|viloran:威然|sharan:夏朗|multivan:迈特威|caravelle:凯路威|variant:蔚揽|id3:ID.3|id4x:ID.4 X|id4-crozz:ID.4 CROZZ|id6x:ID.6 X|id6-crozz:ID.6 CROZZ|id7-vizzion:ID.7 VIZZION|id-unyx:ID.与众" },
  { id: "toyota", name: "丰田", keywords: ["fengtian", "一汽丰田", "广汽丰田"], models:
    "corolla:卡罗拉|levin:雷凌|camry:凯美瑞|avalon:亚洲龙|allion:亚洲狮|ling-shang:凌尚|crown:皇冠|crown-sportcross:皇冠SportCross|vios:威驰|yaris-l:致炫|yaris-l-sedan:致享|yaris:雅力士|corolla-cross:卡罗拉锐放|frontlander:锋兰达|rav4:RAV4荣放|wildlander:威兰达|highlander:汉兰达|crown-kluger:皇冠陆放|c-hr:C-HR|izoa:奕泽IZOA|prado:普拉多|land-cruiser:兰德酷路泽|sequoia:红杉|fj-cruiser:FJ酷路泽|sienna:赛那|granvia:格瑞维亚|alphard:埃尔法|vellfire:威尔法|previa:普瑞维亚|hiace:海狮|coaster:柯斯达|86:86|supra:Supra|bz4x:bZ4X|bz3:bZ3|bz3x:铂智3X|bz4x-bozhi:铂智4X|bz5:bZ5" },
  { id: "honda", name: "本田", keywords: ["bentian", "广汽本田", "东风本田"], models:
    "accord:雅阁|civic:思域|integra:型格|crider:凌派|envix:享域|city:锋范|greiz:哥瑞|gienia:竞瑞|fit:飞度|jazz:爵士|crv:CR-V|breeze:皓影|xrv:XR-V|vezel:缤智|urv:UR-V|avancier:冠道|hrv:HR-V|zrv:ZR-V致在|odyssey:奥德赛|elysion:艾力绅|inspire:英仕派|spirior:思铂睿|crosstour:歌诗图|ens1:e:NS1|enp1:e:NP1极湃1|ens2:e:NS2|enp2:e:NP2极湃2|s7:烨S7|p7:烨P7" },
  { id: "nissan", name: "日产", keywords: ["richan", "东风日产", "尼桑"], models:
    "sylphy:轩逸|teana:天籁|tiida:骐达|livina:骊威|sunny:阳光|lannia:蓝鸟|qashqai:逍客|x-trail:奇骏|kicks:劲客|murano:楼兰|pathfinder:探陆|terra:途达|paladin:帕拉丁|patrol:途乐|quest:贵士|nv200:NV200|march:玛驰|maxima:西玛|ariya:ARIYA艾睿雅|n7:N7|370z:370Z|gtr:GT-R|d22:D22|navara:纳瓦拉" },
  { id: "buick", name: "别克", keywords: ["bieke"], models:
    "excelle:凯越|excelle-gt:英朗|excelle-xt:英朗XT|verano:威朗|regal:君威|lacrosse:君越|gl6:GL6|gl8:GL8|century:世纪|encore:昂科拉|encore-gx:昂科拉GX|envision:昂科威|envision-s:昂科威S|envision-plus:昂科威Plus|enclave:昂科旗|enclave-import:昂科雷|velite5:VELITE 5|velite6:微蓝6|velite7:微蓝7|electra-e4:Electra E4|electra-e5:Electra E5" },
  { id: "chevrolet", name: "雪佛兰", keywords: ["xuefolan"], models:
    "cruze:科鲁兹|monza:科鲁泽|cavalier:科沃兹|malibu:迈锐宝|malibu-xl:迈锐宝XL|sail:赛欧|aveo:爱唯欧|lova:乐风|lovo:乐骋|epica:景程|trax:创酷|trailblazer:创界|equinox:探界者|blazer:开拓者|captiva:科帕奇|orlando:沃兰多|camaro:科迈罗|spark:乐驰|tahoe:太浩" },
  { id: "ford", name: "福特", keywords: ["fute", "长安福特", "江铃福特"], models:
    "focus:福克斯|escort:福睿斯|mondeo:蒙迪欧|taurus:金牛座|fiesta:嘉年华|kuga:翼虎|ecosport:翼搏|escape:锐际|edge:锐界|edge-l:锐界L|explorer:探险者|evos:EVOS追光者|equator:领裕|equator-sport:领睿|territory:领界|everest:撼路者|bronco:烈马|mustang:Mustang|mustang-mach-e:电马|s-max:麦柯斯|transit:全顺|tourneo:途睿欧|f150:F-150|ranger:Ranger" },
  { id: "hyundai", name: "现代", keywords: ["xiandai", "北京现代"], models:
    "elantra:伊兰特|elantra-langdong:朗动|elantra-lingdong:领动|elantra-yuedong:悦动|sonata:索纳塔|moinca:名驭|mistra:名图|accent:雅绅特|verna:瑞纳|celesta:悦纳|lafesta:菲斯塔|tucson:途胜|ix35:ix35|ix25:ix25|santa-fe:胜达|custo:库斯途|palisade:帕里斯帝|mufasa:沐飒|encino:昂希诺|veloster:飞思|genesis-coupe:劳恩斯酷派|ioniq5:IONIQ 5|ioniq6:IONIQ 6" },
  { id: "kia", name: "起亚", keywords: ["qiya"], models:
    "k2:K2|k3:K3|k4:K4|k5:K5|kxcross:KX CROSS|kx1:奕跑|kx3:傲跑|kx5:KX5|kx7:KX7|sportage:狮跑|sportage-r:智跑|sportage-ace:狮铂拓界|seltos:赛图斯|sorento:索兰托|carnival:嘉华|forte:福瑞迪|cerato:赛拉图|rio:锐欧|soul:秀尔|carens:佳乐|stinger:斯汀格|ev5:EV5|ev6:EV6" },
  { id: "mazda", name: "马自达", keywords: ["mazida"], models:
    "3:马自达3|3-axela:昂克赛拉|6:马自达6|atenza:阿特兹|6-ruiyi:睿翼|2:马自达2|5:马自达5|8:马自达8|cx3:CX-3|cx4:CX-4|cx5:CX-5|cx7:CX-7|cx8:CX-8|cx30:CX-30|cx50:CX-50行也|ez6:EZ-6|ez60:EZ-60|mx5:MX-5|rx8:RX-8" },
  { id: "peugeot", name: "标致", keywords: ["biaozhi", "东风标致"], models:
    "206:206|207:207|301:301|307:307|308:308|308s:308S|408:408|408x:408X|508:508|508l:508L|2008:2008|3008:3008|4008:4008|5008:5008|rcz:RCZ|e2008:e-2008" },
  { id: "citroen", name: "雪铁龙", keywords: ["xuetielong", "东风雪铁龙"], models:
    "c2:C2|c3xr:C3-XR|c4l:C4L|c4-quatre:世嘉|c4-cquatre:C4世嘉|c5:C5|c6:C6|c5x:凡尔赛C5 X|c5-aircross:天逸C5 AIRCROSS|c4-aircross:云逸C4 AIRCROSS|elysee:爱丽舍|fukang:富康|xsara:赛纳|picasso:毕加索|c4-picasso:C4 PICASSO" },
  { id: "skoda", name: "斯柯达", keywords: ["sikeda"], models:
    "octavia:明锐|superb:速派|superb-haorui:昊锐|rapid:昕锐|spaceback:昕动|fabia:晶锐|kamiq:柯米克|kamiq-gt:柯米克GT|karoq:柯珞克|kodiaq:柯迪亚克|kodiaq-gt:柯迪亚克GT|yeti:野帝" },
  { id: "jetta", name: "捷达", keywords: ["jieda"], models: "va3:VA3|va7:VA7|vs5:VS5|vs7:VS7" },
  { id: "mitsubishi", name: "三菱", keywords: ["sanling"], models:
    "outlander:欧蓝德|asx:劲炫ASX|eclipse-cross:奕歌|pajero:帕杰罗|pajero-sport:帕杰罗·劲畅|lancer:蓝瑟|lancer-ex:翼神|galant:戈蓝|grandis:格蓝迪|zinger:君阁|airtrek:阿图柯" },
  { id: "suzuki", name: "铃木", keywords: ["lingmu"], models:
    "swift:雨燕|alto:奥拓|s-cross:骁途|sx4:天语SX4|s-cross-fengyu:锋驭|vitara:维特拉|grand-vitara:超级维特拉|jimny:吉姆尼|alivio:启悦|liana:利亚纳|beidouxing:北斗星|kizashi:凯泽西|wagon-r:浪迪" },
  { id: "subaru", name: "斯巴鲁", keywords: ["sibalu"], models:
    "forester:森林人|outback:傲虎|xv:XV|crosstrek:旭豹|legacy:力狮|impreza:翼豹|brz:BRZ|tribeca:驰鹏|wrx:WRX" },
  { id: "renault", name: "雷诺", keywords: ["leinuo"], models:
    "koleos:科雷傲|kadjar:科雷嘉|captur:卡缤|city-kze:雷诺 e诺|fluence:风朗|latitude:纬度|laguna:拉古那|scenic:风景|espace:Espace|megane:梅甘娜" },
  { id: "volvo", name: "沃尔沃", keywords: ["woerwo"], models:
    "s60:S60|s60l:S60L|s90:S90|s40:S40|s80:S80|s80l:S80L|v40:V40|v60:V60|v90:V90|xc40:XC40|xc60:XC60|xc90:XC90|c30:C30|c40:C40|c70:C70|ex30:EX30|ex90:EX90|em90:EM90" },
  { id: "cadillac", name: "凯迪拉克", keywords: ["kaidilake"], models:
    "ct4:CT4|ct5:CT5|ct6:CT6|ats:ATS|atsl:ATS-L|xts:XTS|cts:CTS|srx:SRX|xt4:XT4|xt5:XT5|xt6:XT6|escalade:凯雷德|lyriq:LYRIQ锐歌|optiq:IQ傲歌|dts:DTS|sls:赛威" },
  { id: "lexus", name: "雷克萨斯", keywords: ["leikesasi", "凌志"], models:
    "es:ES|is:IS|ls:LS|gs:GS|ct:CT|ux:UX|nx:NX|rx:RX|gx:GX|lx:LX|lm:LM|rz:RZ|rc:RC|lc:LC|sc:SC" },
  { id: "lincoln", name: "林肯", keywords: ["linken"], models:
    "z:林肯Z|mkz:MKZ|continental:大陆|corsair:冒险家|nautilus:航海家|aviator:飞行家|navigator:领航员|mkc:MKC|mkx:MKX|mkt:MKT" },
  { id: "infiniti", name: "英菲尼迪", keywords: ["yingfeinidi"], models:
    "q50:Q50|q50l:Q50L|q60:Q60|q70:Q70|qx30:QX30|qx50:QX50|qx55:QX55|qx60:QX60|qx70:QX70|qx80:QX80|g:G系|m:M系|ex:EX|fx:FX|jx:JX" },
  { id: "acura", name: "讴歌", keywords: ["ouge"], models: "cdx:CDX|rdx:RDX|mdx:MDX|tlx:TLX|tlxl:TLX-L|ilx:ILX|tl:TL|rl:RL|rlx:RLX|zdx:ZDX|nsx:NSX" },
  { id: "land-rover", name: "路虎", keywords: ["luhu", "landrover"], models:
    "range-rover:揽胜|range-rover-sport:揽胜运动版|velar:揽胜星脉|evoque:揽胜极光|discovery:发现|discovery-sport:发现运动版|discovery-shenxing:发现神行|freelander2:神行者2|defender:卫士" },
  { id: "jaguar", name: "捷豹", keywords: ["jiebao"], models: "xe:XE|xel:XEL|xf:XF|xfl:XFL|xj:XJ|fpace:F-PACE|epace:E-PACE|ipace:I-PACE|ftype:F-TYPE|xk:XK" },
  { id: "porsche", name: "保时捷", keywords: ["baoshijie"], models: "911:911|718:718|cayenne:Cayenne|macan:Macan|panamera:Panamera|taycan:Taycan|boxster:Boxster|cayman:Cayman" },
  { id: "mini", name: "MINI", keywords: ["迷你"], models: "hatch:MINI|clubman:CLUBMAN|countryman:COUNTRYMAN|paceman:PACEMAN|coupe:COUPE|roadster:ROADSTER|aceman:ACEMAN|cooper-electric:电动MINI COOPER" },
  { id: "smart", name: "smart", keywords: ["精灵"], models: "fortwo:fortwo|forfour:forfour|1:精灵#1|3:精灵#3|5:精灵#5" },
  { id: "jeep", name: "Jeep", keywords: ["吉普"], models: "wrangler:牧马人|grand-cherokee:大切诺基|cherokee:自由光|compass:指南者|renegade:自由侠|commander:指挥官|grand-commander:大指挥官|patriot:自由客|gladiator:角斗士" },
  { id: "geely", name: "吉利", keywords: ["jili"], models:
    "emgrand:帝豪|emgrand-gl:帝豪GL|emgrand-gs:帝豪GS|emgrand-l:帝豪L|preface:星瑞|preface-l:星瑞L|xingyue:星越|xingyue-l:星越L|boyue:博越|boyue-l:博越L|boyue-cool:博越COOL|binyue:缤越|binrui:缤瑞|haoyue:豪越|haoyue-l:豪越L|icon:ICON|borui:博瑞|vision:远景|vision-x3:远景X3|vision-x6:远景X6|vision-s1:远景S1|jiaji:嘉际|panda:熊猫|gx7:GX7|gc7:GC7|kingkong:金刚|freedom-ship:自由舰|gx2:全球鹰GX2" },
  { id: "geely-galaxy", name: "吉利银河", keywords: ["yinhe", "galaxy", "jiliyinhe"], models:
    "l6:L6|l7:L7|e5:E5|e8:E8|starship7:星舰7|starshine8:星耀8|starshine6:星耀6|m9:M9|xingyuan:星愿|a7:A7" },
  { id: "lynk", name: "领克", keywords: ["lingke", "lynkco"], models: "01:01|02:02|03:03|05:05|06:06|07:07|08:08|09:09|10:10|900:900|z10:Z10|z20:Z20" },
  { id: "zeekr", name: "极氪", keywords: ["jike"], models: "001:001|007:007|009:009|7x:7X|x:X|mix:MIX|007gt:007 GT|9x:9X" },
  { id: "changan", name: "长安", keywords: ["changan"], models:
    "eado:逸动|eado-plus:逸动PLUS|eado-xt:逸动XT|alsvin:悦翔|raeton:睿骋|raeton-cc:睿骋CC|raeton-ruicheng-cc:锐程CC|raeton-plus:锐程PLUS|benben:奔奔|benben-ev:奔奔EV|benben-estar:奔奔E-Star|lumin:Lumin|cs15:CS15|cs35:CS35|cs35-plus:CS35 PLUS|cs55:CS55|cs55-plus:CS55 PLUS|cs75:CS75|cs75-plus:CS75 PLUS|cs85:CS85 COUPE|cs95:CS95|uni-t:UNI-T|uni-k:UNI-K|uni-v:UNI-V|x5-plus:X5 PLUS|x7-plus:X7 PLUS|hunter:猎手|f70:凯程F70" },
  { id: "changan-qiyuan", name: "长安启源", keywords: ["qiyuan", "changanqiyuan"], models: "a05:A05|a06:A06|a07:A07|q05:Q05|q07:Q07|e07:E07" },
  { id: "deepal", name: "深蓝", keywords: ["shenlan", "长安深蓝"], models: "sl03:SL03|s7:S7|s07:S07|l07:L07|s05:S05|g318:G318|s09:S09" },
  { id: "avatr", name: "阿维塔", keywords: ["aweita"], models: "11:11|12:12|07:07|06:06" },
  { id: "changan-oushang", name: "长安欧尚", keywords: ["oushang"], models: "x5:X5|x5-plus:X5 PLUS|x7:X7|x7-plus:X7 PLUS|z6:Z6|a600:A600|a800:A800|cos1:科赛|cos3:科赛3|cos5:科赛5|cos-pro:科赛Pro|cx70:CX70|cx70t:CX70T" },
  { id: "chery", name: "奇瑞", keywords: ["qirui"], models:
    "tiggo3:瑞虎3|tiggo3x:瑞虎3x|tiggo5:瑞虎5|tiggo5x:瑞虎5x|tiggo7:瑞虎7|tiggo7-plus:瑞虎7 PLUS|tiggo7-pro:瑞虎7 PRO|tiggo8:瑞虎8|tiggo8-plus:瑞虎8 PLUS|tiggo8-pro:瑞虎8 PRO|tiggo8l:瑞虎8L|tiggo9:瑞虎9|arrizo3:艾瑞泽3|arrizo5:艾瑞泽5|arrizo5-plus:艾瑞泽5 PLUS|arrizo5-gt:艾瑞泽5 GT|arrizo7:艾瑞泽7|arrizo8:艾瑞泽8|arrizo-gx:艾瑞泽GX|qq:QQ|qq-icecream:QQ冰淇淋|eq1:小蚂蚁|eq:奇瑞eQ|eq7:舒享家|ant:大蚂蚁|fulwin2:风云2|a3:A3|e3:E3|e5:E5|cowin1:旗云1|cowin2:旗云2|cowin3:旗云3|eastar:东方之子" },
  { id: "chery-fulwin", name: "奇瑞风云", keywords: ["fengyun", "fulwin"], models: "a8:A8|a9l:A9L|t6:T6|t8:T8|t9:T9|t10:T10|x3:风云X3" },
  { id: "exeed", name: "星途", keywords: ["xingtu"], models: "lx:追风|tx:TX|txl:凌云|vx:揽月|rx:瑶光|es:星纪元ES|et:星纪元ET|et5:ET5" },
  { id: "jetour", name: "捷途", keywords: ["jietu"], models: "x70:X70|x70-plus:X70 PLUS|x70m:X70M|x70s:X70S|x90:X90|x90-plus:X90 PLUS|x95:X95|dashing:大圣|traveller:旅行者|shanhai-t1:山海T1|shanhai-t2:山海T2|shanhai-l6:山海L6|shanhai-l7:山海L7|shanhai-l9:山海L9|freedom:自由者" },
  { id: "icar", name: "iCAR", keywords: ["奇瑞iCAR"], models: "03:03|03t:03T|v23:V23" },
  { id: "haval", name: "哈弗", keywords: ["hafu", "长城哈弗"], models: "h1:H1|h2:H2|h2s:H2s|h4:H4|h5:H5|h6:H6|h6-coupe:H6 Coupe|h6s:H6S|h7:H7|h8:H8|h9:H9|f5:F5|f7:F7|f7x:F7x|m6:M6|dagou:大狗|dagou2:二代大狗|chitu:赤兔|shenshou:神兽|kugou:酷狗|xiaolong:枭龙|xiaolong-max:枭龙MAX|raptor:猛龙" },
  { id: "wey", name: "魏牌", keywords: ["weipai", "魏派", "长城魏牌"], models: "vv5:VV5|vv6:VV6|vv7:VV7|p8:P8|mocha:摩卡|latte:拿铁|macchiato:玛奇朵|blue-mountain:蓝山|gaoshan:高山" },
  { id: "tank", name: "坦克", keywords: ["tanke", "长城坦克"], models: "300:300|400:400|500:500|700:700" },
  { id: "ora", name: "欧拉", keywords: ["oula", "长城欧拉"], models: "good-cat:好猫|ballet-cat:芭蕾猫|lightning-cat:闪电猫|black-cat:黑猫|white-cat:白猫|iq:iQ" },
  { id: "great-wall", name: "长城", keywords: ["changcheng", "gwm"], models: "poer:炮|kingkong-poer:金刚炮|shanhai-poer:山海炮|wingle5:风骏5|wingle6:风骏6|wingle7:风骏7|voleex-c30:腾翼C30|voleex-c50:腾翼C50|florid:炫丽|coolbear:酷熊|peri:精灵|v80:嘉誉" },
  { id: "trumpchi", name: "广汽传祺", keywords: ["gac", "chuanqi", "guangqichuanqi"], models: "ga3:GA3|ga3s:GA3S视界|ga4:GA4|ga5:GA5|ga6:GA6|ga8:GA8|gs3:GS3|gs4:GS4|gs4-plus:GS4 PLUS|gs5:GS5|gs7:GS7|gs8:GS8|m6:M6|m8:M8|e8:E8|e9:E9|empow:影豹|emkoo:影酷|s7:S7|s9:S9" },
  { id: "aion", name: "广汽埃安", keywords: ["aian", "gac aion", "guangqiaian"], models: "s:AION S|s-plus:AION S Plus|s-max:AION S MAX|y:AION Y|y-plus:AION Y Plus|v:AION V|lx:AION LX|rt:AION RT|ut:AION UT|i60:i60" },
  { id: "hyptec", name: "昊铂", keywords: ["haobo", "hyper"], models: "gt:GT|ht:HT|ssr:SSR|hl:HL" },
  { id: "roewe", name: "荣威", keywords: ["rongwei"], models: "i5:i5|i6:i6|i6max:i6 MAX|ei5:Ei5|ei6:ei6|350:350|360:360|550:550|750:750|950:950|rx3:RX3|rx5:RX5|rx5plus:RX5 PLUS|rx5max:RX5 MAX|rx8:RX8|rx9:RX9|imax8:iMAX8|d5x:D5X|d6:D6|d7:D7|e50:E50|w5:W5" },
  { id: "mg", name: "名爵", keywords: ["mingjue"], models: "3:MG3|3sw:MG3 SW|5:MG5|6:MG6|7:MG7|gt:锐行|gs:锐腾|zs:ZS|hs:HS|one:ONE|linghang:领航|4:MG4|mulan:木兰|cyberster:Cyberster|tf:TF" },
  { id: "wuling", name: "五菱", keywords: ["wuling"], models: "hongguang:宏光|hongguang-s:宏光S|hongguang-s1:宏光S1|hongguang-s3:宏光S3|hongguang-plus:宏光PLUS|hongguang-mini:宏光MINIEV|hongguang-v:宏光V|bingo:缤果|bingo-plus:缤果PLUS|starlight:星光|starlight-s:星光S|starlight-730:星光730|xingchi:星驰|xingchen:星辰|xingyun:星云|jiachen:佳辰|kaijie:凯捷|zhiguang:之光|rongguang:荣光|rongguang-v:荣光V|zhengcheng:征程|zhengtu:征途|air-ev:Air ev晴空" },
  { id: "baojun", name: "宝骏", keywords: ["baojun"], models: "310:310|310w:310W|510:510|530:530|560:560|610:610|630:630|730:730|rs3:RS-3|rs5:RS-5|rm5:RM-5|rc5:RC-5|rc6:RC-6|e100:E100|e200:E200|e300:E300|kiwi:KiWi EV|yep:悦也|yep-plus:悦也Plus|cloud:云朵|yunhai:云海|xiangjing:享境" },
  { id: "hongqi", name: "红旗", keywords: ["hongqi"], models: "h5:H5|h6:H6|h7:H7|h9:H9|hs3:HS3|hs5:HS5|hs7:HS7|ehs3:E-HS3|ehs9:E-HS9|eqm5:E-QM5|eh7:EH7|ehs7:EHS7|hq9:HQ9|l5:L5|guoya:国雅|tiangong05:天工05|tiangong08:天工08" },
  { id: "bestune", name: "奔腾", keywords: ["benteng", "besturn"], models: "b30:B30|b50:B50|b70:B70|b90:B90|x40:X40|x80:X80|t33:T33|t55:T55|t77:T77|t90:T90|t99:T99|m9:M9|nat:NAT|xiaoma:小马|yueyi03:悦意03" },
  { id: "xpeng", name: "小鹏", keywords: ["xiaopeng"], models: "g3:G3|g3i:G3i|p5:P5|p7:P7|p7i:P7i|p7plus:P7+|g6:G6|g9:G9|x9:X9|mona-m03:MONA M03" },
  { id: "nio", name: "蔚来", keywords: ["weilai"], models: "es6:ES6|es7:ES7|es8:ES8|ec6:EC6|ec7:EC7|et5:ET5|et5t:ET5T|et7:ET7|et9:ET9|ep9:EP9" },
  { id: "onvo", name: "乐道", keywords: ["ledao"], models: "l60:L60|l90:L90" },
  { id: "firefly", name: "萤火虫", keywords: ["yinghuochong"], models: "firefly:firefly萤火虫" },
  { id: "xiaomi", name: "小米", keywords: ["xiaomi"], models: "su7:SU7|su7-ultra:SU7 Ultra|yu7:YU7" },
  { id: "im", name: "智己", keywords: ["zhiji", "im motors"], models: "l6:L6|l7:L7|ls6:LS6|ls7:LS7|ls9:LS9" },
  { id: "shangjie", name: "尚界", keywords: ["shangjie", "鸿蒙智行", "hima"], models: "h5:H5" },
  { id: "mhero", name: "猛士", keywords: ["mengshi", "mhero"], models: "917:917|m800:M800" },
  { id: "aito", name: "问界", keywords: ["wenjie", "鸿蒙智行", "hima"], models: "m5:M5|m7:M7|m8:M8|m9:M9" },
  { id: "luxeed", name: "智界", keywords: ["zhijie", "鸿蒙智行", "hima"], models: "s7:S7|r7:R7" },
  { id: "stelato", name: "享界", keywords: ["xiangjie", "鸿蒙智行", "hima"], models: "s9:S9|s9t:S9T" },
  { id: "maextro", name: "尊界", keywords: ["zunjie", "鸿蒙智行", "hima"], models: "s800:S800" },
  { id: "leapmotor", name: "零跑", keywords: ["lingpao"], models: "t03:T03|s01:S01|c01:C01|c10:C10|c11:C11|c16:C16|b01:B01|b10:B10" },
  { id: "neta", name: "哪吒", keywords: ["nezha"], models: "n01:N01|u:U|v:V|aya:AYA|x:X|s:S|s-hunting:S猎装|gt:GT|l:L" },
  { id: "voyah", name: "岚图", keywords: ["lantu"], models: "free:FREE|dreamer:梦想家|passion:追光|courage:知音|taishan:泰山" },
  { id: "denza", name: "腾势", keywords: ["tengshi"], models: "d9:D9|n7:N7|n8:N8|n9:N9|n8l:N8L|z9:Z9|z9gt:Z9GT|500:腾势500|x:腾势X" },
  { id: "fangchengbao", name: "方程豹", keywords: ["fangchengbao"], models: "bao5:豹5|bao8:豹8|tai3:钛3|tai7:钛7" },
  { id: "yangwang", name: "仰望", keywords: ["yangwang"], models: "u7:U7|u8:U8|u9:U9" },
  { id: "arcfox", name: "极狐", keywords: ["jihu"], models: "alpha-s:阿尔法S|alpha-t:阿尔法T|alpha-s5:阿尔法S5|alpha-t5:阿尔法T5|kaola:考拉|kaola-s:考拉S" },
  { id: "beijing", name: "北京汽车", keywords: ["beijing", "北汽", "baic"], models: "bj20:BJ20|bj30:BJ30|bj40:BJ40|bj60:BJ60|bj80:BJ80|bj90:BJ90|x3:X3|x5:X5|x7:X7|u5:U5|u5plus:U5 PLUS|u7:U7|eu5:EU5|eu5plus:EU5 PLUS|eu7:EU7|ex3:EX3|ex5:EX5|ec3:EC3|ec5:EC5|ec180:EC180|ec200:EC200|senova-d50:绅宝D50|senova-d70:绅宝D70|senova-x25:绅宝X25|senova-x35:绅宝X35|senova-x55:绅宝X55" },
  { id: "dongfeng-fengshen", name: "东风风神", keywords: ["fengshen", "aeolus"], models: "s30:S30|h30:H30|a60:A60|a30:A30|ax3:AX3|ax4:AX4|ax5:AX5|ax7:AX7|yixuan:奕炫|yixuan-gs:奕炫GS|yixuan-max:奕炫MAX|haoji:皓极|haohan:皓瀚|l7:L7|sky-ev01:SKY EV01" },
  { id: "dongfeng-fengxing", name: "东风风行", keywords: ["fengxing", "forthing"], models: "t5:T5|t5evo:T5 EVO|t5l:T5L|sx6:SX6|s50:景逸S50|x3:景逸X3|x5:景逸X5|x6:景逸X6|lingzhi:菱智|yacht:游艇|thunder:雷霆|xinghai-v9:星海V9|xinghai-s7:星海S7" },
  { id: "dongfeng-nammi", name: "东风纳米", keywords: ["nammi", "nami"], models: "01:纳米01|06:纳米06|box:纳米BOX" },
  { id: "dongfeng-epi", name: "东风奕派", keywords: ["e-pi", "eπ", "yipai"], models: "007:eπ007|008:eπ008" },
  { id: "venucia", name: "启辰", keywords: ["qichen", "东风启辰"], models: "d50:D50|r50:R50|r50x:R50X|d60:D60|d60ev:D60 EV|t60:T60|t70:T70|t90:T90|m50v:M50V|star:星|v:大V|vx6:VX6|r30:R30|e30:e30" },
  { id: "seres", name: "赛力斯", keywords: ["sailisi"], models: "sf5:SF5|3:赛力斯3|5:赛力斯5" },
  { id: "fengon", name: "东风风光", keywords: ["fengguang", "dfsk"], models: "330:330|370:370|500:500|580:580|ix5:ix5|ix7:ix7|s560:S560|mini:MINIEV|e1:E1|e3:E3|e5:E5" },
  { id: "jac", name: "江淮", keywords: ["jianghuai"], models: "a5:A5|j7:嘉悦A5|s2:瑞风S2|s3:瑞风S3|s4:瑞风S4|s5:瑞风S5|s7:瑞风S7|m3:瑞风M3|m4:瑞风M4|m5:瑞风M5|m6:瑞风M6|l6max:瑞风L6 MAX|rf8:瑞风RF8|refine:瑞风|heyue:和悦|tongyue:同悦|iev6e:iEV6E|iev7:iEV7|iev7s:iEV7S|ievs4:iEVS4|t6:帅铃T6|t8:帅铃T8|t9:悍途" },
  { id: "jac-yiwei", name: "江淮钇为", keywords: ["yiwei"], models: "3:钇为3|zhiai:挚爱" },
  { id: "sehol", name: "思皓", keywords: ["sihao"], models: "e10x:E10X|e20x:E20X|e40x:E40X|e50a:E50A|a5:A5|x4:X4|x6:X6|x8:X8|x8plus:X8 PLUS|qx:QX|yao:曜|love:爱跑" },
  { id: "maxus", name: "上汽大通", keywords: ["datong", "shangqidatong"], models: "g10:G10|g20:G20|g50:G50|g90:G90|mifa5:大家5|mifa7:大家7|mifa9:大家9|d60:D60|d90:D90|d90pro:D90 Pro|v70:V70|v80:V80|v90:V90|t60:T60|t70:T70|t90:T90|terron9:星际|ev30:EV30" },
  { id: "jmc", name: "江铃", keywords: ["jiangling"], models: "yuhu3:域虎3|yuhu5:域虎5|yuhu7:域虎7|yuhu9:域虎9|baodian:宝典|dadao:大道|e100:E100|e200:E200|e300:E300" },
  { id: "jmev", name: "江铃集团新能源", keywords: ["jiangling", "易至"], models: "ev3:易至EV3|ev2:易至EV2|gse:羿" },
  { id: "haima", name: "海马", keywords: ["haima"], models: "family:福美来|s5:S5|s7:S7|m3:M3|m5:M5|m6:M6|m8:M8|7x:7X|8s:8S|s5young:S5青春版|cupid:丘比特|prima:普力马|fstar:福仕达|3:海马3" },
  { id: "soueast", name: "东南", keywords: ["dongnan"], models: "v3:V3菱悦|v5:V5菱致|v6:V6菱仕|dx3:DX3|dx5:DX5|dx7:DX7|dx8:DX8|dx9:DX9|sovan:菱绅|lioncel:菱帅|delica:得利卡" },
  { id: "kaiyi", name: "凯翼", keywords: ["kaiyi", "cowin"], models: "c3:C3|c3r:C3R|x3:X3|x5:X5|xuanjie:炫界|xuanjie-pro:炫界Pro|xuandu:轩度|kunlun:昆仑|shiyue:拾月" },
  { id: "qoros", name: "观致", keywords: ["guanzhi"], models: "3:观致3|5:观致5|7:观致7" },
  { id: "zotye", name: "众泰", keywords: ["zhongtai"], models: "t200:T200|t300:T300|t500:T500|t600:T600|t700:T700|t800:T800|z100:Z100|z200:Z200|z300:Z300|z500:Z500|z700:Z700|sr7:SR7|sr9:SR9|e200:E200|yun100:云100|damai-x5:大迈X5|damai-x7:大迈X7" },
  { id: "lifan", name: "力帆", keywords: ["lifan"], models: "320:320|330:330|520:520|530:530|620:620|630:630|650:650|720:720|820:820|x50:X50|x60:X60|x70:X70|maiwei:迈威|xuanlang:轩朗|letu:乐途" },
  { id: "brilliance", name: "中华", keywords: ["zhonghua", "华晨中华"], models: "h220:H220|h230:H230|h320:H320|h330:H330|h530:H530|v3:V3|v5:V5|v6:V6|v7:V7|junjie:骏捷|zunchi:尊驰|kubao:酷宝" },
  { id: "swm", name: "斯威", keywords: ["siwei", "swm"], models: "x3:X3|x7:X7|g01:G01|g05:G05|g01f:G01 F|dahu:大虎" },
  { id: "jinbei", name: "金杯", keywords: ["jinbei", "鑫源", "xinyuan"], models: "haise:海狮|haise-x30:小海狮X30|haise-x30l:海狮X30L|haise-king:海狮王|750:金杯750" },
  { id: "foton", name: "福田", keywords: ["futian"], models: "tunland:拓陆者|general:大将军|mars7:火星7|mars9:火星9|view:风景|view-g7:风景G7|view-g9:风景G9|toano:图雅诺|sauvana:萨瓦纳|midi:迷迪" },
  { id: "leopard", name: "猎豹", keywords: ["liebao"], models: "cs6:CS6|cs7:CS7|cs9:CS9|cs10:CS10|q6:Q6|mattu:迈途|blackking:黑金刚|flying:飞腾" },
  { id: "ds", name: "DS", keywords: ["谛艾仕"], models: "3:DS 3|4:DS 4|4s:DS 4S|5:DS 5|5ls:DS 5LS|6:DS 6|7:DS 7|9:DS 9" },
  { id: "genesis", name: "捷尼赛思", keywords: ["jienisaisi"], models: "g70:G70|g80:G80|g90:G90|gv60:GV60|gv70:GV70|gv80:GV80" },
  { id: "polestar", name: "极星", keywords: ["jixing"], models: "1:Polestar 1|2:Polestar 2|3:Polestar 3|4:Polestar 4" },
  { id: "lotus", name: "路特斯", keywords: ["lutesi", "莲花"], models: "eletre:ELETRE|emeya:EMEYA|emira:EMIRA|evora:Evora|elise:Elise|exige:Exige" },
  { id: "maserati", name: "玛莎拉蒂", keywords: ["mashaladi"], models: "ghibli:Ghibli|quattroporte:总裁|levante:Levante|grecale:Grecale|granturismo:GranTurismo|grancabrio:GranCabrio|mc20:MC20" },
  { id: "bentley", name: "宾利", keywords: ["binli"], models: "continental:欧陆|flying-spur:飞驰|bentayga:添越|mulsanne:慕尚|arnage:雅致" },
  { id: "rolls-royce", name: "劳斯莱斯", keywords: ["laosilaisi"], models: "phantom:幻影|ghost:古思特|wraith:魅影|dawn:曜影|cullinan:库里南|spectre:闪灵" },
  { id: "ferrari", name: "法拉利", keywords: ["falali"], models: "458:458|488:488|f8:F8|296:296|812:812|sf90:SF90|roma:ROMA|portofino:Portofino|california:California|f12:F12berlinetta|ff:FF|gtc4:GTC4Lusso|purosangue:Purosangue" },
  { id: "lamborghini", name: "兰博基尼", keywords: ["lanbojini"], models: "urus:Urus|huracan:Huracán|aventador:Aventador|gallardo:Gallardo|revuelto:Revuelto|temerario:Temerario" },
  { id: "aston-martin", name: "阿斯顿·马丁", keywords: ["asidunmading", "astonmartin"], models: "db9:DB9|db11:DB11|db12:DB12|dbs:DBS|dbx:DBX|vantage:Vantage|rapide:Rapide|vanquish:Vanquish" },
  { id: "mclaren", name: "迈凯伦", keywords: ["maikailun"], models: "540c:540C|570s:570S|600lt:600LT|650s:650S|675lt:675LT|720s:720S|750s:750S|gt:GT|gts:GTS|artura:Artura" },
  { id: "chrysler", name: "克莱斯勒", keywords: ["kelaisile"], models: "300c:300C|grand-voyager:大捷龙|sebring:铂锐|pt-cruiser:PT漫步者" },
  { id: "dodge", name: "道奇", keywords: ["daoqi"], models: "journey:酷威|caliber:酷搏|challenger:挑战者|charger:Charger|durango:Durango|caravan:凯领" },
  { id: "fiat", name: "菲亚特", keywords: ["feiyate"], models: "viaggio:菲翔|ottimo:致悦|500:500|bravo:博悦|freemont:菲跃|palio:派力奥|siena:西耶那|weekend:周末风|punto:朋多" },
  { id: "alfa-romeo", name: "阿尔法·罗密欧", keywords: ["aerfaluomiou", "alfaromeo"], models: "giulia:Giulia|stelvio:Stelvio|tonale:Tonale|4c:4C" },
  { id: "wm", name: "威马", keywords: ["weima", "weltmeister"], models: "ex5:EX5|ex6:EX6|w6:W6|e5:E.5" },
  { id: "aiways", name: "爱驰", keywords: ["aichi"], models: "u5:U5|u6:U6" },
  { id: "hiphi", name: "高合", keywords: ["gaohe", "hiphi"], models: "x:HiPhi X|y:HiPhi Y|z:HiPhi Z" },
  { id: "jiyue", name: "极越", keywords: ["jiyue"], models: "01:01|07:07" },
  { id: "enovate", name: "天际", keywords: ["tianji"], models: "me5:ME5|me7:ME7" },
  { id: "skywell", name: "创维", keywords: ["chuangwei", "天美"], models: "ev6:EV6|ht-i:HT-i|et5:天美ET5" },
  { id: "rising", name: "飞凡", keywords: ["feifan", "R汽车"], models: "r7:R7|f7:F7|er6:ER6|marvel-r:MARVEL R" },
  { id: "geometry", name: "几何", keywords: ["jihe", "吉利几何"], models: "a:几何A|c:几何C|e:几何E|g6:G6|m6:M6|ex3:EX3功夫牛" },
  { id: "livan", name: "睿蓝", keywords: ["ruilan"], models: "7:睿蓝7|9:睿蓝9|maple60s:枫叶60S|maple80v:枫叶80V|maple30x:枫叶30X|x3pro:X3 PRO" },
  { id: "baic-changhe", name: "北汽昌河", keywords: ["changhe"], models: "q25:Q25|q35:Q35|q7:Q7|a6:A6|m50:M50|m70:M70|furuida:福瑞达|beidouxing-x5:北斗星X5" },
  { id: "bisu", name: "比速", keywords: ["bisu"], models: "m3:M3|t3:T3|t5:T5" },
  { id: "borgward", name: "宝沃", keywords: ["baowo"], models: "bx3:BX3|bx5:BX5|bx6:BX6|bx7:BX7" },
  { id: "luxgen", name: "纳智捷", keywords: ["nazhijie"], models: "5:纳5|6:优6 SUV|7:大7 SUV|7mpv:大7 MPV|u5:U5 SUV|urx:URX|master:MASTER CEO" },
  { id: "ssangyong", name: "双龙", keywords: ["shuanglong", "kgm"], models: "korando:柯兰多|rexton:雷斯特|tivoli:蒂维拉|actyon:爱腾|kyron:享御|rodius:路帝" },
  { id: "faw-tianjin", name: "天津一汽", keywords: ["tianjinyiqi", "夏利", "骏派"], models: "xiali:夏利|xiali-n3:夏利N3|xiali-n5:夏利N5|xiali-n7:夏利N7|xiali-2000:夏利2000|weizhi:威志|weizhi-v2:威志V2|weizhi-v5:威志V5|weizi:威姿|weile:威乐|junpai-d60:骏派D60|junpai-d80:骏派D80|junpai-a50:骏派A50|junpai-a70:骏派A70|junpai-cx65:骏派CX65" },
  { id: "isuzu", name: "五十铃", keywords: ["wushiling", "江西五十铃"], models: "mux:mu-X牧游侠|dmax:D-MAX|lingtuo:铃拓|ruimai:瑞迈" },
  { id: "karry", name: "开瑞", keywords: ["kairui", "奇瑞开瑞"], models: "k50:K50|k60:K60|youyou:优优|youjin:优劲|youya:优雅|youyi:优翼|youyou-ev:优优EV|dolphin-ev:海豚EV" },
  { id: "yutong-bus", name: "宇通客车", keywords: ["yutong", "yutongbus", "宇通"], models: "zk6126hg:ZK6126HG", vehicleClassCodes: ["large_bus"] },
  { id: "faw-jiefang", name: "一汽解放", keywords: ["jiefang", "faw", "解放卡车"], models: "j7:J7", vehicleClassCodes: ["large_tractor"] },
  {
    id: "dongfeng-commercial", name: "东风商用车", keywords: ["dongfeng", "dfcv", "东风卡车"], models: "tianlong-kl:天龙KL|tianjin-kr:天锦KR",
    modelVehicleClassCodes: {
      "tianlong-kl": ["large_truck"],
      "tianjin-kr": ["small_truck", "large_truck"],
    },
  },
  {
    id: "sinotruk-howo", name: "中国重汽豪沃", keywords: ["sinotruk", "howo", "重汽", "豪沃"], models: "howo:HOWO|a7:HOWO A7|hanjiang:豪沃悍将",
    modelVehicleClassCodes: {
      howo: ["large_tractor", "large_truck"],
      a7: ["large_tractor", "large_truck"],
      hanjiang: ["small_truck"],
    },
  },
  { id: "shacman", name: "陕汽重卡", keywords: ["shacman", "shanqi", "陕汽"], models: "x6000:X6000|x3000:X3000", vehicleClassCodes: ["large_tractor", "large_truck"] },
  { id: "foton-auman", name: "福田欧曼", keywords: ["foton", "auman", "futian", "欧曼"], models: "gtl:GTL|etx:ETX", vehicleClassCodes: ["large_tractor", "large_truck"] },
  { id: "jac-shuailing", name: "江淮帅铃轻卡", keywords: ["jac", "shuailing", "江淮轻卡", "帅铃"], models: "n55:帅铃N55|shuailing-ii:帅铃II", vehicleClassCodes: ["small_truck"] },
  {
    id: "trailer-body", name: "挂车（按车身形式）", keywords: ["guache", "trailer", "半挂车", "挂车"],
    models: "flatbed:平板半挂车|drop-side:栏板半挂车|car-carrier:车辆运输半挂车|curtain-side:侧帘半挂车|container:集装箱运输半挂车|tanker:罐式半挂车|box:厢式半挂车",
    vehicleClassCodes: ["trailer"],
  },
];
