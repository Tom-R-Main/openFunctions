[English](../../README.md) | [Turkce](README.tr.md)

<p align="center">
  <img src="../../assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Once yapay zeka araclari olusturun. Ihtiyac duydugunuzda ajanlari bir araya getirin.</strong>
</p>

<p align="center">
  <a href="#quick-start">Hizli Baslangic</a> &middot;
  <a href="#the-mental-model">Zihinsel Model</a> &middot;
  <a href="#choose-the-right-primitive">Dogru Temeli Secin</a> &middot;
  <a href="#capability-ladder">Yetenek Merdiveni</a> &middot;
  <a href="#providers">Saglayicilar</a> &middot;
  <a href="#examples">Ornekler</a> &middot;
  <a href="#docs">Belgeler</a>
</p>

---

openFunctions, yapay zeka tarafindan cagrilabilir araclar olusturmak ve bunlari [MCP](https://modelcontextprotocol.io), sohbet adaptorleri, is akislari ve ajanlar araciligiyla sunmak icin MIT lisansli bir TypeScript framework'udur. Temel calisma zamani basittir:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Diger her sey bunun uzerine kuruludur:

- `workflows` araclar etrafinda deterministik orkestrasyondur
- `agents` filtrelenmis bir kayit defteri uzerinde LLM donguleridir
- `structured output` sentetik bir arac modelidir
- `memory` ve `rag` araclara geri sarilabilen durum bilgisi olan sistemlerdir

Arac calisma zamanini anlarsaniz, framework'un geri kalani anlasilir kalir.

```text
defineTool() -> registry.register() -> adapter/server executes tool
                                    -> workflows compose tools
                                    -> agents use filtered tools
                                    -> memory/rag expose more tools
```

## Hizli Baslangic

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

Ilk insa etmeniz gereken sey bir aractir, bir ajan degil.

## Zihinsel Model

Bir arac, is mantiginiz ve yapay zekanin okuyabilecegi bir semadir:

```typescript
import { defineTool, ok } from "../framework/index.js";

export const rollDice = defineTool({
  name: "roll_dice",
  description: "Roll a dice with the given number of sides", // Verilen yuz sayisina sahip bir zar at
  inputSchema: {
    type: "object",
    properties: {
      sides: { type: "number", description: "Number of sides (default 6)" }, // Yuz sayisi (varsayilan 6)
    },
  },
  handler: async ({ sides }) => {
    const rolled = Math.floor(Math.random() * ((sides as number) || 6)) + 1;
    return ok({ rolled });
  },
});
```

Bu tek tanim sunlar olabilir:

- `registry.execute()` tarafindan dogrudan calistirilabilir
- MCP uzerinden Claude/Desktop'a sunulabilir
- etkilesimli sohbet dongusunde kullanilabilir
- is akislarina birlestirilebilir
- ajana ozel kayit defterlerine filtrelenebilir

Daha fazlasini okuyun: [Mimari](docs/ARCHITECTURE.md)

## Dogru temeli secin

| Bunu kullanin | Istediginizde | Gercekte nedir |
|----------|---------------|-------------------|
| `defineTool()` | cagrilabilir yapay zeka odakli is mantigi | temel ilkel |
| `createChatAgent()` | bilesebilir, gomulubilir bir AI ajani | araclar + bellek + baglam + adaptor tek bir yapilandirmada |
| `pipe()` | deterministik orkestrasyon | kod odakli arac/LLM hatti |
| `defineAgent()` | adaptif cok adimli arac kullanimi | filtrelenmis bir kayit defteri uzerinde bir LLM dongusu |
| `createConversationMemory()` / `createFactMemory()` | is parcacigi/gercek durumu | kalicilik arti bellek araclari |
| `createRAG()` | anlamsal belge alma | pgvector + gomme + araclar |
| `connectProvider()` | dis sistemden baglam | ExecuFunction, Obsidian vb.'den yapilandirilmis araclar |
| `createStore()` / `createPgStore()` | kalicilik | depolama katmani, alma degil |

Genel kural:

- Bir aracla baslayin.
- Bellekli ve baglamli tam bir ajan istediginizde `createChatAgent()` kullanin.
- Sirayi bildiginizde bir is akisi kullanin.
- Takimlarda uzman ajanlara ihtiyac duydugunuzda `defineAgent()` kullanin.
- Kontrol ettiginiz durum icin bellek ekleyin.
- Anlamina gore belge almak icin RAG ekleyin.
- Dis sistemlere ihtiyac duydugunuzda (gorevler, takvimler, CRM) bir baglam saglayici ekleyin.

## Yetenek Merdiveni

### 1. Bir arac olusturun

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts` dosyasini duzenleyin, ardindan calistirin:

```bash
npm run test-tools
npm test
```

### 2. MCP veya sohbet araciligiyla sunun

```bash
npm start
npm run chat -- gemini
```

Ayni kayit defteri her ikisini de destekler.

### 3. Is akislariyla birlestirin

Is akislari, kontrol akisi acik kaldigi icin varsayilan "gelismis" ilkeldir:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Bir sohbet ajani olusturun

`createChatAgent()` araclari, bellegi, baglam saglayicilari ve bir AI adaptorunu tek bir gomulubilir ajanda birlestirir:

```typescript
import { createChatAgent } from "./framework/index.js";

const agent = await createChatAgent({
  provider: "gemini",
  preset: "study-buddy",
  memory: true,                    // konusma + gercek bellegi (varsayilan olarak acik)
  providers: ["execufunction"],    // dis baglami bagla
});

// Dort kullanim yolu:
await agent.interactive();                          // CLI
const result = await agent.chat("Create a task");   // programatik
for await (const chunk of agent.chat("hello", { stream: true })) { ... }  // akis
await agent.serve({ port: 3000 });                  // HTTP sunucusu
```

Ayni yapilandirma koddan, CLI bayraklarindan veya YAML dosyalarindan calisir. Bellek varsayilan olarak aciktir — ajan oturumlar arasinda hatilar.

### 5. Ajanlarla adaptif davranis ekleyin

`defineAgent()` takimlardaki ve is akislarindaki uzmanlastirilmis ajanlar icindir — filtrelenmis kayit defterleri ve akil yurutme donguleri:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst", // Arastirma Analisti
  goal: "Find accurate information using available tools", // Mevcut araclari kullanarak dogru bilgi bul
  toolTags: ["search"],
});
```

Birden fazla uzman ajanin isbirligi yapmasi gerektiginde ekipleri kullanin.

### 6. Yalnizca gerektiginde durum ekleyin

Kalicilik:

```typescript
const tasks = createStore<Task>("tasks");
const tasksPg = await createPgStore<Task>("tasks");
```

Bellek:

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

RAG belgeleri: [docs/RAG.md](docs/RAG.md)

### 7. Dis baglami baglayin

Baglam saglayicilari dis sistemleri (gorev yoneticileri, takvimler, CRM, bilgi tabanlari) ajan calisma zamanina arac olarak baglar:

```typescript
import { connectProvider, contextPrompt } from "./framework/index.js";
import { createExecuFunctionProvider } from "./providers/execufunction/index.js";

// Baglanti — "context" + "context:execufunction" etiketli 17 araci kaydeder
const exf = await connectProvider(
  createExecuFunctionProvider({ token: process.env.EXF_PAT }),
  registry,
);

// Aktif gorevleri + yaklasan olaylari ajan sistem promptlarina enjekte eder
const context = await contextPrompt([exf]);
```

`ContextProvider` arayuzu takiLabalirdir — herhangi bir backend'i framework'e entegre etmek icin `metadata`, `connect()` ve `createTools()` metodlarini uygulayin. Tam arayuz icin [Mimari](docs/ARCHITECTURE.md#context-providers) belgelerine bakin.

| Saglayici | Durum | Yetenekler |
|----------|--------|--------------|
| [ExecuFunction](src/providers/execufunction/) | Yerlesik | gorevler, projeler, takvim, bilgi, kisiler, organizasyonlar, kod tabani |
| Obsidian | Sablon (planlanmis) | bilgi |
| Notion | Sablon (planlanmis) | bilgi, gorevler, projeler |

## Komutlar

```bash
npm run test-tools          # Etkilesimli CLI — araclari yerel olarak test edin
npm run dev                 # Gelistirme modu — kaydetmede otomatik yeniden baslatma
npm test                    # Arac tanimli otomatik testleri calistirin
npm run chat                # Araclarinizi kullanarak yapay zeka ile sohbet edin
npm run chat -- gemini      # Belirli bir saglayiciyi zorlayin
npm run chat -- --no-memory # Kalici bellek olmadan sohbet edin
npm run create-tool <name>  # Yeni bir arac iskeleti olusturun
npm run docs                # Arac referans belgelerini olusturun
npm run inspect             # MCP Inspector web kullanici arayuzu
npm start                   # Claude Desktop / Cursor icin MCP sunucusunu baslatin
```

## Saglayicilar

`.env` dosyasinda bir API anahtari ayarlayin, sohbet dongusu saglayiciyi otomatik olarak algilayacaktir.

| Saglayici | Varsayilan Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Ornekler:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Test Etme

Testler arac tanimlariyla birlikte bulunur:

```typescript
defineTool({
  name: "create_task",
  // ...
  tests: [
    { name: "creates a task", input: { title: "Read ch5", subject: "Bio" }, expect: { success: true } }, // bir gorev olusturur
    { name: "fails without subject", input: { title: "Read ch5" }, expect: { success: false } }, // konu olmadan basarisiz olur
  ],
});
```

Kayit defteri, isleyiciler calismadan once parametreleri dogrular, boylece sema hatalari hem insanlar hem de LLM'ler icin yeterince acik bir sekilde ortaya cikar ve duzeltinebilir.

## Ornekler

| Alan | Araclar | Desen |
|--------|-------|---------|
| Calisma Takipcisi | `create_task`, `list_tasks`, `complete_task` | CRUD + Depolama |
| Yer Isareti Yoneticisi | `save_link`, `search_links`, `tag_link` | Diziler + Arama |
| Tarif Saklayici | `save_recipe`, `search_recipes`, `get_random` | Ic Ice Veri + Rastgele |
| Harcama Bolucu | `add_expense`, `split_bill`, `get_balances` | Matematik + Hesaplamalar |
| Antrenman Kaydedici | `log_workout`, `get_stats`, `suggest_workout` | Tarih Filtreleme + Istatistikler |
| Sozluk | `define_word`, `find_synonyms` | Harici API (anahtar yok) |
| Sinav Olusturucu | `create_quiz`, `answer_question`, `get_score` | Durum Bilgisi Olan Oyun |
| Yapay Zeka Araclari | `summarize_text`, `generate_flashcards` | Arac Bir LLM'i Cagirir |
| Yardimci Programlar | `calculate`, `convert_units`, `format_date` | Durum Bilgisi Olmayan Yardimcilar |

## Belgeler

- [Mimari](docs/ARCHITECTURE.md): calisma zamani modeli, filtrelenmis kayit defterleri, sentetik araclar ve yurutme yollari
- [RAG](docs/RAG.md): anlamsal parcalama, Gemini/OpenAI gommeleri, pgvector semasi, HNSW arama ve arac entegrasyonu

## Eklentiler

### ExecuFunction icin OpenClaw

[`@openfunctions/openclaw-execufunction`](plugins/openclaw-execufunction/) eklentisi [ExecuFunction](https://execufunction.com)'i [OpenClaw](https://github.com/openclaw/openclaw) ajan ekosistemine getirir — 6 alanda 17 arac:

| Alan | Araclar | Ne yapar |
|--------|-------|--------------|
| Gorevler | `exf_tasks_list`, `exf_tasks_create`, `exf_tasks_update`, `exf_tasks_complete` | Onceliklerle yapilandirilmis gorev yonetimi (do_now/do_next/do_later/delegate/drop) |
| Takvim | `exf_calendar_list`, `exf_calendar_create`, `exf_calendar_update` | Olay zamanlama ve arama |
| Bilgi | `exf_notes_search`, `exf_notes_create`, `exf_notes_get` | Bilgi tabaninda anlamsal arama |
| Projeler | `exf_projects_list`, `exf_projects_context` | Proje durumu ve tam baglam (gorevler, notlar, sinyaller) |
| Kisiler/CRM | `exf_people_search`, `exf_person_create`, `exf_org_search` | Iletisim ve organizasyon yonetimi |
| Kod Tabani | `exf_codebase_search`, `exf_code_who_knows` | Anlamsal kod arama ve uzmanlik takibi |

Kurulum:

```bash
openclaw plugins install @openfunctions/openclaw-execufunction
```

Ortaminizda `EXF_PAT` degiskenini ayarlayin (veya OpenClaw eklenti ayarlari uzerinden yapilandirin) ve OpenClaw ajaniniz kalici gorevler, takvim farkindailigi, anlamsal bilgi arama, CRM ve kod zekasi kazanir — ExecuFunction'in bulut API'si tarafindan desteklenir.

Detaylar icin [eklenti README](plugins/openclaw-execufunction/) belgesine bakin.

## Proje Yapisi

```text
openFunctions/
├── src/
│   ├── framework/              # Cekirdek calisma zamani + kompozisyon katmanlari
│   │   ├── chat-agent.ts       # createChatAgent() — bilesebilir sohbet ajani fabrikasi
│   │   ├── chat-agent-types.ts # ChatAgent, ChatAgentConfig, ChatResult turleri
│   │   ├── chat-agent-resolve.ts # Yapilandirma cozumlemesi, saglayici otomatik algilama
│   │   ├── chat-agent-http.ts  # agent.serve() icin HTTP sunucusu
│   │   ├── context.ts          # Baglam saglayici arayuzu
│   │   └── ...                 # tool, registry, agents, memory, rag, workflows
│   ├── providers/
│   │   └── execufunction/      # ExecuFunction baglam saglayicisi (referans uygulama)
│   ├── examples/               # Referans arac desenleri
│   ├── my-tools/               # Sizin araclariniz
│   └── index.ts                # MCP giris noktasi
├── plugins/
│   └── openclaw-execufunction/ # OpenClaw icin ExecuFunction eklentisi
├── docs/                       # Mimari belgeler
├── scripts/                    # sohbet, arac-olustur, belgeler
├── test-client/                # CLI test araci + test calistirici
├── system-prompts/             # Istek on ayarlari
└── package.json
```

## Lisans

MIT — bkz. [LICENSE](LICENSE)
