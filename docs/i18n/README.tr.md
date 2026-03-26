[English](../README.md) | [Turkish](README.tr.md)

<p align="center">
  <img src="assets/logo.svg" alt="openFunctions" width="600">
</p>

<p align="center">
  <strong>Önce yapay zeka araçları oluşturun. İhtiyaç duyduğunuzda ajanları bir araya getirin.</strong>
</p>

<p align="center">
  <a href="#quick-start">Hızlı Başlangıç</a> &middot;
  <a href="#the-mental-model">Zihinsel Model</a> &middot;
  <a href="#choose-the-right-primitive">Doğru Temeli Seçin</a> &middot;
  <a href="#capability-ladder">Yetenek Merdiveni</a> &middot;
  <a href="#providers">Sağlayıcılar</a> &middot;
  <a href="#examples">Örnekler</a> &middot;
  <a href="#docs">Belgeler</a>
</p>

---

openFunctions, yapay zeka tarafından çağrılabilir araçlar oluşturmak ve bunları [MCP](https://modelcontextprotocol.io), sohbet adaptörleri, iş akışları ve ajanlar aracılığıyla sunmak için MIT lisanslı bir TypeScript framework'üdür. Temel çalışma zamanı basittir:

`ToolDefinition -> ToolRegistry -> AIAdapter`

Diğer her şey bunun üzerine kuruludur:

- `iş akışları` araçlar etrafında deterministik orkestrasyondur
- `ajanlar` filtrelenmiş bir kayıt defteri üzerinde LLM döngüleridir
- `yapılandırılmış çıktı` sentetik bir araç modelidir
- `bellek` ve `rag` araçlara geri sarılabilen durum bilgisi olan sistemlerdir

Araç çalışma zamanını anlarsanız, framework'ün geri kalanı anlaşılır kalır.

```text
defineTool() -> registry.register() -> adapter/server executes tool // adaptör/sunucu aracı çalıştırır
                                    -> workflows compose tools // iş akışları araçları birleştirir
                                    -> agents use filtered tools // ajanlar filtrelenmiş araçları kullanır
                                    -> memory/rag expose more tools // bellek/rag daha fazla araç sunar
```

## Hızlı Başlangıç

```bash
git clone https://github.com/Tom-R-Main/openFunctions.git
cd openFunctions
bash setup.sh
cp .env.example .env
npm run test-tools
```

İlk inşa etmeniz gereken şey bir araçtır, bir ajan değil.

## Zihinsel Model

Bir araç, iş mantığınız ve yapay zekanın okuyabileceği bir şemadır:

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

Bu tek tanım şunlar olabilir:

- `registry.execute()` tarafından doğrudan çalıştırılabilir
- MCP üzerinden Claude/Desktop'a sunulabilir
- etkileşimli sohbet döngüsünde kullanılabilir
- iş akışlarına birleştirilebilir
- ajana özel kayıt defterlerine filtrelenebilir

Daha fazlasını okuyun: [Mimari](docs/ARCHITECTURE.md)

## Doğru Temeli Seçin

| Bunu kullanın | İstediğinizde | Gerçekte nedir |
|----------|---------------|-------------------|
| `defineTool()` | çağrılabilir yapay zeka odaklı iş mantığı | temel ilkel |
| `pipe()` | deterministik orkestrasyon | kod odaklı araç/LLM hattı |
| `defineAgent()` | adaptif çok adımlı araç kullanımı | filtrelenmiş bir kayıt defteri üzerinde bir LLM döngüsü |
| `createConversationMemory()` / `createFactMemory()` | iş parçacığı/gerçek durumu | kalıcılık artı bellek araçları |
| `createRAG()` | anlamsal belge alma | pgvector + gömme + araçlar |
| `createStore()` / `createPgStore()` | kalıcılık | depolama katmanı, alma değil |

Genel kural:

- Bir araçla başlayın.
- Sırayı bildiğinizde bir iş akışı kullanın.
- Bir ajanı yalnızca modelin bir sonraki adımı seçmesi gerektiğinde kullanın.
- Kontrol ettiğiniz durum için bellek ekleyin.
- Anlamına göre belge almak için RAG ekleyin.

## Yetenek Merdiveni

### 1. Bir araç oluşturun

```bash
npm run create-tool expense_tracker
```

`src/my-tools/expense_tracker.ts` dosyasını düzenleyin, ardından çalıştırın:

```bash
npm run test-tools
npm test
```

### 2. MCP veya sohbet aracılığıyla sunun

```bash
npm start
npm run chat -- gemini
```

Aynı kayıt defteri her ikisini de destekler.

### 3. İş akışlarıyla birleştirin

İş akışları, kontrol akışı açık kaldığı için varsayılan "gelişmiş" ilkeldir:

```typescript
import { pipe, toolStep, llmStep } from "./framework/index.js";

const research = pipe(toolStep(registry, "define_word"))
  .then(async (result) => result.data?.meanings?.[0] ?? "")
  .then(llmStep(adapter, registry, "Explain this simply: {{input}}"));

await research.run({ word: "ephemeral" });
```

### 4. Ajanlarla adaptif davranış ekleyin

Ajanlar aynı araçları kullanır, ancak filtrelenmiş bir kayıt defteri ve bir akıl yürütme döngüsü aracılığıyla:

```typescript
import { defineAgent } from "./framework/index.js";

const researcher = defineAgent({
  name: "researcher",
  role: "Research Analyst",
  goal: "Find accurate information using available tools",
  toolTags: ["search"],
});
```

Birden fazla uzman ajanın işbirliği yapması gerektiğinde ekipleri kullanın.

### 5. Yalnızca gerektiğinde durum ekleyin

Kalıcılık:

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

## Komutlar

```bash
npm run test-tools          # Etkileşimli CLI — araçları yerel olarak test edin
npm run dev                 # Geliştirme modu — kaydetmede otomatik yeniden başlatma
npm test                    # Araç tanımlı otomatik testleri çalıştırın
npm run chat                # Araçlarınızı kullanarak yapay zeka ile sohbet edin
npm run chat -- gemini      # Belirli bir sağlayıcıyı zorlayın
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
npm run create-tool <name>  # Yeni bir araç iskeleti oluşturun
npm run docs                # Araç referans belgelerini oluşturun
npm run inspect             # MCP Inspector web kullanıcı arayüzü
npm start                   # Claude Desktop / Cursor için MCP sunucusunu başlatın
```

## Sağlayıcılar

`.env` dosyasında bir API anahtarı ayarlayın, sohbet döngüsü sağlayıcıyı otomatik olarak algılayacaktır.

| Sağlayıcı | Varsayılan Model | API |
|----------|---------------|-----|
| Gemini | `gemini-3-flash-preview` | Function calling |
| OpenAI | `gpt-5.4` | Responses API |
| Anthropic | `claude-sonnet-4-6` | Messages + tool_use |
| xAI | `grok-4.20-0309-reasoning` | Responses API |
| OpenRouter | `google/gemini-3-flash-preview` | OpenAI-compatible |

Örnekler:

```bash
npm run chat
npm run chat -- gemini
npm run chat -- openai gpt-5.4-pro
npm run chat -- gemini --prompt study-buddy
```

## Test Etme

Testler araç tanımlarıyla birlikte bulunur:

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

Kayıt defteri, işleyiciler çalışmadan önce parametreleri doğrular, böylece şema hataları hem insanlar hem de LLM'ler için yeterince açık bir şekilde ortaya çıkar ve düzeltilebilir.

## Örnekler

| Alan | Araçlar | Desen |
|--------|-------|---------|
| Çalışma Takipçisi | `create_task`, `list_tasks`, `complete_task` | CRUD + Depolama |
| Yer İşareti Yöneticisi | `save_link`, `search_links`, `tag_link` | Diziler + Arama |
| Tarif Saklayıcı | `save_recipe`, `search_recipes`, `get_random` | İç İçe Veri + Rastgele |
| Harcama Bölücü | `add_expense`, `split_bill`, `get_balances` | Matematik + Hesaplamalar |
| Antrenman Kaydedici | `log_workout`, `get_stats`, `suggest_workout` | Tarih Filtreleme + İstatistikler |
| Sözlük | `define_word`, `find_synonyms` | Harici API (anahtar yok) |
| Sınav Oluşturucu | `create_quiz`, `answer_question`, `get_score` | Durum Bilgisi Olan Oyun |
| Yapay Zeka Araçları | `summarize_text`, `generate_flashcards` | Araç Bir LLM'i Çağırır |
| Yardımcı Programlar | `calculate`, `convert_units`, `format_date` | Durum Bilgisi Olmayan Yardımcılar |

## Belgeler

- [Mimari](docs/ARCHITECTURE.md): çalışma zamanı modeli, filtrelenmiş kayıt defterleri, sentetik araçlar ve yürütme yolları
- [RAG](docs/RAG.md): anlamsal parçalama, Gemini/OpenAI gömmeleri, pgvector şeması, HNSW arama ve araç entegrasyonu

## Proje Yapısı

```text
openFunctions/
├── src/
│   ├── framework/              // Çekirdek çalışma zamanı + kompozisyon katmanları
│   ├── examples/               // Referans araç desenleri
│   ├── my-tools/               // Sizin araçlarınız
│   └── index.ts                // MCP giriş noktası
├── docs/                       // Mimari belgeler
├── scripts/                    // sohbet, araç oluştur, belgeler
├── test-client/                // CLI test aracı + test çalıştırıcı
├── system-prompts/             // İstek ön ayarları
└── package.json
```

## Lisans

MIT — bkz. [LICENSE](LICENSE)
