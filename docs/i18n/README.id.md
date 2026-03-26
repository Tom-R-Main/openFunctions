[English](../README.md) | [Indonesian](README.id.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Bangun alat AI terlebih dahulu. Susun agen saat Anda membutuhkannya.</strong>
</p>

<p align="center">
  <a href="#quick-start">Mulai Cepat</a> &middot;
  <a href="#the-mental-model">Model Mental</a> &middot;
  <a href="#choose-the-right-primitive">Pilih Primitif yang Tepat</a> &middot;
  <a href="#capability-ladder">Tangga Kemampuan</a> &middot;
  <a href="#providers">Penyedia</a> &middot;
  <a href="#examples">Contoh</a> &middot;
  <a href="#docs">Dokumentasi</a>
</p>

---

openFunctions adalah kerangka kerja TypeScript berlisensi MIT untuk membangun alat yang dapat dipanggil AI dan mengeksposnya melalui [MCP](https://modelcontextprotocol.io), adapter obrolan, alur kerja, dan agen. Runtime intinya sederhana:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Semua hal lain tersusun di atas itu:

- `workflows` adalah orkestrasi deterministik di sekitar alat
- `agents` adalah loop LLM di atas registri yang difilter
- `structured output` adalah pola alat sintetis
- `memory` dan `rag` adalah sistem stateful yang dapat dibungkus kembali menjadi alat

Jika Anda memahami runtime alat, sisa kerangka kerja akan tetap mudah dipahami.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Mulai Cepat

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Hal pertama yang harus dibangun adalah alat, bukan agen.

## Model Mental

Alat adalah logika bisnis Anda ditambah skema yang dapat dibaca AI:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides",
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" },
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Satu definisi itu dapat:

- dieksekusi langsung oleh `registry.execute()`
- diekspos ke Claude/Desktop melalui MCP
- digunakan di dalam loop obrolan interaktif
- disusun menjadi alur kerja
- difilter ke dalam registri khusus agen

Baca lebih lanjut: [Arsitektur](docs/ARCHITECTURE.md)

## Pilih Primitif yang Tepat

| Gunakan ini | Ketika Anda ingin | Apa sebenarnya ini |
|----------|---------------|-------------------|
| `defineTool()` | logika bisnis yang dapat dipanggil AI | primitif inti |
| `pipe()` | orkestrasi deterministik | pipeline alat/LLM berbasis kode |
| `defineAgent()` | penggunaan alat multi-langkah adaptif | loop LLM di atas registri yang difilter |
| `createConversationMemory()` / `createFactMemory()` | status thread/fakta | persistensi ditambah alat memori |
| `createRAG()` | pengambilan dokumen semantik | pgvector + embeddings + alat |
| `createStore()` / `createPgStore()` | persistensi | lapisan penyimpanan, bukan pengambilan |

Aturan praktis:

- Mulai dengan sebuah alat.
- Gunakan alur kerja ketika Anda mengetahui urutannya.
- Gunakan agen hanya ketika model perlu memilih apa yang harus dilakukan selanjutnya.
- Tambahkan memori untuk status yang Anda kendalikan.
- Tambahkan RAG untuk pengambilan dokumen berdasarkan makna.

## Tangga Kemampuan

### 1. Bangun sebuah alat

```bash
npm run create-tool expense_tracker
```

Edit `src/my-tools/expense_tracker.ts`, lalu jalankan:

```bash
npm run test-tools
npm test
```

### 2. Ekspos melalui MCP atau obrolan

```bash
npm start
npm run chat -- gemini
```

Registri yang sama mendukung keduanya.

### 3. Susun dengan alur kerja

Alur kerja adalah primitif "tingkat lanjut" bawaan karena alur kontrol tetap eksplisit:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Tambahkan perilaku adaptif dengan agen

Agen menggunakan alat yang sama, tetapi melalui registri yang difilter dan loop penalaran:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Gunakan kru ketika beberapa agen khusus perlu berkolaborasi.

### 5. Tambahkan status hanya jika diperlukan

Persistensi:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Memori:

```typescript
const conversations = createConversationMemory();
const facts = createFactMemory();
registry.registerAll(createMemoryTools(conversations, facts));
```

RAG:

```typescript
const rag = await createRAG({ embeddingProvider: "gemini" });
registry.registerAll(rag.createTools());
```

Dokumentasi RAG: [docs/RAG.md](docs/RAG.md)

## Perintah

```bash
npm run test-tools          # CLI Interaktif — uji alat secara lokal
npm run dev                 # Mode Dev — restart otomatis saat disimpan
npm test                    # Jalankan tes otomatis yang ditentukan alat
npm run chat                # Obrolan dengan AI menggunakan alat Anda
npm run chat -- gemini      # Paksa penyedia tertentu
npm run create-tool <name>  # Buat kerangka alat baru
npm run docs                # Hasilkan dokumentasi referensi alat
npm run inspect             # UI web MCP Inspector
npm start                   # Mulai server MCP untuk Claude Desktop / Cursor
```

## Penyedia

Atur satu kunci API di `.env` dan loop obrolan akan secara otomatis mendeteksi penyedia.

| Penyedia | Model Bawaan | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Contoh:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Pengujian

Tes berada bersama definisi alat:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } },
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } },
  ],
});
```

Registri memvalidasi parameter sebelum handler berjalan, sehingga kesalahan skema ditampilkan dengan cukup jelas agar manusia dan LLM dapat memulihkan diri.

## Contoh

| Domain | Alat | Pola |
|--------|-------|---------|
| Pelacak Studi | `create_task`, `list_tasks`, `complete_task` | CRUD + Store |
| Manajer Penanda | `save_link`, `search_links`, `tag_link` | Array + Pencarian |
| Penyimpan Resep | `save_recipe`, `search_recipes`, `get_random` | Data Bersarang + Acak |
| Pembagi Pengeluaran | `add_expense`, `split_bill`, `get_balances` | Matematika + Perhitungan |
| Pencatat Latihan | `log_workout`, `get_stats`, `suggest_workout` | Pemfilteran Tanggal + Statistik |
| Kamus | `define_word`, `find_synonyms` | API Eksternal (tanpa kunci) |
| Generator Kuis | `create_quiz`, `answer_question`, `get_score` | Permainan Stateful |
| Alat AI | `summarize_text`, `generate_flashcards` | Alat Memanggil LLM |
| Utilitas | `calculate`, `convert_units`, `format_date` | Pembantu Tanpa Status |

## Dokumentasi

- [Arsitektur](docs/ARCHITECTURE.md): model runtime, registri yang difilter, alat sintetis, dan jalur eksekusi
- [RAG](docs/RAG.md): pemotongan semantik, embeddings Gemini/OpenAI, skema pgvector, pencarian HNSW, dan integrasi alat

## Struktur Proyek

```text
openFunctions/
├── src/
│   ├── framework/              # Runtime inti + lapisan komposisi
│   ├── examples/               # Pola alat referensi
│   ├── my-tools/               # Alat Anda
│   └── index.ts                # Titik masuk MCP
├── docs/                       # Dokumentasi arsitektur
├── scripts/                    # obrolan, buat-alat, dokumentasi
├── test-client/                # Penguji CLI + pelari tes
├── system-prompts/             # Preset prompt
└── package.json
```

## Lisensi

MIT — lihat [LICENSE](LICENSE)
