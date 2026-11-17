# 土豆片通用 · TodooCard General for SiYuan

> 在思源笔记里扫描、配对 TodooCard 墨水屏卡片，把图片直接发到 528×792 的屏幕上。macOS 与 Windows 桌面端共用一套核心。

当前版本 **0.1.0** · macOS / Windows 桌面端 · MIT License

发送与图像转换由独立的纯 Python 核心 [Gt841/plugin-todoocard-general-core](https://github.com/Gt841/plugin-todoocard-general-core) 完成。本插件不重写传图管线，只负责运行环境、核心安装、设备管理和思源内的操作界面。核心是对 [Sunbelife/TodooCard_Skills](https://github.com/Sunbelife/TodooCard_Skills) 的跨平台重写，不包含、也不分发其 Swift 源码。

## 核心特性

### 一份插件，两个平台

macOS 使用 CoreBluetooth，Windows 使用 WinRT，两者由核心统一封装。插件里没有 `swiftc`、`sips` 或平台专属路径：图片解码、旋转、裁切、六色抖动和 payload 生成都在 Python 侧完成。设备 ID 同时接受 macOS 的 UUID 与 Windows 的 MAC 地址。

### 环境引导，而不是把报错丢给用户

插件会检查 Python 3.9+、平台和核心依赖。缺 Python 时可以在面板里打开官方下载页（Windows 会提示勾选 Add python.exe to PATH），安装后自动复查。核心依赖安装在插件自己的 venv 里，不污染系统 Python，也不需要管理员权限。

### 核心按需下载，安装可追溯

核心不随插件包分发。首次使用时从 GitHub 下载源码 tarball，校验 SHA-256 后解压，先建好 venv，再以整目录替换的方式安装。下载线路只是传输通道，不改变校验结果；安装记录会保存来源、实际摘要、安装时间和 venv 路径，方便排查。核心升级只替换 `core/`，venv 保留复用。

### 面向墨水屏的完整图片流程

支持 JPG / PNG / HEIC / TIFF / BMP / WebP 选择、拖入、剪贴板截图粘贴，可向右旋转 90°。2:3 取景框实时裁切，调用核心转换后展示 v157+ / legacy payload 大小，并把 528×792 的六色位图解码成预览，发送前就能看到最终效果。

图片页另有 **卡片排版** 模式：填写标题、日期和一句话后，用 **整图标题 / 留白图文 / 照片墙** 三种版式直接生成 528×792 卡片。照片墙使用 2–6 张图片，可排序与移除；其余版式只用一张图片，添加图片、Bing 每日壁纸与粘贴截图会替换当前图片。圆角、边框、底部信息带和留白都可调，排版图只用面板原色绘制，避免六色抖动产生彩色噪点。

### 设备扫描与多设备管理

默认只显示 TodooCard 兼容设备（manufacturer `0x5053` + screen `0x134C`），可关闭过滤查看全部；支持信号/名称排序、搜索、配对窗口筛选和已配对筛选。备注名、配对时间按设备 ID 持久化；已配对设备即使当前没被扫描到，也能直接探测或按 ID 发送。

### 多选批量发送

图片页底部可勾选多台目标卡片，一次发送到多台设备；发送前展示目标清单，只有收到卡片的 `0x05/0x08` 刷新确认才视为成功。

### 数据独立于思源同步

插件设置、配对记录和核心都放在思源工作区之外，不参与云端同步，也不会被旧副本覆盖。通用版使用 `todoocard-general` 目录，可与 macOS 专用版 `todoocard` 并存。

## 快速开始

1. 安装并启用插件，点击顶部栏「土豆片通用 · TodooCard General」图标。
2. 完成 **环境检查**。缺少 Python 时点 **获取 Python**，安装后插件会自动复查；勾选核心依赖并下载。
3. 点击 **下载核心**。国内网络慢时先把「下载线路」切到 `gh-proxy.com` 或 `ghproxy.vip`。
4. 切到 **设备**，点 **扫描设备**，选中卡片；首次连接按提示长按卡片背面按钮完成配对。
5. 切到 **图片**，选择/拖入图片或粘贴截图，调整取景框，点 **生成预览**；也可以切到 **卡片排版**，添加多张图片或 Bing 每日壁纸，填写文字后用三种版式生成卡片。
6. 勾选目标卡片，点 **发送到卡片**，核对清单后确认。

配对与发送都需要卡片在附近并保持唤醒。扫描只列出兼容设备；配对窗口关闭时，需要先长按卡片按钮重新进入配对模式。

## 环境要求

- macOS（Apple Silicon / Intel）或 Windows 10/11
- SiYuan ≥ 3.0.1，桌面端
- Python 3.9+（macOS 也可用 Command Line Tools 自带的 `python3`）
- 首次扫描时允许应用使用蓝牙：
  - macOS：系统设置 → 隐私与安全性 → 蓝牙
  - Windows：设置 → 蓝牙和其他设备，并确认蓝牙已打开

核心的 Python 依赖（`bleak`、`Pillow`）装在插件数据目录的 venv 中，不要求系统 pip 可写。

## 设备与配对

- **扫描**：一次扫描约 30 秒；可随时停止，结果保留在当前面板。
- **筛选**：默认只显示兼容设备；可切换「仅兼容」、按配对状态过滤或搜索名称/设备 ID。
- **配对**：按设备 ID 记录备注名和配对时间；配对前提示长按卡片背面按钮（新固件 5 秒 / 旧固件 10 秒），配对窗口最长 60 秒。
- **探测**：已配对设备可直接验证加密连接并读取电量；未配对时核心会返回明确错误，插件不会误报成功。
- **Windows 提示**：如果系统里残留旧绑定，先在「设置 → 蓝牙和其他设备」移除设备，再重新配对。

## 数据目录

macOS：

```text
~/Library/Application Support/SiYuan/todoocard-general/
├── state.json        # 设置、设备备注、配对记录、上次选择
├── core/             # 通用核心副本（可重新下载覆盖）
├── core-meta.json    # 来源、SHA-256、安装时间
├── venv/             # 核心的 Python 虚拟环境
├── tmp/              # 下载/解压临时目录
├── cache/            # 预览与 payload 缓存
└── legacy/           # 旧版插件设备备注备份（如有）
```

Windows：

```text
%APPDATA%\SiYuan\todoocard-general\
```

可用环境变量 `SIYUAN_TODOOCARD_GENERAL_HOME` 覆盖数据目录（测试用）。目录位于思源工作区 `data/` 的上一级，不在思源同步范围内；插件不使用 `saveData` / petal 存储，因此插件信息与配对信息不会被云端旧副本覆盖。

## 核心来源与下载策略

- 默认来源：`https://github.com/Gt841/plugin-todoocard-general-core/commit/9d85a66f4eeacde253f53a9b66f7cc2715edd263`
- 默认来源的 tarball SHA-256 固定为 `09f3fa009ff487079534d34395317b1976244702e9adefa43d313e1f6fac7e2a`；直连或加速线路下载后都会先比对，不一致就拒绝安装。
- **不会自动跟随 `main`**，也不会自动下载；必须点一次「下载 / 更新核心」。
- 更新上游：在「设置 → 核心来源」把地址改成新的 commit 或 `main`，保存后点「下载 / 更新核心」。改成其他来源后没有可预知的固定摘要，只记录实际 SHA-256。
- 下载线路可选：直连 GitHub（默认）、[gh-proxy.com](https://gh-proxy.com/)、[ghproxy.vip](https://ghproxy.vip/)。后两者是第三方加速服务，不是官方镜像，可用性和隐私策略由各自服务决定；插件只把原始 codeload 地址拼在它们后面。
- 核心源码以 MIT 许可证开源，随下载保留 `LICENSE` 与 `NOTICE`。

## 更新记录

### 0.1.0

- 首个通用版本：插件从 macOS 专用 Skill 层迁移到纯 Python 通用核心。
- 支持 macOS 与 Windows；设备 ID 接受 UUID 与 MAC 地址。
- 新增 Python 环境检查与 venv 自动创建，核心依赖不再依赖系统 Python。
- 图片预览在无法调用 `sips` 时使用 Electron `nativeImage`，Windows 也可预览 HEIC 以外的常见格式。
- 保留卡片排版、Bing 每日壁纸、多设备批量发送与发送前预览。

## 开发

```bash
npm install
npm test          # vitest：解析、状态存储、路径、核心安装、图片校验、payload 预览
npm run build     # 生成 dist/ 与 package.zip
npm run make-link # 把开发构建软链到思源插件目录
npm run dev       # watch 构建到思源插件目录
```

构建后手动安装：

```bash
unzip -o package.zip -d "$HOME/Library/Application Support/SiYuan/data/plugins/plugin-todoocard-general"
```

Windows 可解压到 `%APPDATA%\SiYuan\data\plugins\plugin-todoocard-general`，或在思源里用本地包安装。

## 已验证范围

- 插件单元测试 88/88 通过；TypeScript 检查与生产构建通过。
- 核心侧 31 项测试通过，覆盖广告解析与描述契约、六色转换与面板/控制器坐标、legacy 包结构、QuickLZ 往返、CLI 输出契约、verified/legacy 传输状态机。
- 插件路径、状态存储、核心安装（含下载失败保留旧核心、SHA 不一致拒绝安装）、扫描输出解析均有用例覆盖。
- 安装链路实测：本地 HTTP 提供 tarball → 下载 → 解压归一化 → 原子替换 → 创建 venv → 安装依赖 → `todoocard_core --version` 自检，全部通过；安装后的核心可直接扫描与转换。
- 真机 BLE（macOS）：扫描到两台 TodooCard（固件 v185，`manufacturer=0x5053`、`screen=0x134C`、turbo 开启），已配对设备完成加密探测并读到电量。
- Windows 侧代码路径（WinRT、`py -3`、PATHEXT、`taskkill`、PowerShell 解压）已实现，仍建议在 Windows 机器上按 [验证清单](docs/real-machine-validation.md) 过一遍扫描、配对和发送。
- 真实发送需要用户显式点选目标卡片；发送前会展示目标清单，只有收到 `0x05/0x08` 刷新确认才视为成功。

## 许可与限制

- 本插件代码以 MIT 许可证开源。
- 支持 macOS 与 Windows 桌面端；Linux 核心可用，但插件尚未开放。
- 通用核心不随本仓库或 `package.zip` 分发，只在用户本机按需下载。
- HEIC 输入需要核心侧额外安装 `pillow-heif`；未安装时请在发送前转成 JPG/PNG。
