# 用瀏覽器插件把分頁播放的英文錄音轉成文字稿：可行性研究

- 日期：2026-10-24
- 負責：tofel session（研究後直接實作，程式在本 repo）
- 問題：「你有辦法幫我做一個網頁插件，可以把英文播放的錄音做出文字稿嗎？」使用者選了「本機 Whisper」與「每句前面加時間」。

## 先說結論

1. 做得到，而且在 Brave 155 實測過整條流程。分頁音訊 → 本機 Whisper → 側邊欄文字稿，75 秒朗讀轉出 13 句、230 個字，內容和原文幾乎一致。
2. 這台電腦只用 CPU 就夠快。small.en 轉 60 秒錄音中位數 10.0 秒（最慢 10.1 秒），比播放快 6 倍。實際邊播邊轉時，每段 6–13 秒的錄音約 2–2.8 秒轉完，文字大約在講完一句後 3–15 秒出現。
3. 比原先方案更省的地方：改用 native messaging，讓瀏覽器在錄音時才啟動本機程式、停止就結束。不用常駐伺服器，也不開本機網路埠。
4. 建議維持 CPU＋small.en。之後若使用者在 Ubuntu 裝了 NVIDIA 驅動，再加 CUDA 函式庫改用 GPU＋medium.en。
5. 後來追加的日文（第 7 節）、顯示卡與即時字幕（第 8 節）、泰文與可開關的雙語字幕（第 9 節）都已實作，並通過端到端測試。
6. 第一次在真實 Brave 視窗使用時，配樂多、講話少的段落讓字幕卡住 4–12 秒。原因是 Whisper 卡在重複同一句，已依講話長度限制產生長度，並減少即時字幕的重試次數。講話一兩秒的段落，最壞情況從約 10 秒降到約 2 秒；講話越多，上限越高；講話 7 秒以上的段落沒有改變（第 10 節）。
7. 連續的狀聲詞、附和（「うん。うん。…」）會讓字幕卡住 8–16 秒，一段塞進約 300 字。這是 faster-whisper 把真的重複當成失敗、換六個溫度重試造成的。現在狀聲詞不再重試，重複的部分縮成 3 次加「…」，網頁字幕框也加了高度上限，可以拖右下角改大小（第 11 節）。
8. 錄音中換頁不會中斷錄音，連換到別的網站也一樣；只有網頁字幕框會在整頁重新載入時不見。現在載入完會自動補回，插件因此多要了所有網站的權限。開始錄音仍要在那個分頁點圖示，這是瀏覽器的規定，給所有網站的權限也一樣（第 12 節）。

## 名詞

- **tabCapture**：Chrome 插件 API，可以在使用者點插件圖示後取得該分頁的聲音。
- **offscreen document（背景錄音頁）**：Manifest V3 插件的背景 service worker 不能用麥克風或錄音 API，要開一個看不見的頁面來錄。
- **native messaging**：插件和本機程式透過標準輸入輸出交換 JSON 的機制。瀏覽器依登記檔啟動程式，連線斷了程式就結束。
- **faster-whisper**：用 CTranslate2 重新實作的 OpenAI Whisper 語音辨識，CPU 上比原版快。
- **VAD（語音活動偵測）**：判斷哪裡有人在講話，用來在停頓處切段、跳過靜音。

## 1. 正確性

- 測試語料：LibriVox《Alice in Wonderland in Words of One Syllable》第 2 章（公有領域朗讀，22 kHz mono mp3）。
- small.en 和 base.en 轉同一段 60 秒錄音的差別：base.en 把 "how odd the address will look" 聽成 "How art the address will look"；small.en 正確。
- 端到端（tests/e2e.mjs）在 Brave 155 headless 跑了三種長度（30、40、75 秒），每次都通過以下檢查：
  - 轉出句數大於 0，字數至少每秒 1 字
  - 時間依序遞增，最後一句沒有超出錄音長度
  - 停止後回到待命，背景錄音頁已關閉
  - 錄音中沒有警告（聲音有播回喇叭），音量條有在動
  - 在不能錄音的頁面按開始時，出現白話提示，也沒有殘留背景錄音頁
- 已知的辨識弱點：專有名詞前後不一致（同一段裡 Mabel 有時轉成 Maybelle）。這是 Whisper 模型本身的限制。

## 2. 速度

量法：`docs/research/tab-transcription/bench_whisper.py`，取第 60–120 秒，int8、8 執行緒、beam 5、開 VAD，每個模型跑 3 次。

| 模型 | 載入（含第一次下載） | 60 秒錄音中位數 | 最慢 | 比播放快 |
|---|---|---|---|---|
| base.en | 8.1 秒 | 7.2 秒 | 7.5 秒 | 8.3 倍 |
| small.en | 17.1 秒 | 10.0 秒 | 10.1 秒 | 6.0 倍 |

環境：HP OMEN 17-cb1xxx、12 執行緒 CPU、14 GB RAM、Ubuntu 26.04.1、核心 7.0。RTX 2060 目前跑 nouveau 驅動，沒有 CUDA。模型下載完後再啟動，從啟動到可以轉文字約 1.6 秒。

實際邊播邊轉（host.log，3 次 e2e 共 17 段）：6.0–12.8 秒的段落，轉換時間 1.86–2.82 秒。Whisper 每段都會補滿 30 秒視窗，所以短段落也有約 2 秒的固定成本。

## 3. 大小與記憶體

- small.en 模型 484 MB，在 `~/.cache/huggingface/hub/blobs`。
- Python 環境（host/.venv）401 MB。
- 本機程式轉 25 秒段落時，最高 RSS 1.29 GB（`/usr/bin/time -v`）。只在錄音期間存在。

## 4. 替代方案比較

| 方案 | 使用者看到的 | 成本與風險 | 結論 |
|---|---|---|---|
| **插件＋native messaging＋本機 faster-whisper**（採用） | 邊播邊出字，可以複製和下載 | 免費、不上傳；要跑一次 install.sh | 採用 |
| 插件＋本機 HTTP 伺服器 | 一樣 | 要常駐或手動開伺服器，而且任何網頁都能打 localhost | 被 native messaging 取代 |
| 插件內跑 Whisper（transformers.js） | 一樣 | 只能用 CPU WebAssembly，要把 ONNX runtime 打包進插件（MV3 禁止載入遠端程式碼） | 較慢，沒採用 |
| Web Speech API（`SpeechRecognition.start(audioTrack)`） | 一樣 | MDN 標示為實驗功能、不是 Baseline；Brave 不提供 Google 語音服務 | 沒實測，不建議依賴 |
| 雲端 API（OpenAI 等） | 最準 | 要 API key、按分鐘計費、聲音上傳 | 使用者沒選 |
| 瀏覽器內建「即時字幕」 | 只顯示字幕 | 不能存成文字稿 | 不符合需求 |

## 5. 對現有架構的影響

- 新專案，沒有既有程式。
- 在使用者的瀏覽器設定資料夾各新增一個登記檔，`uninstall.sh` 可以移除：
  - `~/.config/BraveSoftware/Brave-Browser/NativeMessagingHosts/com.tab_transcriber.host.json`
  - `~/.config/google-chrome/NativeMessagingHosts/` 下的同名檔
  - `~/.config/chromium/NativeMessagingHosts/` 下的同名檔
- 實測發現：Brave 155 即使用 `--user-data-dir` 換了設定檔，仍然只到預設設定資料夾找登記檔，所以 e2e 測試依賴 install.sh 裝好的登記檔。

## 6. 建議與分階段

1. **現在**：CPU＋small.en。驗收方式是使用者在自己的 Brave 視窗裡實際操作，確認三件事：
   - 點圖示會開側邊欄
   - 錄音時聽得到聲音
   - 文字稿正確
2. **之後（使用者裝 NVIDIA 驅動以後）**：在 host 加 CUDA 12／cuDNN 9 函式庫。程式已經會偵測 CUDA 並改用 medium.en，偵測失敗會退回 CPU。這條路徑還沒測過。
3. **可能的改進（等使用者回饋）**：
   - 時間對齊影片本身的播放時間（要讀頁面上 `<video>`／`<audio>` 的 currentTime）
   - 點時間跳回該處

**不建議**：在這台 CPU 上預設用 medium.en。它的計算量約是 small.en 的 3 倍，邊播邊轉時，在其他程式搶 CPU 的情況下可能跟不上（估計，沒有量）。

## 7. 追加：日文（2026-10-24）

使用者問「日文也可以嗎」。英文專用模型（*.en）不能轉日文，所以改成依側邊欄選的語言載入不同模型。

- 語料：LibriVox《ごんぎつね》（新美南吉）第 1 段，取第 60–120 秒。
- small 多語言模型：60 秒錄音中位數 11.6 秒，最慢 19.1 秒，比播放快 5.2 倍。
- 日文端到端測試（30、40 秒）通過，記憶體用量和英文差不多。
- 錯誤舉例：
  - 「穴からはい出ました」轉成「穴から入れました」，意思相反
  - 「菜種がら」轉成「なたね柄」
  - 「畑へ入って」少了「へ」
- 日文預設用 small。medium／large-v3-turbo 沒有量完，原因見下面的事故。

### 事故：測速時整台電腦記憶體耗盡

- 經過：01:04 開始測 medium，01:06:59 systemd-oomd 收掉整個 kitty 終端機（210 個程序，所有 Claude session 一起被關），01:07:00 核心收掉使用者的 Brave。
- 主因：tests/e2e.mjs 只 kill 了 `brave-browser` 腳本。腳本啟動瀏覽器時沒有 exec，瀏覽器主程式還會自己另開 process group，結果 6 次測試留下 6 個 headless Brave，約 3 GB。
- 修法：結束時先送 CDP `Browser.close`，再掃 /proc 找帶 `--user-data-dir=<設定檔>` 的程序逐一結束，並把「殘留 0 個」列為測試檢查項目。之後每次測試的殘留都是 0。
- 使用者裁示：不把「重工作一律加記憶體上限」變成規則（2026-10-24）。

### 即時翻譯（等 GPU）

- 使用者想要把每句翻成繁體中文。
- Brave 155 有 `Translator` API，`availability()` 回 downloadable，但 `create()` 失敗（Unable to create translator），一般網頁和插件頁面都一樣。這是 headless 實測的結果。
- 使用者決定等 Ubuntu 裝好 NVIDIA 驅動，再用顯示卡跑本機 AI 模型翻譯。

## 8. 追加：顯示卡與即時字幕（2026-10-24）

使用者在 Ubuntu 裝好 nvidia-driver-595-open（RTX 2060 6 GB）後，要求「一聽到就即時顯示出來，可以不用即時翻譯，但要有即時字幕」。

### 顯示卡設定

- CTranslate2 4.8.3 要 CUDA 12 cuBLAS 和 cuDNN 9。faster-whisper README 原文：「The latest versions of ctranslate2 only support CUDA 12 and cuDNN 9」。CTranslate2 官網安裝頁還寫 cuDNN 8，已經過時。
- 這兩個函式庫用 pip 套件（nvidia-cublas-cu12、nvidia-cudnn-cu12==9.*）裝成 host 的 `gpu` 選配，約 2.2 GB。`run_host.sh` 會把它們加進 LD_LIBRARY_PATH，不動系統的 CUDA。

### 速度（RTX 2060，float16）

量法：`bench_whisper.py --device cuda`，每個模型各用一個獨立程序（同一個程序連續載入 large 模型會 CUDA out of memory）。

| 模型 | 英文 60 秒中位數 | 日文 60 秒中位數 | 比播放快 |
|---|---|---|---|
| small.en／small | 1.49 秒 | 1.52 秒 | 約 40 倍 |
| medium.en／medium | 4.01 秒 | 3.65 秒 | 約 15 倍 |
| large-v3-turbo | 1.82 秒 | 1.86 秒 | 約 32 倍 |
| large-v3 | — | CUDA out of memory | — |

large-v3 爆顯示記憶體時，桌面和 Brave 本身已經佔了約 2.2 GB。

即時字幕單次延遲（`bench_partial.py`，beam 1，各 5 次中位數）：

| 模型／裝置 | 3 秒 | 8 秒 | 15 秒 |
|---|---|---|---|
| large-v3-turbo／顯示卡（英文） | 0.29 秒 | 0.33 秒 | 0.40 秒 |
| large-v3-turbo／顯示卡（日文） | 0.30 秒 | 0.35 秒 | 0.44 秒 |
| small.en／顯示卡 | 0.10 秒 | 0.17 秒 | 0.37 秒 |
| small.en／CPU | 1.28 秒 | 1.52 秒 | 2.05 秒 |

### 記憶體

顯示卡模式下，本機程式的系統記憶體最高 RSS 是 1.85 GB（`/usr/bin/time -v`）。量法：送 8 段即時字幕和 1 段 25 秒定稿。比 CPU 模式（1.29 GB）多，因為 CUDA／cuDNN 函式庫會載入記憶體，模型也要先讀進系統記憶體再搬到顯示卡。

### 正確性

- **large-v3-turbo 最準。** 日文「菜種殻」「唐辛子」「はい出ました」「モズ」全對；CPU small 把「はい出ました」轉成意思相反的「入れました」。
- **medium 日文在段尾重複一句**（「水に浸かることのない」出現兩次）。
- **large-v3-turbo 從句子中間開始聽時，會輸出全小寫、沒有標點。** 英文日文都一樣，不給提示也一樣。解法是在提示最前面放一段有標點的示範句（host `STYLE_PROMPTS`），英文「Each Christmas, she stopped…」、日文「いたずらばかりしました。畑へ入って…」就恢復正常。e2e 也檢查提示句沒有被念進文字稿。

### 即時字幕的做法

- 錄音頁在一句還沒講完時，每 1 秒把這句目前錄到的聲音送去轉（beam 1），結果以淺色顯示在側邊欄最下面。
- 講完停頓後照舊切段定稿（beam 5），定稿那一行會取代即時字幕。
- 背景程式同一時間只讓一段即時字幕在轉，轉的期間進來的新段落只保留最新的一段。所以 CPU 比較慢時，字幕會自動放慢更新，不會塞車。
- e2e 結果（英文、日文各 40 秒）：
  - 即時字幕更新 31–38 次，間隔中位數 1.03 秒
  - 第一次出現在點圖示後 2.8–3.1 秒，這段時間包含載入模型
  - 第一句定稿在 9.8–13.7 秒才出現
- 已知現象：聲音停下時，最後一段的即時字幕偶爾會出現模型猜的字，最多約 6 秒後就會被定稿取代或清掉，不會進到文字稿。

### 翻譯（暫停，後來在第 9 節做成可開關的雙語字幕）

- 使用者改口「可以不用即時翻譯」，所以暫停。
- 已查證的候選：騰訊 Hy-MT2-1.8B（Apache-2.0、官方 GGUF、支援 ja 與 zh-Hant、Q8_0 1.9 GB），可以用 llama.cpp b11840 的 Vulkan 版跑，那一版看得到 RTX 2060。
- 模型和 llama.cpp 已經下載，但還沒量速度和品質：
  - `~/.cache/tab-transcriber/models`，4.2 GB
  - `host/vendor/`，127 MB

## 9. 追加：泰文與可開關的雙語字幕（2026-10-24）

使用者：「泰文也加進去。我覺得即時雙語字幕可以作為一個可開關的功能，反正不會一直開著」。

### 泰文辨識

量法：Google FLEURS 泰文 dev 集（CC-BY-4.0，附人工逐字稿），每句只取第一位朗讀者，共 40 句（CPU 只量前 20 句）。泰文詞和詞之間不空格，所以比字元錯誤率（CER），計算前去掉空白和標點。工具是 `bench_fleurs.py`。

| 模型 | 跑在 | 字元錯誤率 | 轉 1 秒錄音要多久 | 每句中位數 |
|---|---|---|---|---|
| large-v3 | 顯示卡 float16 | 8.3% | 0.170 秒 | 1.73 秒 |
| large-v3 | 顯示卡 int8_float16 | 8.8% | 0.163 秒 | 1.69 秒 |
| large-v3-turbo | 顯示卡 | 12.3% | 0.059 秒 | 0.55 秒 |
| large-v3-turbo＋泰文示範句 | 顯示卡 | 12.9% | 0.057 秒 | 0.57 秒 |
| medium | 顯示卡 | 14.2% | 0.128 秒 | 1.06 秒 |
| small | 顯示卡 | 20.7% | 0.047 秒 | 0.48 秒 |
| medium | CPU | 13.8% | 0.837 秒 | 8.78 秒 |
| small | CPU | 19.1% | 0.352 秒 | 3.47 秒 |

- 決定：顯示卡預設 large-v3-turbo，和英文、日文一致，即時字幕也快。large-v3 比較準，但顯示記憶體 3845 MiB（turbo 2180 MiB），加上翻譯模型會超過 6 GB，所以只寫進 README 當選項。
- CPU 預設 small：medium 在 CPU 上轉 60 秒錄音要約 50 秒，加上即時字幕會跟不上。
- 不加泰文示範句：泰文幾乎不用標點，加了也沒有變準（12.3% → 12.9%）。
- 常見錯誤：
  - ร／ล 混淆（「ดังกล่าว」轉成「ดังกราว」）
  - 外來語被改寫成英文（「จอร์จ ดับเบิลยู. บุช」轉成「George W. Bush」、「อาร์กติก」轉成「Arctic」）
  - 同音字（「ศาล（法院）」轉成「สาร」、「เหล็ก（鐵）」轉成「เล็ก（小）」）
- e2e 用的泰文音檔：FLEURS 的 8 句，用 `make_fleurs_clip.py` 接成 83 秒，句子之間留 1.2 秒。

### 翻譯模型：Hy-MT2-1.8B

量法：`bench_translate.py`，用 llama.cpp b11840 的 Vulkan 版，模型全放顯示卡。句子取自 Whisper 實際轉出的文字（含辨識錯字）：英文 5 句、日文 4 句、泰文 6 句。

| 設定 | 載入 | 每句中位數 | 最慢 | 顯示記憶體 |
|---|---|---|---|---|
| Q8_0，context 4096 | 4.5 秒（第一次讀檔） | 0.61 秒 | 2.97 秒（第一句暖機） | 2142 MiB |
| Q8_0，context 1024 | 1.8 秒 | 0.51 秒 | 0.97 秒 | 1947 MiB |
| Q8_0，context 1024，temperature 0 | 1.6 秒 | 0.58 秒 | 0.95 秒 | — |
| Q4_K_M，context 1024 | 2.6 秒 | 0.48 秒 | 1.96 秒 | 1203 MiB |
| Q8_0，只用 CPU（-ngl 0） | 1.2 秒 | 2.87 秒 | 3.68 秒 | — |

- 泰文 6 句和 FLEURS 的人工中文譯文對照，意思大致正確。錯的地方多半來自辨識錯字，例如「เหล็ก（鐵）」被轉成「เล็ก（小）」，就翻成「小尺寸」。
- 日文的專有名詞和動植物容易錯：「ゴン」翻成「戈恩」，「モズ（伯勞鳥）」翻成「貓頭鷹」或「鴿子」，「トンガラシ（辣椒）」翻成「藤蔓」。
- e2e 看到一次意思相反：泰文「ไม่น่าจะโดนข้อหาทางอาญา（不太可能被刑事起訴）」翻成「可能會被起訴」。
- Q4_K_M 錯得比 Q8_0 多，例如「small key」翻成「小鎖」、「midterm」翻成「中期考試」。所以用 Q8_0。
- temperature 0（每次選機率最高的字）：
  - 兩次跑的結果完全相同，品質和模型卡建議的 0.7 差不多。
  - 即時字幕每秒重翻一次，用 0 譯文比較不會跳動，所以採用 0。
- context 從 4096 降到 1024 只省約 200 MiB，因為顯示記憶體主要是模型本身。一次只翻一兩句，1024 就夠用，所以還是用 1024。

### 和 Whisper 一起用顯示卡

量法：`bench_bilingual.py`。兩個模型都載入後，另一條執行緒不停翻譯，同時量即時字幕要多久。這是最壞情況；實際上只有在有新句子時才翻。

| 即時字幕（beam 1）| 3 秒 | 8 秒 | 15 秒 |
|---|---|---|---|
| 英文，只有 Whisper | 0.29 秒 | 0.33 秒 | 0.40 秒 |
| 英文，同時在翻譯 | 0.48 秒 | 0.61 秒 | 0.75 秒 |
| 泰文，只有 Whisper | 0.32 秒 | 0.41 秒 | 0.51 秒 |
| 泰文，同時在翻譯 | 0.58 秒 | 0.81 秒 | 1.10 秒 |

- 同時在轉文字時，翻譯每句中位數 0.79–0.86 秒。
- 顯示記憶體：翻譯模型 1941 MiB、Whisper 2037 MiB，最高 4387 MiB。顯示卡是 6144 MiB，開始前桌面佔 261 MiB。
- 結論：即時字幕也可以一起翻。最壞情況下，泰文長句的即時字幕更新會從每 1 秒拉長到約 1.1 秒。

### 做法

- **開關**：存在 `chrome.storage.local.bilingual`。背景程式聽 storage 變化，錄音中切換時送 `{type: "translate", enabled}` 給本機程式。
- **啟動順序**：本機程式等 Whisper 載入完才啟動 llama-server。CUDA 載入失敗沒有退路，翻譯模型放不進顯示卡還可以改用 CPU（`-ngl 0`）。
- **關掉開關**：
  - 馬上結束 llama-server，把顯示記憶體還回去。
  - llama-server 收到 SIGTERM 會先把翻到一半的那句翻完，實測要等好幾秒，所以只等 1 秒，之後直接 SIGKILL。
- **不留殘留程序**：llama-server 用 `setpriv --pdeathsig TERM` 啟動，本機程式被強制結束時它也會跟著結束，不會繼續佔顯示記憶體（記取第 7 節的記憶體事故）。
- **不拖慢轉文字**：翻譯在另一條執行緒。定稿優先，即時字幕只留最新一則；轉文字不等翻譯。
- **不翻半句**：
  - 半句話翻出來不通順。英文、日文的定稿會先湊到句尾標點（. ? ! 。？！）才一起翻，最多湊三段或等 6 秒。
  - 譯文掛在這組的最後一段下面。
  - 泰文沒有句號可依，每段各自翻。
- **收尾**：停止錄音時，背景程式在最後一段後面送 `flush`。本機程式把手上的句子都翻完後回 `flushed`，背景程式收到才結束。
- **CPU 模式**：只有 CPU 時不翻即時字幕。
- **安裝**：
  - install.sh 下載 llama.cpp Vulkan 版（35 MB）和 Hy-MT2-1.8B-Q8_0（1.9 GB），兩者都核對 SHA-256。
  - 加 `--no-translate` 可以跳過。
  - 沒裝就打開開關時，側邊欄提示執行 install.sh，並把開關關回去。

### 端到端測試結果

| 情境 | 結果 |
|---|---|
| 泰文 84 秒，雙語從頭開 | 9 句都有譯文；即時字幕更新 57 次，其中 54 次有譯文；更新間隔中位數 1.03 秒 |
| 英文 60 秒，三分之一處打開、三分之二處關掉 | 打開後 3 秒內翻譯就緒；關掉後 0.3 秒內 llama-server 結束 |
| 日文 40 秒，雙語從頭開 | 6 句湊成 3 組翻譯（逗號結尾的句子併進下一句）；即時字幕的譯文更新 29 次 |
| 英文 25 秒，雙語關著（回歸測試） | 沒有翻譯，也沒有啟動 llama-server |
| 英文 30 秒，只用 CPU 轉文字、雙語開著 | 4 句定稿都有譯文；即時字幕沒有翻 |
| 翻譯模型路徑不存在 | 側邊欄提示「翻譯模型還沒安裝…」，開關關回去，轉文字照常 |

每次結束後，瀏覽器、本機程式、llama-server 的殘留程序都是 0。

### 翻譯的限制

- 1.8B 的小模型會翻錯，偶爾意思相反，README 已經請使用者把譯文當參考。
- 泰文一句話被切成兩段時，兩段會分開翻，譯文不通順。例如 e2e 的第一句前半「…แต่เล็กทำให้ล้อมไม้ของเกลียนเกิด」翻成「但萊克則用來固定格利安的木製結構」。
- 只翻打開開關之後的句子，不補翻之前的。
- 在沒有顯示卡的電腦上，Vulkan 版會直接用 CPU 跑，但側邊欄的狀態仍標成 gpu。這種電腦沒有實測過。

## 10. 追加：配樂片段讓字幕卡住（2026-10-24）

使用者第一次在真實 Brave 視窗錄日文，開著雙語字幕，錄了約 4.5 分鐘（host.log 19:16–19:21）。

### 現象

- 有講話的 16 段定稿裡，12 段要 3.5–12 秒，都在 19:18 之後。之前的幾段大多在 1 秒內轉完（最慢 2.9 秒）。
- 例如一段 24.9 秒的錄音，VAD 判定只有 0.86 秒是講話，卻轉了 11.4 秒。
- 本機程式一次只轉一段，所以即時字幕也跟著停住，等這段轉完才一口氣補上。
- 切段用音量門檻，配樂不停就找不到停頓，有幾段拉長到 22–25 秒。

### 原因

Whisper 碰到配樂或歌聲時，常會一直重複同一句，直到產生上限（448 減掉提示長度）。輸出的壓縮比超過 2.4 會被判為失敗，於是再依序用 0.2、0.4、0.6、0.8、1.0 五個溫度重試，每次都跑到上限。

重現方法：禁止 end-of-text，讓模型停不下來。結果定稿要 9.5 秒、即時字幕要 4.9 秒，和實際的 10–11 秒對得上。輸出正是常見的幻覺句「ご視聴ありがとうございました」「チャンネル登録よろしくお願いします」。

還有一個放大因素：定稿文字會拿來當下一段的提示。幻覺句一旦進了提示，下一段更容易照抄。這次卡住的段落從 19:18 起連續出現，符合這個現象。

### 做法（host/transcriber_host.py）

- 先自己跑一次 VAD，量出講話秒數。沒有講話就不轉。這一步每段多花約 0.02 秒。
- 依講話秒數限制最多產生幾個 token：20 + 25 × 講話秒數。
  - 實測每秒講話最多產生：泰文 11.3、日文 4.8、英文 3.9 個 token。
  - 算出來超過 200 就照原本的上限，所以講話長的段落不受影響。
- 即時字幕只試 0、0.4、0.8 三個溫度，定稿照預設的六個。
  - 完全不重試（只用 0）也試過，但泰文的即時字幕會卡在重複（「ที่ประเทียม ที่ประเทียม…」），日文有一段變成空白，所以沒有採用。
- 定稿要重試到溫度 0.5 以上才轉得出來的話，這段文字不拿來當下一段的提示。這和 faster-whisper 在一段之內用的規則相同。
- 另外兩項只改紀錄：
  - host.log 每段多記講話秒數與最高重試溫度，下次可以直接看出是不是卡在重試。
  - 開關雙語字幕會記 `translator on/off`。關掉開關時中斷的那句翻譯不再記成錯誤；19:23 那次的「translate failed」就是這種情況，畫面上沒有影響。

### 結果（RTX 2060，large-v3-turbo，bench_stuck.py）

| 情境 | 改前 | 改後 |
|---|---|---|
| 卡在重複時的定稿（25 秒，講話 1 秒） | 9.5 秒 | 1.8 秒 |
| 卡在重複時的即時字幕 | 4.9 秒 | 1.0 秒 |
| 正常錄音每次轉文字的中位數／95 百分位 | 0.41／0.71 秒 | 0.44／0.75 秒 |
| 正常錄音 76 次（英日泰各 3 分鐘，定稿與即時字幕）文字不同的次數 | — | 2 次 |

上面的「卡在重複」只有約 1.9 秒講話（上限 66 個 token）。上限越高，卡住時越久（同一段錄音，只改上限）：

| 講話秒數 | 上限 | 卡住時的定稿 |
|---|---|---|
| 約 1.9 秒 | 66 | 2.1 秒 |
| 約 3.8 秒 | 115 | 3.8 秒 |
| 約 5.6 秒 | 160 | 4.6 秒 |
| 約 7.2 秒 | 199 | 5.4 秒 |
| 7.2 秒以上 | 不設（同改前） | 9.3 秒 |

對照 19:16 那次卡住的 12 段：9 段講話不到 7.2 秒，會被限制，其中原本卡 10–12 秒的 5 段（講話 0.9–5.5 秒）會降到約 2–4.6 秒；另外 3 段講話 7.7–20.5 秒，不受影響，當時各卡了約 5 秒。

文字不同的 2 次都是同一段泰文，這段本來就要靠隨機的溫度重試才轉得出來：用改前的設定連跑兩次，結果也不一樣。

即時字幕的溫度組合比較：

| 組合 | 卡住時 | 和改前不同 |
|---|---|---|
| 0、0.4、0.8（採用） | 1.0–1.3 秒 | 上述泰文 |
| 0、0.2…1.0（預設六個，只加上限） | 1.7–1.8 秒 | 上述泰文 |
| 0、0.6 | 0.8–1.1 秒 | 上述泰文，加上日文一段少了開頭兩個字 |

端到端測試全部通過，殘留程序都是 0：日文 40 秒雙語開、泰文 84 秒雙語開、英文 60 秒中途開關。

### 限制

- 只有講話少的段落卡得比較短。講話 7 秒以上的段落卡在重複時，定稿仍可能要 5–9 秒。要再壓，下一步是減少定稿的重試溫度（像即時字幕一樣）；但手上只有清楚的朗讀，量不出難辨識的錄音會不會因此變差，所以先不改。第 11 節處理了其中最常見的一種：聲音本來就在重複的狀聲詞。
- 幻覺句本身還是可能出現，只是比較短，也比較不會一路傳到下一段。
- 沒有使用者當時的錄音，只能用合成的配樂重現。真實影片的效果要等使用者再試一次。

## 11. 追加：連續狀聲詞讓字幕塞爆（2026-10-25）

使用者：「好像聽到連續的狀聲詞字幕就會塞爆炸」。

### 現象

- host.log 01:49–01:55 那次日文錄音（雙語字幕開著）：有 8 段定稿每段要 2.4–16 秒，溫度都重試到 1.0。這幾段 VAD 判定的講話秒數是 4.6–20.1 秒。
- 本機程式一次只轉一段，所以即時字幕也跟著停住。
- 插件存在瀏覽器裡的文字稿顯示，這幾段是連續的附和或狀聲詞，一段約 300 字。例如：
  - 「うん。」重複約 70 次
  - 「ああ。」重複幾十次
  - 「う」連續 223 個字
  - 「アーオーオーオー…」
- 網頁字幕框和側邊欄都被這種長串撐滿。

### 原因

- 不是幻覺。聲音本來就一直在重複，Whisper 照實寫了出來。
- 出問題的是 faster-whisper 的規則：輸出的壓縮比超過 2.4 就當成「卡在重複」，換下一個溫度重試。定稿試六個溫度，即時字幕試三個。
- 真的在重複的聲音，每個溫度轉出來都一樣在重複，每次都產生到上限。
- 第 10 節依講話秒數限制產生長度，但這些段落整段都是人聲，上限很高或根本不設，所以沒擋到。第 10 節「限制」預告的就是這種情況。
- 定稿試完六個溫度，挑出的還是那串重複，所以畫面上出現 300 字的「うん。うん。…」。

### 做法（host/transcriber_host.py）

先只用溫度 0 轉一次，再依結果分三種情況：

- **沒失敗**（壓縮比 ≤ 2.4、平均對數機率 ≥ −1）：照用，和以前完全一樣。
- **失敗了，但是狀聲詞**：
  - 判斷方式：只看字母（不管標點、空白），一半以上是很短的單位（不超過 4 個字）連續重複 8 次以上。
  - 直接用這次的結果，不重試。
  - 這段也不拿來當下一段的提示，免得下一段跟著寫「うん。」。
  - host.log 在這段的紀錄後面標 `vocal`。
- **其他失敗，或什麼都沒轉出來**：照原本的溫度從頭重轉。
  - 什麼都沒轉出來時，看不到這次解碼算不算失敗，所以也要重轉。
  - 配樂的幻覺句（「ご視聴ありがとうございました」，單位 14 個字）和泰文卡在重複（「ที่ประเทียม」），都還是走重試。
  - 代價是這些情況多轉一次溫度 0。

輸出的文字另外處理：

- 同一個單位連續出現 4 次以上，只留 3 次，後面接「…」。單位最長 20 個字，不分大小寫。
  - 例如「うん。」70 次變成「うん。 うん。 うん。…」，「う」223 個變成「ううう…」。
  - 只有數字或標點的不縮，例如 1000000、!!!!!。
- 同一段裡一模一樣的句子接連出現時，併成一行。
- 定稿、即時字幕、翻譯、文字稿都用縮短後的文字。
- 「…」結尾也算句尾，雙語字幕不用再等 6 秒才翻。

網頁字幕框（extension/caption-overlay.js）：

- 加上高度上限：一句太長時只留最新的約五行，上緣淡出。這是保險，正常情況下上面的縮短已經夠了。
- 使用者另外要求可以調大小：拖右下角改寬高，字的大小不變。
  - 大小以 em 存，全螢幕時框跟著字等比例放大。
  - 按兩下右下角恢復依文字自動調整。
  - 0.5.1 在 YouTube 全螢幕時縮小字幕框只動一步就停（0.5.2 修正）。滑鼠移動超過幾個像素時，Chromium 會重新看「按下去的那一點」底下是什麼。縮小或從邊緣拖時，那一點已經離開字幕框，落在 YouTube 設了 `draggable` 的影片區（`.html5-video-container`）上，瀏覽器就改成拖影片區、送 `pointercancel`。放大時那一點還在框上，所以沒事。改成拖動和改大小的 `pointerdown` 都呼叫 `preventDefault()`；按兩下恢復和指標捕捉（pointer capture）照常運作。Brave 155 實測：真的 YouTube、和 e2e 一樣設了 draggable 的測試播放器上，舊版縮小、從下緣往上拖都失敗，新版都通過。

不採用的做法：

- `no_repeat_ngram_size`、`repetition_penalty`：會擋掉真的「ドキドキ」「うん うん」。
- 全部不重試：第 10 節試過，泰文會卡在重複。
- 一律把產生上限壓到 200：泰文每秒 11.3 個 token，25 秒的段落會被截斷。

### 結果（RTX 2060，large-v3-turbo，bench_repeat.py）

測試片段是合成的狀聲詞：從朗讀切出一個音節，一直重複到 14 秒，VAD 判定整段都是講話。

| 片段 | 定稿：改前 | 定稿：改後 | 即時字幕：改前 | 即時字幕：改後 |
|---|---|---|---|---|
| 日文「ボラボラ…」 | 1.85 秒 | 1.10 秒，13 字 | 1.63 秒 | 0.79 秒，7 字 |
| 日文「ゴンゴン…」 | 0.41 秒，15 字 | 0.43 秒，11 字 | 1.99 秒，223 字 | 0.81 秒，7 字 |
| 英文「chat, chat…」 | 3.12 秒，670 字 | 0.44 秒，18 字 | 2.05 秒，670 字 | 0.79 秒，18 字 |

- 改前的輸出每次跑都不一樣，因為是靠隨機的溫度重試。例如「ボラボラ…」這次重試出幻覺句「ご視聴ありがとうございました。」，前一次則是 223 字的「ボナッシュボナッシュ…」。
- 「ゴンゴン…」的定稿用溫度 0 就過了（「ゴン、ゴン、ゴン、ゴン、ゴン。」），改後只是縮短，時間不變。

卡在重複一整句的情況（照舊重試，用禁止 end-of-text 模擬，同第 10 節）：

| 情境 | 改前 | 改後 |
|---|---|---|
| 配樂（講話 1.9 秒）的定稿 | 2.31 秒 | 2.75 秒 |
| 配樂的即時字幕 | 1.08 秒 | 1.85 秒 |
| 朗讀（講話 13.1 秒）的定稿 | 4.89 秒 | 5.88 秒 |
| 朗讀的即時字幕 | 2.39 秒 | 3.10 秒 |

正常錄音（英日泰各 3 分鐘，定稿與即時字幕共 76 次）：

- 每次轉文字的中位數 0.436 → 0.451 秒，95 百分位 0.705 → 0.720 秒。
- 文字不同 1 次：一段泰文定稿，改前改後都重試到溫度 0.4。
- 對照組：改前的程式同一段連跑兩次，也有 2 次不同，都是泰文、都重試到 0.4–0.8。
- 第一版漏了「什麼都沒轉出來也重轉」，有一段日文即時字幕變成空白，補上後才是上面的結果。

其他驗證：

- `tests/test_repeats.py`：縮短與狀聲詞判斷的單元測試。
  - 會縮短：「うん。」、「う」、「アーオーオー」、「ha ha」、泰文笑聲「ฮ่า」。
  - 不會被誤縮：「ドキドキ」、「1000000」、「Wait!!!!!」、正常句子。
  - 照舊重試：配樂幻覺句、泰文卡在重複。
- 端到端測試：英文 60 秒中途開關雙語、日文 40 秒雙語開，全部通過，包括新加的改寬高與恢復自動大小。

### 限制

- 沒有使用者的錄音，只能用合成片段。
  - 合成片段改前只卡 2–3 秒，因為重試到高溫時會跳出重複。
  - 使用者那幾段每個溫度都產生到上限，卡 8–16 秒。
  - 改後只解碼一次，照 16 秒那段六次平均推算，約 2.7 秒以內，但沒有實測。
- 判斷只靠文字。一句話卡在重複一個很短的詞（例如「the the the…」）也會被當成狀聲詞而不重試，那段後面的內容可能漏掉。
- 縮短後看不出實際重複了幾次：「うん」講了 70 次也只留 3 次。
- 標點時有時無的不規則重複，只縮得掉一部分；字幕框的高度上限兜底。
- 不是狀聲詞的失敗（配樂幻覺句、泰文卡住）多轉一次，約慢 0.4–1 秒。

## 12. 追加：換頁要不要再點圖示（2026-10-25）

### 問題

使用者問：「換網頁一定要再點一次嗎？」README 原本寫「換過網頁後要再點一次圖示」，但這句沒有實測過。

### 量測

`nav_probe.mjs` 用一個最小插件錄分頁聲音。每個測試頁播不同音量的正弦波，從量到的音量判斷聲音來自哪一頁。每一步記錄三件事：

- 錄音軌的狀態；
- 能不能注入程式到分頁，也就是能不能放字幕框；
- 能不能對分頁拿錄音（getMediaStreamId）。

127.0.0.1 和 localhost 算不同網站。Brave 155 headless 實測。

錄音中，同一個分頁換頁：

| 換頁方式 | 錄音 | 聲音 | 注入（只有點圖示的權限） | 注入（加所有網站權限） |
|---|---|---|---|---|
| 同一頁內換網址（pushState，像 YouTube 換影片） | 繼續 | 跟著新頁面 | 可以 | 可以 |
| 同網站換頁（整頁重新載入） | 繼續 | 跟著新頁面 | 可以 | 可以 |
| 換到別的網站 | 繼續 | 跟著新頁面 | 不行 | 可以 |
| 再換回原本的網站、按上一頁 | 繼續 | 跟著新頁面 | 不行（不會恢復） | 可以 |
| 瀏覽器內部頁面（chrome://） | 繼續（沒有聲音） | — | 不行 | 不行 |

開始錄音（取得錄音）：

| 情況 | 只有點圖示的權限 | 加所有網站權限 |
|---|---|---|
| 沒點過圖示的分頁 | 不行 | 不行 |
| 錄音中在另一個分頁點圖示之後 | 可以 | 可以 |
| 點過圖示的分頁同網站換頁之後（側邊欄的「開始」） | 可以 | 可以 |
| 點過圖示的分頁換到別的網站之後 | 不行 | 不行 |

### 結論

- 錄音中換頁不用再點。錄音軌只在分頁關掉時才結束，所以「分頁已關閉或換頁，錄音已停止」這句提示改成「分頁已關閉，錄音已停止」。
- 整頁重新載入後，原本注入的字幕框就不見了。以前不會補回來；錄音中再點圖示也只打開側邊欄，所以使用者看起來像要重點。
- 開始錄音一定要在那個分頁啟動過插件，例如點圖示。所有網站的權限也不能代替。
- 使用者選擇讓插件要所有網站的權限（`host_permissions: <all_urls>`）。被錄的分頁每次載入完（`tabs.onUpdated` 的 `status: complete`），背景程式就重新注入字幕框；字幕框本身會擋重複注入。
- 沒有採用的另外三項：
  - 字幕框只在同網站自動補回、換網站時點圖示補回：所有網站的權限已經涵蓋。
  - 錄音中點別的分頁圖示就改錄那個分頁：會改變「錄 A 時在別的分頁點圖示只打開側邊欄」的行為。
  - 快捷鍵：使用者沒有選。
- 驗證：e2e（英文 60 秒、雙語切換）加了兩項換頁檢查，錄音中先同網站換頁、再換到別的網站（127.0.0.1 → localhost），兩次都確認錄音沒有中斷、字幕框出現在新頁面；之後點圖示仍是同一次錄音。0.6.0 全部 45 項通過。把重新注入的監聽拿掉再跑，只有這兩項換頁檢查失敗。

## 13. 追加：YouTube 原文字幕、背景聲很大時字幕慢（2026-10-28）

使用者：「yt有辦法抓原文cc字幕然後輸出雙字幕嗎」，以及「cs2 英語台的直播讀的好像有點慢也有點不准」（Twitch 的 PGL 台）。

### YouTube 原文字幕

量法：`yt_captions_probe.mjs`，Brave 155 headless，兩部有人工字幕的影片（dQw4w9WgXcQ、jNQXAC9IVRw）。

| 做法 | 結果 |
|---|---|
| 播放器回應裡的字幕清單 | 拿得到：人工字幕和自動字幕分開列；可以翻成 156 種語言，包括 zh-Hant |
| 直接抓清單裡的字幕網址（content script） | 200，內容是空的。網址都帶 `exp=xpe` |
| 打開 CC，看播放器自己發的請求 | 網址多了 `pot`（124 字元）和 `c=WEB`；headless 裡內容也是空的，畫面上沒有字幕 |
| 拿播放器的網址重抓原文、加 `tlang=zh-Hant` | 都是空的 |
| 逐字稿面板 | 元素在 |

- headless 裡播放器自己也拿不到字幕，應該是 YouTube 擋了 headless。改 user agent 繞過偵測的做法沒有做，所以「在真的 Brave 裡跟著播放器拿整份字幕」還沒驗證。
- 官方 Data API 不能用：captions.download「requires the user to have permission to edit the video」。
- YouTube 服務條款禁止未經授權「存取、重製、下載」內容。插件只讀使用者自己畫面上播放器已經顯示的字幕，是個人使用；整份下載比較接近條款禁止的範圍。
- 社群回報（未經官方確認）：字幕網址沒有 YouTube BotGuard 產生的 PO token（`pot`）時回空白；見 youtube-transcript-api issue #592。
- 可行的兩種做法，都還沒做：
  - 讀畫面上正在顯示的 CC（`.ytp-caption-segment`），用現有的翻譯模型翻成雙語。最簡單；CC 要打開，自動字幕會一個字一個字冒出來。
  - 在頁面裡攔播放器自己抓到的整份字幕，翻譯用 YouTube 的 `tlang`。拿得到整份和時間；比較容易被 YouTube 改版弄壞，也還沒驗證。

### 背景聲很大時字幕慢

- 錄音頁在連續 0.4 秒「安靜」時切段，安靜的門檻是講話音量移動平均的 12%。比賽轉播一直有遊戲聲和觀眾聲，永遠等不到這種安靜，每段都拖到最長 25 秒才切，所以定稿要 25 秒以上才出來。
- host.log 裡 10-26 一次英文錄音（背景一直有聲音）：28 段中 18 段在 22–25 秒，乾淨講話的錄音中位數約 7 秒。
- 量法：`bench_noise_cut.py`，只用 CPU，照 offscreen.js 的規則模擬。講話用 alice 120 秒，背景是粉紅雜訊或「觀眾」（四段日文朗讀疊起來加起伏的雜訊）。

| 背景 | 現在：段落中位數 | 改後：段落中位數 | 改後：切在停頓 | 送出的講話（現在 → 改後） |
|---|---|---|---|---|
| 沒有 | 7.9 秒 | 7.9 秒 | 13/13 | 96% → 96% |
| 粉紅雜訊，比講話小 10 dB | 23.6 秒 | 8.8 秒 | 13/13 | 98% → 96% |
| 粉紅雜訊，比講話大 3 dB | 23.5 秒 | 6.3 秒 | 14/17 | 98% → 96% |
| 觀眾，比講話小 10 dB | 22.8 秒 | 7.2 秒 | 12/13 | 93% → 97% |
| 觀眾，比講話大 3 dB | 23.9 秒 | 7.8 秒 | 10/14 | 81% → 98% |

- 改法：另外估背景音量，取最近 10 秒每 0.1 秒音量中最安靜的一成；比它大 1.5 倍才算有人聲。1.3 倍切出來的段落比較長，所以用 1.5。
- 準不準和 VAD 無關：同樣的混音，Silero VAD 量到的講話都是 100%，沒有把講話當成雜訊丟掉。
- 驗證：
  - `tests/test_chunking.mjs` 把合成的句子（加不同大小的背景雜訊）餵給真的 offscreen.js，0.6.1 全部通過。改回舊規則時，兩種有背景聲的情況都失敗（段落中位數 24.1、23.5 秒）。
  - e2e（英文 60 秒、雙語切換）45 項全部通過，乾淨講話的切段不受影響。

### 真的轉播：Twitch PGL（2026-10-28）

- 量法：`live_probe.mjs`（scratchpad，沒有進 repo）用 headless Brave 載入一份「不播回喇叭、另存 16 kHz 聲音」的插件複本，錄 twitch.tv/pgl 4 分鐘（Spirit 對 MOUZ）。
- 切段：同一段聲音用新舊規則切，舊規則中位數 8.5 秒、最長 24.6 秒（1 段到 24 秒以上）；新規則中位數 7.9 秒、最長 16.1 秒。這段轉播的背景聲不大，舊規則大多也切得到。
- 句子大致都對，錯的是名字：donk 轉成 Dunk、Dong，MOUZ 轉成 Mao's、Maus、Miles，torzsi 轉成 Torji，xelex 轉成 Zelex，Five-SeveN 轉成 5'7"。
- 專有名詞：把兩隊選手（名單查自 dust2.us、escorenews 的 2026 年報導）、隊名、武器名放在 Whisper 提示最前面，照 host 的流程依序轉同一段聲音。以 large-v3 加名單轉對的 24 處當基準：

| 設定 | 名字轉對 | 每段中位數 |
|---|---|---|
| large-v3-turbo | 3 | 0.41 秒 |
| large-v3-turbo＋名單 | 15 | 0.40 秒 |
| large-v3 | 4 | 0.85 秒 |
| large-v3＋名單 | 24 | 0.87 秒 |

- 決定：側邊欄加「專有名詞」欄位，依語言分開記住，錄音中改了就送給本機程式。名單放在提示最前面；提示超過 223 個 token 會從前面砍，所以有名單時改成縮短後面接的上一段結尾，名單最多 120 個 token。

## 14. 追加：YouTube 字幕模式（2026-10-28）

使用者：「現在cc字幕可以了嗎」「可以試試看」。

- 做法（第 13 節的結論）：插件自己抓字幕檔只會拿到空的，所以 `yt-caption-hook.js` 以內容腳本在頁面本身的 world、document_start 執行，包住 `fetch` 和 `XMLHttpRequest`，播放器抓 `/api/timedtext` 回來時順便解析那一份（json3）。不另外發請求、不存檔；機器翻譯（`tlang`）和空的回應都略過，自動字幕的 `aAppend` 換行事件也略過。
- `yt-caption-bridge.js`（isolated world）收到字幕後，錄音中照 `video.currentTime` 把播到的句子交給背景程式：連續播放時送上次檢查到現在之間開始的每一句；往回或跳超過 3 秒當成拖進度條，只送當下那一句；廣告（`#movie_player.ad-showing`）時不送。背景程式再依「影片＋開始時間」擋重複，所以重新整理網頁也不會重記。
- 背景程式在「YouTube 字幕」開關開著時，先問分頁裡有沒有 bridge 回答（只有 YouTube 頁面有），有就走字幕模式：不開錄音頁、不拿分頁聲音；本機程式以 `whisper: false` 啟動，只在雙語字幕開著時翻譯（`{type: 'text'}`）。字幕語言不在英、日、泰時一行一行翻。10 秒沒收到字幕就提示打開 CC。
- 驗證：`tests/e2e_youtube_cc.mjs` 用假的觀看頁（播放時一次 XHR 沒帶 pot 回空的、一次 fetch 帶 pot、一次 tlang），插件複本把 127.0.0.1 加進內容腳本範圍。13 項全部通過：不開錄音頁、句子時間是影片時間、換行事件不進文字稿、網頁字幕跟著、往回拖和重新整理都不重複、停止後收乾淨。拿掉 hook 時改成提示打開 CC（`--no-hook`）。
- 沒有驗證：真的 YouTube。headless 裡 YouTube 會擋字幕和播放，不做繞過偵測的事；要使用者在自己的 Brave 試。

### 整部字幕、先翻、自動打開 CC（2026-10-28）

使用者問「所以你有辦法是先載入cc字幕嗎」，列了三種做法後回「1 2 3 都做」。

- 整部進文字稿：bridge 一拿到字幕就整份交給背景程式，文字稿一開始就是整部影片（每行帶 `videoId`）。之後 bridge 只報「現在播到哪一句」（最後一句已經開始的），網頁字幕顯示這一句和前一句，側邊欄標出這一句（`state.now`），使用者沒捲走時跟著捲。同一部影片換了字幕語言就換掉它那幾行。
  - 第 13 節記過：整份下載比較接近 YouTube 條款禁止的範圍。使用者知道後決定要做；README 寫明只限個人學習。
- 先翻：背景程式照本機程式湊句子的規則（英文、日文等到句尾，最多三句；其他語言一句一組）先分好組，只把影片接下來 60 秒還沒翻的組交給本機程式。連續播放時補新進到範圍的；拖進度條、剛開始、換字幕時送 `replace: true`，本機程式丟掉排隊沒翻的（翻到一半的照樣送回）。`tag` 是「影片＃第幾份字幕」，晚到的舊譯文認得出來。停止時不等排隊的翻完。
  - 沒做：把整部影片都翻完。GPU 一組約零點幾秒，但只用 CPU 時一組約 3 秒，整部翻完要很久，所以只翻播放位置附近。
- 自動打開 CC：播放器只有 CC 開著才抓字幕檔。錄音中還沒拿到字幕的影片，換到它 2 秒後（等播放器套上 YouTube 記住的 CC 狀態），CC 按鈕看得到、`aria-pressed="false"` 就按一次，每部影片只按一次。停止時只關回插件自己打開的；使用者本來就開著的不動。
- 驗證：
  - `tests/e2e_youtube_cc.mjs`：假的觀看頁改成 CC 按鈕打開才抓字幕，並且像 YouTube 一樣記住開著。18 項全部通過（多一項：字幕模式按「清除」只清以前的錄音，這部影片的字幕留著）：自動打開 CC、整部 30 句一拿到就進文字稿、網頁字幕和側邊欄跟著影片時間、往回拖和重新整理不重複、重新整理後沒有再按一次（會把 CC 關掉）、停止馬上回待命、插件打開的 CC 關回去、使用者自己開的不動。
  - 反向測試：清除時把這部影片的字幕也清掉，1 項失敗；拿掉停止時關 CC，1 項失敗（另一項是跟著它連帶失敗，已經改成不依賴前一步）；拿掉自動按 CC，8 項失敗；拿掉 hook 時提示打開 CC。
  - `tests/test_caption_queue.py`：本機程式的排隊（每段一組、replace 留下 flush、tag 帶回），不啟動翻譯模型。
- 同一份字幕再抓一次但多了或改了幾句（例如直播，還不知道會不會這樣）：沒變的組留著譯文。只看過程式，沒有測試。
- 換句的時機（2026-10-28，使用者：「看起來還是比原生的cc字幕慢」）：原本只靠 `timeupdate`（Chromium 大約每 250 毫秒一次）和 500 毫秒的保險檢查，模擬頁量到網頁字幕比影片跨過一句開頭晚 88、104、212、228、246 毫秒，和原生 CC 並排看得出來。改成每次檢查時算好下一句的開始時間、到那一刻（加 5 毫秒）再檢查一次，另外聽 `seeked`、`play`、`ratechange`：同一個量測降到 6–13 毫秒（三次執行，每次 4–5 句）。量測在 `tests/e2e_youtube_cc.mjs`：頁面裡每 4 毫秒看一次影片時間，用跨過開頭時的時間差推回準確時刻，MutationObserver 記網頁字幕換句的時刻；標準是中位數不超過 60 毫秒、最慢不超過 150 毫秒。
- 插件重新載入以前開的 YouTube 分頁（2026-10-28）：分頁裡舊的 bridge 已經跟插件斷線，問不到就會照一般網頁改用 Whisper，使用者看到的是「比原生 CC 慢好幾秒」，也不知道為什麼。host.log 裡使用者那天 10:20 兩次是字幕模式（`model=none`），10:23 起是 Whisper（`model=large-v3-turbo`），很可能就是這樣。改成：「YouTube 字幕」開著、網址是 manifest 裡 bridge 會注入的頁面，卻問不到 bridge，就直接提示重新整理網頁，不改用 Whisper。`e2e_youtube_cc.mjs` 最後用 `Extensions.loadUnpacked` 同一個資料夾重新載入插件、分頁不重新整理再點圖示來檢查；拿掉這段判斷時這一項會失敗（變成去錄音）。這一項把語言設成不支援的 `xx`，萬一又改用 Whisper，本機程式會在載入 Whisper 以前就回錯誤，不佔顯示卡。
- 還沒驗證：真的 YouTube（CC 按鈕的寫法、YouTube 記住 CC 的時機：如果 YouTube 在插件按下去之後才套上「上次開著」，插件會以為 CC 是它開的，停止時把它關掉）；雙語的先翻（`--bilingual` 和 `test_native_host.py` 要用顯示卡，等使用者同意再跑）。

## 15. 查證：AMD 顯示卡跑 Whisper（2026-10-28，還沒做）

使用者：「那我朋友a卡也想跑你有辦法加嗎？」朋友用 Windows，顯示卡型號還在問。專案沒有自己寫的 CUDA 程式：Whisper 的顯示卡運算都在 CTranslate2 裡，翻譯是 llama.cpp 的 Vulkan 版（A 卡本來就能翻譯）。

**路一：CTranslate2 的 ROCm 版（型號對就走這條）**

- CTranslate2 4.7.0（2026-02-03）加入 AMD ROCm HIP（PR #1989：「Passes all tests and successfully outputs for whisper」）。ROCm 版的 wheel 不在 PyPI，放在 GitHub Release 的 `rocm-python-wheels-Windows.zip`（v4.8.4：151 MB，cp39–cp315，每個約 18 MB）。
- 在 Linux 上解開 cp312 wheel、只用 `objdump -p` 看（沒有執行）：`ctranslate2.dll`（94 MB）只連到 `amdhip64_7.dll` 和 `hipblas.dll`，沒有 MIOpen；`__init__.py` 會自己把 site-packages 裡 `_rocm_sdk_core/bin`、`_rocm_sdk_libraries*/bin` 加進 DLL 路徑。官方文件 `docs/building_rocm_windows.md`：用 AMD 的 Python wheel，不要用 HIP SDK 安裝檔（7.1.1 的 DLL 名字不同，`import ctranslate2` 會找不到模組）；`get_supported_compute_types("cuda")` 的 cuda 就是 HIP 裝置，所以 `device="cuda"` 的程式不用改。
- 執行時要的 AMD wheel（repo.radeon.com/rocm/windows/rocm-rel-7.2/）：`rocm_sdk_core`（637 MB，有 `amdhip64_7.dll`、`amd_comgr0702.dll`）＋`rocm_sdk_libraries_custom`（492 MB，有 `hipblas.dll`、`rocblas.dll`）；`rocm_sdk_devel`（1.4 GB）是編譯用的，執行不需要。
- **能跑的顯示卡**：CTranslate2 編了 gfx1030、1100–1102、1150、1151、1200、1201，但 AMD 的 `rocm_sdk_libraries_custom` 裡 rocBLAS 只有 gfx1100、1101、1102、1150、1151、1200、1201（用 HTTP Range 只讀 zip 目錄算出來的）。所以 Windows 上是 RX 7000（RDNA3）、RX 9000（RDNA4）、Radeon 880M／890M（Ryzen AI 300）、8060S 一類（Ryzen AI Max）；RX 6800／6900（gfx1030）沒有 rocBLAS 核心，RX 6600／6700（gfx1031／1032）、Radeon 780M（gfx1103）和更舊的都不在。
- 沒有 AMD 顯示卡的電腦裝了這個 wheel，少了 `amdhip64_7.dll` 會連 `import ctranslate2` 都失敗，CPU 也不能用，所以只能在偵測到 A 卡時才換，而且要連 AMD 的兩個 wheel 一起裝。
- 這台（RTX 2060）和 GitHub 的測試機都沒有 A 卡：只驗證得到「裝得起來、沒有 A 卡時退回 CPU」，用 A 卡轉文字要朋友實測。

**路二：whisper.cpp 的 Vulkan 版（RX 6000 和更舊的卡）**

- 和翻譯用的 llama.cpp 同一套 ggml，Vulkan 驅動夠新的 A 卡、Intel 顯示卡都能用。whisper.cpp v1.9.5（2026-10-06）的 GitHub Release 沒有附任何編好的檔案（`gh release view` 看到 0 個），要自己在 CI 編；模型要換成 ggml 格式，轉文字那一段等於重寫，切段、即時字幕、重複縮短都要重新驗證。


## 16. Windows 安裝檔：一般使用者卡在 uv sync（issue #1，2026-10-30）

使用者：「你看一下issue ，一般用戶直接跑你的.exe有問題。我希望你修掉這個bug。……記得跑一下用一般用戶權限是不是能正常下載」。

- 症狀（issue #1，Windows 10 22H2、0.6.4）：Setup 停在「建立 Python 環境…」，`install.log`：uv 查 `%APPDATA%\uv\python\cpython-3.12-windows-x86_64-none\python.exe` 時 `os error 448`（路徑含未受信任的掛接點）。
- 原因：Inno Setup 6.7.0 起 Setup 預設開著 RedirectionGuard，不走一般使用者帳號建的 junction，子程式都會繼承。uv 安裝 managed Python 會建 `cpython-3.12-…` → `cpython-3.12.x-…` 的 junction。GitHub Actions 的 Windows 測試機是提升權限的系統管理員，建的 junction 算可信，所以一直綠燈。
- 重現：`tests/windows_as_user.ps1` 建一般權限帳號 `ttuser`（`net user`、`secedit` 給「以批次工作登入」），用排程工作（`-RunLevel Limited`）以它的身分跑 Setup.exe、`test_native_host.py`、解除安裝；不用 `Start-Process -Credential`，因為它會帶著系統管理員的環境變數。測試機有系統的 Python，所以設 `UV_PYTHON_PREFERENCE=only-managed`，和使用者電腦一樣讓 uv 下載自己的 Python。CI 紀錄印出 `ttuser  C:\Users\ttuser\AppData\Local  Mandatory Label\Medium Mandatory Level`。舊安裝檔（run 41010140528）：`Failed to create Python minor version link directory … (os error 448)`，Setup.exe 回 10（新加的 `GetCustomSetupExitCode`；以前 install.ps1 失敗時結束碼照樣是 0）。
- issue 建議的 `ExecAsOriginalUser`（run 41012166655）照樣 448：Inno 說明寫用原使用者身分啟動的子程式不繼承，但 6.7.4 更新說明寫 Setup 不需要系統管理員權限時仍會繼承；這個安裝檔是 `PrivilegesRequired=lowest`，沒有另一個原使用者程序，它就等於 `Exec`。已撤回。
- 修法：`[Setup]` 加 `RedirectionGuard=no`（`#if VER >= EncodeVer(6, 7, 0)` 包起來，舊版 ISCC 不認得這個設定）。這個保護是防止提升權限的安裝程式被一般使用者建的 junction 騙去改受保護的位置；這個安裝檔不提升權限、只裝在使用者自己的資料夾，關掉不會讓任何程式多拿到權限。Claude Code 的 auto mode 把這個改動判成「降低安全性」擋下，使用者 2026-10-30 同意後才改。uv 沒有關掉 minor version junction 的設定（另一條路是安裝檔自己下載 Python，不用 uv 管理的，改動大，沒有做）。
- 沒查清楚：微軟的說明只寫「由非系統管理員帳號建立的 junction」，系統管理員帳號在 UAC 下沒提升權限時建的 junction 算不算，原文沒有寫，所以 README 只說一般使用者帳號會遇到。
- 修好後還沒在使用者的實機上重裝，只在 CI 的一般使用者帳號上驗證。


## 附錄

### 量測工具與重現

```bash
cd ~/Desktop/tofel/tab-transcriber
uv run --project host python docs/research/tab-transcription/bench_whisper.py docs/research/tab-transcription/corpus/alice-one-syllable-ch02.mp3 base.en small.en
# 顯示卡：先 uv sync --project host --extra gpu，並照 host/run_host.sh 設好 LD_LIBRARY_PATH
host/.venv/bin/python docs/research/tab-transcription/bench_whisper.py <音檔> --device cuda large-v3-turbo
host/.venv/bin/python docs/research/tab-transcription/bench_partial.py <音檔> large-v3-turbo cuda
./install.sh
node tests/e2e.mjs --audio <英文音檔> --start 60 --duration 75 --shots /tmp/shots
node docs/research/tab-transcription/nav_probe.mjs              # 第 12 節，只有點圖示的權限
node docs/research/tab-transcription/nav_probe.mjs --all-urls   # 加所有網站權限
node docs/research/tab-transcription/yt_captions_probe.mjs dQw4w9WgXcQ jNQXAC9IVRw   # 第 13 節
CUDA_VISIBLE_DEVICES= host/.venv/bin/python -I docs/research/tab-transcription/bench_noise_cut.py   # 第 13 節，只用 CPU
```

原始數據：`docs/research/tab-transcription/bench-results.jsonl`。

第 9 節（泰文、翻譯）：

```bash
# FLEURS：https://huggingface.co/datasets/google/fleurs 的 data/th_th/dev.tsv 與 data/th_th/audio/dev.tar.gz
host/.venv/bin/python docs/research/tab-transcription/bench_fleurs.py <th dev.tsv> <解壓後的 wav 資料夾> large-v3-turbo --device cuda
python3 docs/research/tab-transcription/bench_translate.py host/vendor/llama.cpp/llama-server ~/.cache/tab-transcriber/models/Hy-MT2-1.8B-Q8_0.gguf --ctx 1024 --temperature 0
cd docs/research/tab-transcription && ../../../host/.venv/bin/python bench_bilingual.py <llama-server> <模型.gguf> corpus/fleurs-th-dev.mp3 --lang th --start 0
```

原始數據：`bench-fleurs-th.jsonl`、`bench-translate.jsonl`、`bench-bilingual.jsonl`。

第 10 節（卡在重複）：

```bash
git show 39c1b2f:host/transcriber_host.py > /tmp/old_host.py
host/.venv/bin/python docs/research/tab-transcription/bench_stuck.py /tmp/old_host.py
```

原始數據：`bench-stuck.jsonl`。

第 11 節（連續狀聲詞）：

```bash
git show 91eb594:host/transcriber_host.py > /tmp/old_host.py
host/.venv/bin/python docs/research/tab-transcription/bench_repeat.py /tmp/old_host.py
host/.venv/bin/python -m unittest tests/test_repeats.py
```

原始數據：`bench-repeat.jsonl`。

### 限制

- 只測過 headless Brave，沒有測真的 Brave 視窗。以下要使用者實際操作才能確認：
  - 側邊欄是否會打開
  - 聲音是否真的從喇叭出來（程式只檢查了 AudioContext 狀態是 running）
- 只測過清楚的單人朗讀。多人對話、背景音樂、口音較重的錄音沒有測。
- 切段用的是簡單的音量門檻。背景音樂一直很大聲時找不到停頓，會退回每 25 秒強制切一段。
- 日文在第 7 節只量了 small；medium、large-v3-turbo 因為記憶體事故沒量完，第 8 節改用顯示卡補量。
- 把上一段文字當提示時，如果錄音內容和提示一模一樣（只有人工測試才會發生），Whisper 會觸發重試，25 秒的段落要 12–14 秒才轉完。真實影片的配樂片段也會觸發同樣的重試，第 10 節已加上限。

### 來源

- Chrome for Developers, "Audio recording and screen capture"（tabCapture＋offscreen 的官方範例，含「Continue to play the captured audio to the user」）：https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- MDN, SpeechRecognition.start()（audioTrack 參數標示為實驗功能、不是 Baseline）：https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start
- Chrome for Developers, Translator API（Chrome 138 起、語言清單含 ja 與 zh-Hant）：https://developer.chrome.com/docs/ai/translator-api
- Chromium blink-dev, Intent to Ship: On-device Web Speech API：https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/TQpe9shjCgAJ
- PyPI ctranslate2 4.8.3（有 cp39–cp314 wheel）：https://pypi.org/project/ctranslate2/
- Google FLEURS 資料集（CC-BY-4.0，102 種語言的朗讀與逐字稿，各語言同一組句子）：https://huggingface.co/datasets/google/fleurs
- 騰訊 Hy-MT2-1.8B 模型卡（33 種語言含泰文、繁體中文；翻譯提示與建議參數）：https://huggingface.co/tencent/Hy-MT2-1.8B
- Hy-MT2-1.8B 官方 GGUF（Q4_K_M、Q6_K、Q8_0）：https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF
- llama.cpp b11840 release（ubuntu-vulkan-x64 的 SHA-256 在 release 頁）：https://github.com/ggml-org/llama.cpp/releases/tag/b11840
