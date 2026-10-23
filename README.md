# Tab Transcriber：英文／日文錄音轉文字稿

Brave／Chrome 插件。把分頁正在播放的英文或日文錄音（練習網站、YouTube、Podcast 網頁……）轉成每句附時間的文字稿：

```
[00:05] They must go by the mail, she thought, and how funny it'll seem to send shoes to one's own feet,
[00:10] how odd the address will look.
```

- 在這台電腦上用 Whisper（faster-whisper）轉，聲音和文字都不會上傳。有 NVIDIA 顯示卡就用顯示卡跑 large-v3-turbo 模型，沒有就用 CPU 跑 small 模型。
- 即時字幕：側邊欄最下面會出現淺色的字幕，用顯示卡時約每 1 秒更新一次（只有 CPU 時約 2 秒）；一句講完停頓後，再定稿成正式的一行。剛按開始時要先載入模型，第一行字幕會多等 2–3 秒。
- 錄音時照常聽得到聲音。
- 轉文字的程式只在錄音時啟動，停止後就結束，平常不常駐。錄音期間最多佔約 1.8 GB 系統記憶體（顯示卡模式；只有 CPU 時約 1.3 GB）。

## 安裝（只要做一次）

1. 在終端機執行：

   ```bash
   ~/Desktop/tofel/tab-transcriber/install.sh
   ```

   這一步會建 Python 環境、下載 Whisper 模型，並在 Brave、Chrome 的設定資料夾登記「本機轉文字程式」的位置。偵測到 NVIDIA 驅動時，會另外裝顯示卡用的 CUDA 函式庫（約 2 GB）和 large-v3-turbo 模型（約 1.6 GB）。

2. 在 Brave 網址列打開 `brave://extensions`（Chrome 用 `chrome://extensions`）。
3. 打開右上角的「開發人員模式」。
4. 按「載入未封裝項目」，選 `~/Desktop/tofel/tab-transcriber/extension` 資料夾。
5. 按工具列的拼圖圖示，把 **Tab Transcriber** 釘選到工具列。

## 使用

1. 打開要聽的錄音網頁，按播放。
2. 點工具列的 Tab Transcriber 圖示：右側會打開側邊欄，用上次選的語言開始錄音（第一次是英文）。
3. 語言不對的話：按「停止」，在左上的選單改成「日文」或「英文」，再按「開始」。選過的語言會記住。
4. 聽完按側邊欄的「停止」。
5. 「複製」會把文字稿複製到剪貼簿，「下載 .txt」會存成文字檔。「清除」要連按兩次，避免誤刪。

注意：

- 每句前面的時間是**從開始錄音算起**，不是影片或錄音本身的播放時間。想讓兩者對齊，就先點圖示再按播放。
- 換過網頁後要再點一次圖示（瀏覽器規定插件只能錄使用者點過的分頁）。
- 一次只錄一個分頁。錄音中到別的分頁點圖示只會打開側邊欄，不會切換；要先按「停止」，再到新分頁點圖示。
- 一句話中間停頓超過 0.4 秒，偶爾會被切成兩行（例如 `look through to` / `the garden with one eye.`），文字本身不受影響。
- 文字稿存在瀏覽器裡，關掉側邊欄或重開瀏覽器都還在，按「清除」才會刪掉。

## 換模型

想換模型，可以新增 `~/.config/tab-transcriber/config.json`，只寫要改的部分。`gpu_models` 是有顯示卡時用的，`models` 是只有 CPU 時用的：

```json
{ "gpu_models": { "en": "medium.en" }, "models": { "ja": "medium" } }
```

在這台電腦（RTX 2060／12 執行緒 CPU）上量到的速度：

| 模型 | 跑在 | 60 秒錄音要轉多久 | 即時字幕每次更新要多久 | 說明 |
|---|---|---|---|---|
| `large-v3-turbo`（有顯示卡時的預設） | 顯示卡 | 約 1.9 秒 | 0.3–0.4 秒 | 英文、日文都最準 |
| `small.en`／`small` | 顯示卡 | 約 1.5 秒 | 0.1–0.4 秒 | 較快，錯字較多 |
| `medium.en`／`medium` | 顯示卡 | 約 4 秒 | 沒有量 | 日文偶爾會重複最後一句 |
| `small.en`（只有 CPU 時的預設，英文） | CPU | 約 10 秒 | 1.3–2.1 秒 | 字幕約 2 秒更新一次 |
| `small`（只有 CPU 時的預設，日文） | CPU | 約 12 秒 | 沒有量 | 有錯字，例如「穴から**はい出ました**」轉成「穴から入れました」 |

改完下次按開始就會生效。第一次用新模型會先下載。

## 疑難排解

| 看到的訊息 | 怎麼辦 |
|---|---|
| 找不到本機轉文字程式 | 執行一次 `install.sh`，再按開始 |
| 請切到要轉文字的分頁，點工具列上的圖示 | 回到播放錄音的分頁，點工具列圖示（不要按側邊欄的「開始」） |
| 本機轉文字程式意外結束 | 看 `~/.cache/tab-transcriber/host.log` 的最後幾行 |

## 移除

1. 在 `brave://extensions` 移除 Tab Transcriber。
2. 執行 `~/Desktop/tofel/tab-transcriber/uninstall.sh`（刪除登記檔）。
3. 不需要的話，再刪掉這個資料夾和 `~/.cache/huggingface/hub` 裡的 `faster-whisper` 模型。

## 開發

```
extension/   插件（Manifest V3）
  background.js   錄音流程：tabCapture → 背景錄音頁 → 本機程式 → 寫進 storage
  offscreen.js    錄分頁聲音、播回喇叭、降到 16 kHz、在停頓處切段
  pcm-worklet.js  AudioWorklet，每 100 ms 交出一塊聲音
  sidepanel.*     側邊欄
host/        本機轉文字程式（native messaging host，Python + faster-whisper，用 uv 管）
tests/e2e.mjs  端到端測試：headless Brave 載入插件、播英文錄音、模擬點圖示、檢查文字稿
docs/research/ 選型筆記與速度量測
```

測試（要先執行過 `install.sh`）：

```bash
node tests/e2e.mjs --audio <英文音檔.mp3> --start 60 --duration 75
```

插件 ID 固定為 `pclblnfmncjbohcnbhlkgefpdhpljiae`（由 `manifest.json` 的 `key` 決定），`install.sh` 的登記檔只允許這個 ID 連線。
