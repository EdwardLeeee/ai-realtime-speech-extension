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
6. 第一次在真實 Brave 視窗使用時，配樂多、講話少的段落讓字幕卡住 4–12 秒。原因是 Whisper 卡在重複同一句，已限制產生長度與重試次數，最壞從約 10 秒降到 2 秒以內（第 10 節）。

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

文字不同的 2 次都是同一段泰文，這段本來就要靠隨機的溫度重試才轉得出來：用改前的設定連跑兩次，結果也不一樣。

即時字幕的溫度組合比較：

| 組合 | 卡住時 | 和改前不同 |
|---|---|---|
| 0、0.4、0.8（採用） | 1.0–1.3 秒 | 上述泰文 |
| 0、0.2…1.0（預設六個，只加上限） | 1.7–1.8 秒 | 上述泰文 |
| 0、0.6 | 0.8–1.1 秒 | 上述泰文，加上日文一段少了開頭兩個字 |

端到端測試全部通過，殘留程序都是 0：日文 40 秒雙語開、泰文 84 秒雙語開、英文 60 秒中途開關。

### 限制

- 這次只把卡住的時間壓到 2 秒以內。幻覺句本身還是可能出現，只是比較短，也比較不會一路傳到下一段。
- 沒有使用者當時的錄音，只能用合成的配樂重現。真實影片的效果要等使用者再試一次。

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
