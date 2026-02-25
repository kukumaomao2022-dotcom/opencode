import path from "path"

type Mode = "min" | "max" | "sum" | "first"
type Src = "api" | "file"
type Fmt = "json" | "csv"

type Store = {
  name: string
  type?: Src
  base_url?: string
  app_id?: string
  token?: string
  pull_file?: string
  pull_format?: Fmt
  push_file?: string
  push_format?: Fmt
}

type Config = {
  mode?: Mode
  interval_sec?: number
  dry_run?: boolean
  skus?: string[]
  sku_file?: string
  once?: boolean
  stores: Store[]
}

type Item = {
  sku: string
  quantity: number
}

type Pull = {
  items: Item[]
}

type Push = {
  updates: Item[]
}

function parse(args: string[], key: string) {
  const p = args.find((x) => x.startsWith(`${key}=`))
  if (!p) return ""
  return p.slice(`${key}=`.length)
}

function abs(root: string, file: string) {
  if (path.isAbsolute(file)) return file
  return path.join(root, file)
}

async function mapFromFile(file: string, fmt: Fmt, pick?: Set<string>) {
  if (fmt === "json") {
    const body = (await Bun.file(file).json()) as Pull | Item[] | Record<string, number>
    const arr = Array.isArray(body)
      ? body
      : "items" in body
        ? body.items
        : Object.entries(body).map(([sku, quantity]) => ({ sku, quantity: Number(quantity) || 0 }))
    return new Map(
      arr
        .filter((x) => Number.isInteger(x.quantity))
        .filter((x) => (!pick ? true : pick.has(x.sku)))
        .map((x) => [x.sku, x.quantity]),
    )
  }
  const txt = await Bun.file(file).text()
  const row = txt
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
  const first = row[0]?.toLowerCase() || ""
  const off = first.includes("sku") && first.includes("quantity") ? 1 : 0
  return new Map(
    row
      .slice(off)
      .map((x) => x.split(",").map((v) => v.trim()))
      .filter((x) => x.length >= 2)
      .map((x) => ({ sku: x[0], quantity: Number(x[1]) || 0 }))
      .filter((x) => (!pick ? true : pick.has(x.sku)))
      .map((x) => [x.sku, x.quantity]),
  )
}

async function pushToFile(file: string, fmt: Fmt, updates: Item[]) {
  if (!updates.length) return
  if (fmt === "json") {
    await Bun.write(file, `${JSON.stringify({ updates }, null, 2)}\n`)
    return
  }
  const head = "sku,quantity\n"
  const body = updates.map((x) => `${x.sku},${x.quantity}`).join("\n")
  await Bun.write(file, `${head}${body}\n`)
}

function check(cfg: Config, root: string) {
  if (!cfg.stores.length) throw new Error("stores is required")
  const bad = cfg.stores.find((x) => {
    const t = x.type || "api"
    if (t === "api") return !x.name || !x.base_url || !x.app_id || !x.token
    return !x.name || !x.pull_file || !x.push_file
  })
  if (bad) throw new Error(`store config invalid: ${bad.name || "unknown"}`)
  if (!cfg.sku_file) return
  const f = abs(root, cfg.sku_file)
  if (!Bun.file(f).size) throw new Error(`sku_file not found: ${f}`)
}

async function pull(store: Store, root: string, pick?: Set<string>) {
  const t = store.type || "api"
  if (t === "file") {
    const f = abs(root, store.pull_file!)
    const fmt = store.pull_format || (f.endsWith(".csv") ? "csv" : "json")
    return await mapFromFile(f, fmt, pick)
  }
  const q = pick?.size ? `?sku=${encodeURIComponent([...pick].join(","))}` : ""
  const res = await fetch(`${store.base_url}/inventory${q}`, {
    headers: {
      Authorization: `Bearer ${store.token}`,
      "X-Application-Id": store.app_id!,
      "Content-Type": "application/json",
    },
  })
  if (!res.ok) throw new Error(`[${store.name}] pull failed: ${res.status} ${res.statusText}`)
  const body = (await res.json()) as Pull
  return new Map(
    body.items.filter((x) => (!pick ? true : pick.has(x.sku))).map((x) => [x.sku, x.quantity]),
  )
}

function target(all: Map<string, number>[], mode: Mode) {
  const set = new Set(all.flatMap((x) => [...x.keys()]))
  return new Map(
    [...set].map((sku) => {
      const arr = all.map((x) => x.get(sku)).filter((x): x is number => Number.isInteger(x))
      if (!arr.length) return [sku, 0]
      if (mode === "max") return [sku, Math.max(...arr)]
      if (mode === "sum") return [sku, arr.reduce((a, b) => a + b, 0)]
      if (mode === "first") return [sku, arr[0]]
      return [sku, Math.min(...arr)]
    }),
  )
}

function diff(now: Map<string, number>, next: Map<string, number>) {
  return [...next.entries()]
    .filter(([sku, qty]) => now.get(sku) !== qty)
    .map(([sku, quantity]) => ({ sku, quantity }))
}

async function push(store: Store, root: string, updates: Item[]) {
  if (!updates.length) return
  const t = store.type || "api"
  if (t === "file") {
    const f = abs(root, store.push_file!)
    const fmt = store.push_format || (f.endsWith(".csv") ? "csv" : "json")
    await pushToFile(f, fmt, updates)
    return
  }
  const res = await fetch(`${store.base_url}/inventory/batch`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${store.token}`,
      "X-Application-Id": store.app_id!,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ updates } satisfies Push),
  })
  if (!res.ok) throw new Error(`[${store.name}] push failed: ${res.status} ${res.statusText}`)
}

async function loadSku(cfg: Config, root: string) {
  if (cfg.skus?.length) return new Set(cfg.skus)
  if (!cfg.sku_file) return undefined
  const f = abs(root, cfg.sku_file)
  const txt = await Bun.file(f).text()
  return new Set(txt.split(/\r?\n/).map((x) => x.trim()).filter(Boolean))
}

async function once(cfg: Config, root: string) {
  const mode = cfg.mode || "min"
  const pick = await loadSku(cfg, root)
  const all = await Promise.all(cfg.stores.map((x) => pull(x, root, pick)))
  const t = target(all, mode)
  const jobs = cfg.stores.map((x, i) => ({ store: x, updates: diff(all[i], t) }))
  const total = jobs.reduce((n, x) => n + x.updates.length, 0)

  console.log(`[sync] mode=${mode} stores=${cfg.stores.length} sku=${t.size} updates=${total}`)
  jobs.forEach((x) => {
    if (!x.updates.length) return
    console.log(`[sync] ${x.store.name} -> ${x.updates.length} sku(s)`)
  })

  if (cfg.dry_run) return
  await Promise.all(jobs.map((x) => push(x.store, root, x.updates)))
}

async function loop(cfg: Config, root: string, one: boolean) {
  if (one || cfg.once) {
    await once(cfg, root)
    return
  }
  const step = (cfg.interval_sec || 60) * 1000
  while (true) {
    const begin = Date.now()
    await once(cfg, root)
    const wait = Math.max(0, step - (Date.now() - begin))
    console.log(`[sync] sleep=${wait}ms`)
    await Bun.sleep(wait)
  }
}

const args = Bun.argv.slice(2)
const file = parse(args, "--config")
if (!file) throw new Error("missing --config=/path/to/rakuten-sync.json")
const one = args.includes("--once")
const root = process.cwd()
const full = abs(root, file)
const cfg = (await Bun.file(full).json()) as Config
check(cfg, root)

console.log(`[sync] loaded ${cfg.stores.length} stores from ${full}`)
await loop(cfg, root, one)
