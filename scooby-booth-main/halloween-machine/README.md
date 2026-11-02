# 万圣节机器 · 接线和代码说明

```
halloween-machine/
├── mega_controller/mega_controller.ino     交互 1：Arduino Mega 2560
├── esp32_monster_tv/esp32_monster_tv.ino   交互 2：ESP32-S3 Feather + 4.0" 屏
├── nuc/mega_link.py                        给同事 import 的串口模块
├── nuc/mock_nuc.py                         同事代码到之前用来测试的模拟程序
├── convert_images.py                       怪兽图片转换工具
└── sd_card/monsters/m01.jpg … m10.jpg      已经转好的 10 张怪兽图，直接拷进 SD 卡
```

---

## 一、电源总览

| 电源 | 供给 | 说明 |
|---|---|---|
| NUC USB → Mega | Mega 和 5V 小件（MCP4728、数码管、电位器） | Mega 同时用这根线和 NUC 通信 |
| NUC USB → ESP32 | ESP32、屏幕 | 屏幕 VCC 接 Feather 的 **USB** 脚（5V） |
| **5V 独立电源 ≥4A** | 灯带 | 灯带入口并一个 1000µF 电容；**GND 必须和 Mega GND 相连** |
| **12V 电源 ≥1A** | 5 个角色 LED（经 MOSFET 板） | MOSFET 板有光耦隔离，12V 这侧**不用**和 Mega 共地 |

> ⚠️ 灯带绝对不要从 Mega 的 5V 脚取电。

---

## 二、交互 1：Arduino Mega 2560 接线

### 开关和按钮（全部一端接引脚、一端接 GND，不用电阻）

| 部件 | 线 | 接到 |
|---|---|---|
| Key Switch | COM | GND |
|  | NO | **D22** |
|  | NC | 不接 |
| 红按钮（街机） | 两个脚任意 | **D24** / GND |
| 蓝按钮（街机） | 两个脚任意 | **D26** / GND |
| 小按钮 1 / 2 / 3 | 红黑线任意 | **D28 / D30 / D32** / GND |
| Knife Switch | 同一组刀的两个接线柱 | **D34** / GND（另一组刀不接） |

### 电位器 B10K

| 脚 | 接到 |
|---|---|
| 左脚 | GND |
| 中间脚 | **A0** |
| 右脚 | 5V |

> 转的方向和档位反了：两个边脚对调，或者代码里 `POT_REVERSED = true`。

### I2C 总线（MCP4728 和数码管共用）

| 模块脚 | Mega |
|---|---|
| VCC / + | 5V |
| GND / − | GND |
| SDA / D | **D20 (SDA)** |
| SCL / C | **D21 (SCL)** |

- MCP4728 地址 0x60，数码管地址 0x70。用两片数码管时，第二片背面 **A0 焊盘焊通** → 0x71，代码里 `NUM_ALPHA = 2`。

### 电压表（接 MCP4728 输出）

| MCP4728 输出 | 表 | 表的 + | 表的 − |
|---|---|---|---|
| VA | 主表 DH-670 (0-5V) | VA | GND |
| VB | 小表 SO-45 #1 (0-3V) | VB | GND |
| VC | 小表 SO-45 #2 | VC | GND |
| VD | 小表 SO-45 #3 | VD | GND |

- 指针反着打（往左顶）→ 表的 + − 接反了，对调。
- 小表代码里已经限制在 3V 以内。

### 5 个角色 LED（12V，经两块 F5305S MOSFET 板）

**输入侧（信号）**

| Mega | MOSFET 板 |
|---|---|
| D2 | 板 1 · 通道 1 输入 |
| D3 | 板 1 · 通道 2 输入 |
| D4 | 板 1 · 通道 3 输入 |
| D5 | 板 1 · 通道 4 输入 |
| D6 | 板 2 · 通道 1 输入 |
| GND | 两块板输入侧的 GND / 负端 |

**输出侧（12V）**

| 接 | 到 |
|---|---|
| 12V 电源 + / − | 两块板的 DC+ / DC− |
| 每个灯红线 | 对应通道 OUT+ |
| 每个灯黑线 | 对应通道 OUT− |

> 端子丝印各批次略有差异，到货后拍照确认。灯的亮灭整体反了 → `LED_ACTIVE_HIGH = false`。

### 灯带

| 灯带 | 接到 |
|---|---|
| 5V | 5V 电源 + |
| GND | 5V 电源 − **以及 Mega GND** |
| DIN | 330Ω 电阻 → **D7** |

- 从箭头起点那端（DIN）进数据。
- 颜色不是蓝色 → 改 `STRIP_TYPE`；进度方向反了 → `STRIP_REVERSED = true`。

---

## 三、交互 2：ESP32-S3 Feather 接线

屏幕和 SD 卡走**两条独立 SPI**，屏幕的 SDO(MISO) 和触摸的 5 个脚（T_xxx）都不接。

### 屏幕（模块长边那排针）

| 屏幕脚 | Feather |
|---|---|
| VCC | **USB**（5V） |
| GND | GND |
| CS | **10** |
| RESET | **6** |
| DC/RS | **9** |
| SDI(MOSI) | **MO**（GPIO35） |
| SCK | **SCK**（GPIO36） |
| LED | **3V** |
| SDO(MISO) | 不接 |
| T_CLK / T_CS / T_DIN / T_DO / T_IRQ | 不接 |

### 图片存哪里

**默认：图片编在程序里，不用 SD 卡**，下面 SD 卡那 4 根线和"SD 卡准备"都可以跳过。
- 上传 ESP32 代码前：Arduino IDE → 工具 → **Partition Scheme 选 "Huge APP (3MB No OTA)"**，否则 10 张图放不下。
- 换图：
  ```
  python convert_images.py 原图文件夹 sd_card/monsters
  python make_monsters_h.py sd_card/monsters esp32_monster_tv/monsters.h
  ```
  然后重新上传。
- 想改回 SD 卡：代码顶部 `#define USE_SD false` 改成 `true`。

### SD 卡（只有 USE_SD = true 时才接；模块另一端那 4 个脚）

| SD 脚 | Feather |
|---|---|
| SD_CS | **A1**（GPIO17） |
| SD_MOSI | **A3**（GPIO15） |
| SD_MISO | **A2**（GPIO16） |
| SD_SCK | **A4**（GPIO14） |

> Adafruit 有好几款 ESP32-S3 Feather，A1–A4 对应的 GPIO 号以你板子的官方 pinout 为准，不同的话改代码顶部的 GPIO 号。

### 船型开关

| 开关线 | Feather |
|---|---|
| 红 | GND |
| 黄 | **12** |
| 黑 | 不接 |

### SD 卡准备

1. SD 卡格式化成 **FAT32**（32GB 以下最稳）。
2. 把 `sd_card/monsters` 整个文件夹拷到 SD 卡**根目录**。
3. 以后加图：`python convert_images.py 原图文件夹 sd_card/monsters`，再拷一次。

---

## 四、上传代码

**Mega**：Arduino IDE → 开发板选 Arduino Mega 2560 → 库管理器安装
`Adafruit MCP4728`、`Adafruit LED Backpack Library`、`Adafruit NeoPixel`（提示装依赖就全装）→ 上传。

**ESP32**：开发板管理器装 `esp32 by Espressif` → 开发板选你那款 Feather ESP32-S3 → 库管理器装 `LovyanGFX` → 上传。
有 PSRAM 的型号记得在 工具 → PSRAM 里启用（撕裂特效要用）。

---

## 五、测试顺序（建议一块一块来）

1. **只接 Mega + USB**，打开串口监视器（115200）。应看到 `READY`，没接的模块会打 WARNING。
2. **按钮和开关**：扭钥匙应出现 `START`；转电位器出现 `CHAR:1…5`；按红/蓝出现 `MODE:RED:3`。
3. **I2C**：接上 MCP4728 和数码管，重启后 WARNING 消失，数码管开始乱码。
4. **电压表校准**：串口输入 `CAL:410`、`CAL:1229`……看主表指针对着哪儿，找到五个档位刚好对准的数值，填进 `MAIN_METER_POS`，再上传。`CAL:-1` 结束校准。
5. **LED**：接 MOSFET 板和 12V，待机时应该是跑马灯。
6. **灯带**：接好电源后，扭钥匙 → 按红或蓝 → 拉闸，然后串口输入 `PROGRESS:50` → `DONE`。
7. **整套流程**：关掉串口监视器，运行 `python nuc/mock_nuc.py`，从钥匙走到打印完成。

> 串口同一时间只能被一个程序占用：用 mock_nuc.py 时要先关 Arduino IDE 的串口监视器。

---

## 六、Mega ↔ NUC 串口协议（给同事）

115200 baud，每条消息一行，`\n` 结尾。建议同事直接用 `nuc/mega_link.py`。

### Mega → NUC（事件）

| 消息 | 含义 |
|---|---|
| `READY` | Mega 启动完成 |
| `START` | 扭了钥匙，新一局开始 → **NUC 立刻拍照** |
| `CHAR:n` | 当前选中角色 n = 1…5（转电位器时实时发）。按了红/蓝之后、拉闸之前再转，会取消选择，回到 SELECT |
| `MODE:RED:n` / `MODE:BLUE:n` | 选定模式（角色 n）。拉闸之前按另一个按钮可以换，会再发一次 `MODE`；同一个按钮再按无效 |
| `ARMED` | 闸刀已解锁（选完模式后紧接着自动发出） |
| `PRINT` | 闸刀拉动 → **NUC 开始生成四格漫画并打印** |
| `TIMEOUT` | 长时间无人操作，自动回待机 |
| `IDLE` | 回到待机 |
| `ACK:xxx` | 收到了 ARM / DONE / RESET |
| `# ...` | 调试信息，忽略即可 |

### NUC → Mega（指令）

| 指令 | 作用 |
|---|---|
| `ARM` | 只有 `AUTO_ARM = false` 时才需要：允许拉闸 |
| `PROGRESS:n` | 灯带进度 0–100；`-1` = 不确定进度（绿色流动） |
| `DONE` | 打印完成（灯带闪三下后回待机） |
| `RESET` | 强制回待机 |
| `PING` | Mega 回 `PONG` |
| `STATE` | Mega 回当前状态 |
| `CAL:n` | 校准主表（0–4095），`CAL:-1` 结束 |

**时间由 NUC 应用决定（固件已改）：** NUC 每 2.5 秒发一次 `STATE`。只要 NUC 在说话，Mega 自己的超时（SESSION / PRINT / DONE_ANIM 回待机）都不生效：NUC 屏幕回到开始画面时会发 `RESET`。NUC 超过 10 秒（`HOST_SILENT_MS`）没消息，才恢复原来的超时。`DONE` 之后灯带闪完会停在 DONE_ANIM（选中的角色灯常亮），直到 `RESET` 或下一次扭钥匙。原版固件备份在 `../backups/mega_controller-original.ino`。
(The NUC app now decides all timing: while it keeps sending STATE, the Mega's own timeouts are off.)

**灯带颜色：** 进度条、流动动画、完成闪烁都是青柠绿（`COLOR_WORK`）；只有选了按钮、等拉闸时才用红（`COLOR_RED`）或蓝（`COLOR_BLUE`）呼吸。颜色在代码顶部改。开机自检仍然亮蓝色 1 秒（检查接线用）。
(Strip: lime green for progress/done; red or blue breathing only while that button is chosen. Power-on self-test stays blue.)

**ARM / DONE / RESET 需要等 `ACK`，没收到就重发**（mega_link.py 已经做好）。
原因：灯带刷新的几毫秒里 Mega 收不到串口数据，偶尔会丢一条。`PROGRESS` 每次都会重新发，丢一条无所谓。

### 完整流程（已和同事确认）

```
扭钥匙        Mega → START            NUC 拍照
转电位器      Mega → CHAR:1…5         NUC 屏幕显示对应角色
按红/蓝       Mega → MODE:RED:3       NUC 记下角色+模式
              Mega → ARMED            闸刀解锁（LED 闪、灯带用所选按钮的颜色——红或蓝——微微呼吸）
拉闸          Mega → PRINT            NUC 开始生成四格漫画
等待          NUC  → PROGRESS:0…100   灯带青柠绿进度条跟着涨
打印完        NUC  → DONE             灯带闪三下，回待机
```

- 选完模式就能拉闸，不等拍照。如果有人拉得比照片拍完还快，NUC 那边等照片好了再开始生成就行（进度先发 `PROGRESS:-1` 显示流动动画，或停在 0）。
- 想改成"拍完照才能拉闸"：Mega 代码里 `AUTO_ARM` 改成 `false`，NUC 拍完照发 `ARM`。
- 生成时间没法预估百分比时，发 `PROGRESS:-1`，灯带会显示绿色流动动画，之后随时可以切回具体数字。
