# 用瀏覽器插件把分頁播放的英文錄音轉成文字稿：可行性研究

- 日期：2026-10-24
- 負責：tofel session（研究後直接實作，程式在本 repo）
- 問題：「你有辦法幫我做一個網頁插件，可以把英文播放的錄音做出文字稿嗎？」使用者選了「本機 Whisper」與「每句前面加時間」。

## 先說結論

1. 做得到，而且在 Brave 155 實測過整條流程。分頁音訊 → 本機 Whisper → 側邊欄文字稿，75 秒朗讀轉出 13 句、230 個字，內容和原文幾乎一致。
2. 這台電腦只用 CPU 就夠快。small.en 轉 60 秒錄音中位數 10.0 秒（最慢 10.1 秒），比播放快 6 倍。實際邊播邊轉時，每段 6–13 秒的錄音約 2–2.8 秒轉完，文字大約在講完一句後 3–15 秒出現。
3. 比原先方案更省的地方：改用 native messaging，讓瀏覽器在錄音時才啟動本機程式、停止就結束。不用常駐伺服器，也不開本機網路埠。
4. 建議維持 CPU＋small.en。之後若使用者在 Ubuntu 裝了 NVIDIA 驅動，再加 CUDA 函式庫改用 GPU＋medium.en。

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

### 翻譯（暫停）

- 使用者改口「可以不用即時翻譯」，所以暫停。
- 已查證的候選：騰訊 Hy-MT2-1.8B（Apache-2.0、官方 GGUF、支援 ja 與 zh-Hant、Q8_0 1.9 GB），可以用 llama.cpp b11840 的 Vulkan 版跑，那一版看得到 RTX 2060。
- 模型和 llama.cpp 已經下載，但還沒量速度和品質：
  - `~/.cache/tab-transcriber/models`，4.2 GB
  - `host/vendor/`，127 MB

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

### 限制

- 只測過 headless Brave，沒有測真的 Brave 視窗。以下要使用者實際操作才能確認：
  - 側邊欄是否會打開
  - 聲音是否真的從喇叭出來（程式只檢查了 AudioContext 狀態是 running）
- 只測過清楚的單人朗讀。多人對話、背景音樂、口音較重的錄音沒有測。
- 切段用的是簡單的音量門檻。背景音樂一直很大聲時找不到停頓，會退回每 25 秒強制切一段。
- 日文只量了 small；medium、large-v3-turbo 因為記憶體事故沒有量完。
- 把上一段文字當提示時，如果錄音內容和提示一模一樣（只有人工測試才會發生），Whisper 會觸發重試，25 秒的段落要 12–14 秒才轉完。

### 來源

- Chrome for Developers, "Audio recording and screen capture"（tabCapture＋offscreen 的官方範例，含「Continue to play the captured audio to the user」）：https://developer.chrome.com/docs/extensions/how-to/web-platform/screen-capture
- MDN, SpeechRecognition.start()（audioTrack 參數標示為實驗功能、不是 Baseline）：https://developer.mozilla.org/en-US/docs/Web/API/SpeechRecognition/start
- Chrome for Developers, Translator API（Chrome 138 起、語言清單含 ja 與 zh-Hant）：https://developer.chrome.com/docs/ai/translator-api
- Chromium blink-dev, Intent to Ship: On-device Web Speech API：https://groups.google.com/a/chromium.org/g/blink-dev/c/VNOok2dbmHM/m/TQpe9shjCgAJ
- PyPI ctranslate2 4.8.3（有 cp39–cp314 wheel）：https://pypi.org/project/ctranslate2/
