# Agent Note: 模型选择器的过滤与固定

Status: implemented

[English](2026-09-16-model-picker-search-and-pins.md) | 中文

## 问题

composer 的模型菜单会列出目录公布的全部模型，并按提供方分组。当部署中有多个提供方、模型 id 达数十个时，找到某一个模型只能靠滚动；在少数几个模型之间来回切换的用户，每次切换都要重新寻找。`/model` 弹窗可以借助命令面板对其行排序，而 composer 模型位既没有这种排序，也没有任何快捷方式。

## 决策

模型位的 `model` 面板新增过滤输入框与逐行固定开关。过滤是组件本地状态：只在菜单打开期间存在，打开、关闭与返回时都会清空；输入文本以不区分大小写的子串匹配模型显示名称、提供方自有的模型 id 或提供方名称。目录说明不参与匹配，因为列表呈现的是名称。无匹配时回显输入文本；Escape 先清空非空过滤，再走该面板原有的返回与关闭步骤。输入框在进入时获得焦点，因此可以直接输入过滤，上下方向键则从输入框进入各行；当列表内没有任何焦点时，`moveFocus` 现在从近端进入，而不是跳过第一行。

每个模型行由一个选项按钮加一个同级的固定按钮组成，因为按钮不能嵌套在选项按钮内部；因此点击固定永远不会选中模型。已固定的模型会按固定顺序再次列在提供方分组之上的「已固定」一节，并在名称下方标注其提供方；其所在提供方分组仍保留该提供方所服务模型的完整列表。提供方标签是该固定行可访问名称的一部分（`option.providerAria`），因为仅靠内容顺序会把两段标签连在一起。目录不再服务的固定项只是不渲染；存储的键会保留，以备该提供方重新出现。

固定状态是本插件持有的唯一浏览器级事实。[`apply`](../../../../packages/client/ui-model-selection/src/client/index.ts) 创建一个 `createModelPinsStore()` 实例，经注入的 `hooks` 隔间交给每个会话的模型位（渲染器将其绑定为 `useModelPins`）；写入经面（face）的 `togglePin` 动词完成。固定并非由会话派生，因此留在 Session 投影之外，遵循[投影归属决策](../../implemented/architecture/2026-08-25-session-observations-and-projection-owned-client-state.zh.md)。[`pins.ts`](../../../../packages/client/ui-model-selection/src/client/pins.ts) 拥有该持久化格式（`dsh.model-pins` localStorage 键下的 `{ pinned: string[] }` JSON 对象）并在读取时校验，而不使用 `createSnapshotStore` 自带的 `persist` 选项——后者会原样装入浏览器中的任何 JSON。存储失败只会关闭持久化：内存中的列表在本页仍是权威，与存储引擎的约定一致。

收藏字形（`IconStarOutline16`、`IconStarFill16`）与其他 `ic_ds_*` 图标一起放在 [ui-primitives](../../../../packages/client/ui-primitives/src/icons/index.tsx)。`/model` 弹窗是自带排序的界面，两者都不添加。

## 考虑过的替代方案

**把已固定的模型移出提供方分组。** 分组将不再列出该提供方所服务的内容，浏览提供方的用户也就看不到已固定的模型。重复该行可以同时保住这两点，并使「已固定」一节成为快捷方式而非搬移。

**用槽位声明的 store 位实现按会话固定。** 模型位是会话作用域的，框架会为每个会话作用域生成一个 store 实例，持久化键还会带上会话后缀：「固定」将意味着每个会话各有一份列表，而这不是收藏的含义。

**复用存储引擎的 `persist` 选项保存固定列表。** 它能省掉读写一对函数，但其重hydration 路径会接受该键下的任何 JSON：被手工编辑或旧版本的条目可能把非列表值放进渲染状态，从而破坏 composer。改为由拥有该格式的模块在持久化边界上校验。

**把固定放进 Host 侧设置文档。** 这样可以跨浏览器与 profile 同步，代价是为一个表现层快捷方式新增设置命名空间、RPC 往返及其自身的迁移。暂缓；包 README 已把「固定仅在单个浏览器内」记入已知限制。

**为固定列表单独建客户端包。** 该列表只被一个模型位读取、只经一个动词写入；包边界会为几十行代码增加清单、启动行与 store 管道。

## 后果

固定是单浏览器范围内的：换浏览器、换 profile 或换设备都从零开始，会话、模型选择与会话日志都不携带它。插件公布的运行时不变式没有变化（不发布 `./invariant` 伴生入口）：固定存储是插件私有的，既有的 HMR 安全性测试仍覆盖它所 dispose 的注册。

新增文案由 `model` 命名空间的字典拥有：`search.label`、`search.placeholder`、`group.pinned`、`option.providerAria`、`pin.add`、`pin.remove`、`empty.search`。此处没有任何模型可见内容，因此没有会话事件或录制会话快照发生变化；站点的 `/model` 弹窗与选择约定不受影响。

覆盖情况：[`model-select.client.spec.tsx`](../../../../packages/client/ui-model-selection/tests/model-select.client.spec.tsx) 驱动过滤（名称、id、提供方、无匹配、Escape、方向键进入）、固定顺序、对「已固定」一节的过滤、可访问的提供方标签，以及固定开关不会触发选中；[`pins.client.spec.ts`](../../../../packages/client/ui-model-selection/tests/pins.client.spec.ts) 覆盖持久化格式的畸形、异形与存储拒绝写入路径；[`browser-plugin.client.spec.ts`](../../../../packages/client/ui-model-selection/tests/browser-plugin.client.spec.ts) 证明跨会话共用同一个固定存储。组装后的浏览器由 [`model-picker-filter.e2e.ts`](../../../../apps/web/tests/model-picker-filter.e2e.ts) 固化：其黄金文件记录 Host 真实服务的目录在被过滤后的行，以及完整提供方分组之上的「已固定」一节。吸顶标题的表现与固定开关的悬停样式仍由录制好的 GUI 演示佐证，而非断言。
