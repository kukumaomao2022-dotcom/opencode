# 乐天多店铺库存同步（Bun）

你上一次反馈的核心问题是：**数据从哪里来、怎么导入、怎么落地**。
这个版本补上了可直接跑通的导入/导出链路。

## 现在支持两种数据源

- `type: "api"`：对接接口（线上用）
- `type: "file"`：从本地 `csv/json` 导入库存，并把更新结果导出到 `csv/json`（本地联调、给运营导入）

## 最小可用流程（无需真实 API）

1. 准备店铺库存文件（仓库已内置示例）：
   - `packages/script/examples/rakuten/store-a.csv`
   - `packages/script/examples/rakuten/store-b.csv`
2. 准备 SKU 白名单（可选）：
   - `packages/script/examples/rakuten/skus.txt`
3. 运行一次同步：

```bash
bun packages/script/src/rakuten-sync.ts --config=packages/script/examples/rakuten-sync.config.json --once
```

4. 查看导出结果（可交给后续导入流程）：
   - `packages/script/examples/rakuten/out-main.csv`
   - `packages/script/examples/rakuten/out-sub.csv`

## 配置说明

```json
{
  "mode": "min",
  "dry_run": false,
  "once": true,
  "interval_sec": 60,
  "sku_file": "packages/script/examples/rakuten/skus.txt",
  "stores": [
    {
      "name": "rakuten-main",
      "type": "file",
      "pull_file": "packages/script/examples/rakuten/store-a.csv",
      "push_file": "packages/script/examples/rakuten/out-main.csv"
    }
  ]
}
```

### 顶层字段

- `mode`: `min | max | sum | first`
- `dry_run`: `true` 只计算不写出
- `once`: `true` 只跑一轮；否则按 `interval_sec` 循环
- `skus`: 直接写 SKU 数组
- `sku_file`: 每行一个 SKU；会和库存数据做过滤

### store 字段

- 通用：`name`
- `type: "api"` 时需要：
  - `base_url`
  - `app_id`
  - `token`
- `type: "file"` 时需要：
  - `pull_file`: 输入库存文件（csv/json）
  - `push_file`: 输出更新文件（csv/json）
  - 可选 `pull_format` / `push_format` 强制指定格式

## 文件格式

### CSV

```csv
sku,quantity
SKU-001,10
SKU-002,3
```

### JSON（任一格式都支持）

```json
{ "items": [{ "sku": "SKU-001", "quantity": 10 }] }
```

```json
[{ "sku": "SKU-001", "quantity": 10 }]
```

```json
{ "SKU-001": 10, "SKU-002": 3 }
```

## API 约定（type=api）

- `GET {base_url}/inventory?sku=SKU1,SKU2`
  - 返回：`{ "items": [{ "sku": "SKU-001", "quantity": 10 }] }`
- `POST {base_url}/inventory/batch`
  - 请求：`{ "updates": [{ "sku": "SKU-001", "quantity": 8 }] }`

如果你们真实乐天接口字段不同，只需要改 `pull()` 和 `push()` 的序列化映射。
