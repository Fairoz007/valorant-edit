# Changelog

## Valorant Editor (fork of Aditor 0.4.6)

### Unreleased

#### Added

- **Vertical and square export**: an output frame choice (Source, 16:9, 9:16, 1:1) with three reframe modes — crop (with a
  left/right offset), blurred-background fit and black bars. One shared geometry function (`app/src/shared/reframe.ts`) drives both
  the FFmpeg filter and the live preview in the export drawer, so the preview matches the exported file pixel for pixel.
- **Platform presets**: YouTube (source size, capped at 4K), YouTube Shorts, TikTok, Instagram Reels (1080×1920) and Square post
  (1080×1080) with frame-rate caps and a length warning that can trim the export to the platform limit
  (`app/src/shared/exportPresets.ts`).
- **H.265 (HEVC) export** with NVENC, Quick Sync and AMF, detected with the same test encode as H.264; MP4 output is tagged
  `hvc1` for Apple devices and web players. No libx265 (the bundled FFmpeg stays LGPL-only).
- Export format choices are remembered in settings; reframing, presets and H.265 automatically switch to precise export with a notice.
- **Auto montage** (Settings → Recording → Auto montage, off by default, VALORANT only): after each recorded match is analyzed
  (trusted live results or full analysis, built-in recorder or OBS), the app picks the best highlights and exports one montage
  in the chosen preset (16:9, 9:16 or 1:1), with no user action.
  - Ranking is ace > 4k > 3k > clutch > 2k > single. Overlaps are merged, multi-kills are never split and the total is capped
    at the max length; clips you skipped stay out.
  - Each export is checked with ffprobe (duration within ±0.5 s, video and audio present) before it is added to the library
    as a "Montage" entry and you get a notification ("Montage ready — 6 clips, 0:48"). Opening the entry opens its project
    in Studio.
  - Jobs survive restarts and resume exactly once, with no duplicates. "After each match" runs at below-normal priority
    while the game runs and idle priority while recording; "After VALORANT closes" waits.
  - Low disk, too few highlights, a missing source, no hardware encoder (OpenH264 fallback), a failed analysis, cancel and
    quit are all handled; the recording panel shows the status with Open / Retry / Cancel.
  - Turning it on while post-recording analysis is "No analysis" switches analysis to "After each match" after asking.
  - "Keep source recording" off deletes the per-match recording only after a verified export.
- **Auto edit** (Studio and the Library selection bar): pick one or more analyzed videos, a target length (30 s, 1 min,
  3 min, all or custom), a style, optional music, deaths on/off and an output preset, see a live estimate, and get an editable
  project.
  - Selection uses the same ranker as Auto montage (`shared/highlightScore.ts`, user-editable weights), fits the target
    within ±1 s, and orders clips chronologically or as a build-up.
  - Styles as data: **Clean** (cuts), **Cinematic** (dip to black, slow-mo, letterbox, intro/outro), **Hype** (dip to
    white, zoom punch, flashes, beat-synced cuts with music) and **Shorts** (9:16, ≤60 s, big captions).
  - Captions ("DOUBLE KILL", "TRIPLE KILL", "QUADRA KILL", "ACE", "CLUTCH") use the bundled Montserrat Black.
  - Music is mixed in the app with fades and ducking under game audio.
  - Project items show effect badges, and everything stays editable.
  - Real renders matched the planned length exactly (Clean 21.0 s, Hype 22.5 s, Cinematic 25.7 s, Shorts 21.0 s).
- Project schema v2 (per-clip speed, audio gain, effects, caption and transition; project style, music, intro/outro, letterbox
  and preset). v1 project files are migrated on load and left untouched on disk.

- **In-game overlay** (Settings → Recording → In-game overlay, off by default since settings version 4, see Fixed below):
  - Small kill-feed-style cards in a corner of the game for every recorder activity: game detected, recording
    started/paused/resumed/stopped, match found/started/cancelled/over, round won/lost, kills, saved, analysis done, montage
    ready, low disk space, capture fallback (DDA ↔ WGC), warnings and errors.
  - Kills in one round update a single card (KILL → DOUBLE → TRIPLE → QUADRA → ACE), so a five-kill round shows one ACE card.
  - Cards auto-hide after 3 s (1–10 s; errors twice as long), at most three are stacked, and they make no sound. Settings
    cover the corner, duration, kills, rounds and opacity, with a live preview and a "Show test cards" button.
  - The window is transparent, frameless, never focusable, click-through (`setIgnoreMouseEvents`), shown only with
    `showInactive()`, and excluded from capture (`setContentProtection`, WDA_EXCLUDEFROMCAPTURE). It is placed on the
    game's monitor.
  - Measured on Windows 11 with `app/scripts/verify-overlay-capture.cjs`, using the real overlay page and the real recorder:
    the cards were absent from the DDA and WGC recordings and visible in a control recording without content protection.
    The foreground window never changed (`docs/screenshots/overlay-excluded-from-recording.png`).
  - Exclusive fullscreen cannot show other windows. There, and on Windows builds older than 2004 (no capture exclusion),
    notices become Windows toasts once the game loses focus. Settings tells you to use Windowed Fullscreen.

#### Fixed

- **In-game overlay no longer comes up over a Fullscreen game, the desktop or other apps** (`docs/recording-mouse-input-fix.md`,
  "Follow-up"). Reported: with VALORANT in Fullscreen at a stretched 4:3 resolution, the game minimized when a card appeared,
  the overlay stayed on screen, and the menu pointer was gone after a recording until VALORANT was restarted.
  - Cards are shown only while the game is the foreground window in Windowed Fullscreen or Windowed mode. A game that is not
    in front gets a Windows toast instead (before, the overlay fell back to the last or the primary monitor, i.e. over the
    desktop). Fullscreen with its own display mode (`aditorrec --foreground` now reports `display_mode_changed` and
    `covers_monitor`), exclusive fullscreen, an unknown foreground, or no GPU compositing (no real transparency) show no card.
  - The overlay window exists only while a card is on screen: it is destroyed after the last card and at once when a check
    (every second while a card shows) finds the game no longer in front. Its topmost band is set once at creation instead of
    being re-asserted on every card.
  - The overlay is **off by default**. Settings saved before version 4 had it on as the old default, so it is turned off once;
    from version 4 on your choice is kept. Settings and onboarding explain that Fullscreen shows no cards.
  - Toasts also wait until the game loses focus, whether or not the overlay is on.
  - The overlay page sets no CSS cursor. `app/scripts/verify-overlay-cursor.cjs` (new) shows the real overlay window over a
    focused test window that holds the pointer and checks cursor flags, cursor handle, `WindowFromPoint`, the foreground
    window and the cursor clip every 50 ms: unchanged, and hit-testing passed through to the window below.
  - "Record mouse cursor" now says that it only changes the video, never the pointer on screen.
  - Not verified in a VALORANT match: see "What is still unverified" in the findings doc.
  - Not yet checked over a running VALORANT match.

- **Record gameplay only** (VALORANT, built-in recorder):
  - "Gameplay only (one file per match)" is now the default recording mode. Settings saved by older versions on the old
    "Whole session" default move to it once; a "Whole session" chosen from this version on is kept.
  - A match file now starts at the first round's buy phase (the first frame with the top-HUD score, from the live
    engine's round tracker), not at the Riot Client's INGAME, which begins at the loading screen.
  - The menus, queue and agent select were already outside matches. The start is never moved past a detected kill or
    death, and is not moved at all when the HUD was first seen more than 180 s after INGAME or no round was detected.
  - The Range and the tutorial no longer count as matches, read from the presence's `provisioningFlow`/`matchMap`. These
    field names come from community documentation and were not checked against a live client.
  - Riot Client unreachable: the session is still recorded whole with no pruning. At save time only the stretches the live
    engine proved to be gameplay (rounds and events, padded) are kept, and only if detection stayed healthy for the
    whole recording; otherwise everything is kept.
  - Riot Client dropped out mid-session (live detection not complete): the detected matches are cut as before, and the
    footage outside them is now kept as one more file instead of being deleted.
  - Optional **Trim buy phase** (off by default) also cuts the buy phase between rounds, never within 5 s of a kill or
    death. The parts are joined with FFmpeg's concat demuxer (stream copy), checked with the bundled FFmpeg: 12 s in,
    4 s cut, a decodable 8 s file starting at 0.
  - Covered by fake-FFmpeg scenario tests: lobby → agent select → loading → match → menus, a kill before the HUD, a
    remake, a dodge, Riot Client unreachable (healthy and incomplete), Riot Client dropping out, and trim buy phase.
    Not yet checked on a real VALORANT recording. The OBS backend still records each match from INGAME.

- **Recording UI**:
  - Recording panel: a status header with a big state pill (Idle / Paused / Waiting for match / Recording match N /
    Saving / Error, with a pulsing red dot while recording), elapsed time, and Capture-method and Overlay on/off chips.
    It has stat tiles (kills this match, round score, match, disk left), one primary Start/Stop button plus Pause/Resume,
    and an inline error banner with a fix hint and a link to Recording settings. Technical details are folded away.
  - New status fields `inMatch` and `score` (Riot Client round results) feed it.
  - Rail: the recording icon shows a pulsing red dot while recording, blue while starting or saving and amber after an
    error, on every screen, with the state as its name.
  - Settings → Recording is grouped into What to record (mode, trim buy phase, analysis), Auto montage, Capture,
    In-game overlay (with a live preview card and a test button), Quality, Audio, and Storage and notifications.
    Advanced rows are folded under "Advanced options".
  - Library cards show the match result and score (W 13–9 / L 8–13, from the analysis rounds of single-match
    recordings), kills, and a Montage badge.
  - Onboarding has a new step explaining Windowed Fullscreen for the overlay, with an on/off choice.
  - Before/after screenshots are in `docs/screenshots/` (`before-*` from `main`, `after-*` from this branch), taken
    with `app/e2e/screenshots.spec.ts` (fake engine, E2E-only status hook `ADITOR_E2E_RECORDING_STATUS`).

#### Known limitations

- The pinned LGPL FFmpeg is a minimal build (no `xfade`, `fade`, `drawtext`, `amix`, `sidechaincompress`, `atempo`, `zoompan`).
  Transitions are therefore cuts or dips, drawn with stepped `drawbox` alpha, not crossfades. Captions are rendered to PNG and
  overlaid. Slow-motion parts play without game audio. Music must be `.m4a`, `.mp4`, `.mov`, `.mkv`, `.mka`, `.webm` or
  `.avi`; MP3, WAV and FLAC cannot be read.
- Beat sync snaps cut points to energy onsets only; it does not track tempo.

#### Changed

- **Export drawer redesign**: preset cards, live crop preview, grouped Format / Quality / Output sections with an Advanced section,
  a summary line (size · fps · codec · estimated size · duration) and inline reasons for disabled options.
- **UI polish pass** across Library, Studio, Settings and the shell: consistent spacing and radii, stronger hover/focus/selected
  states, AA-contrast text and subtle motion that respects reduced motion and low-performance mode.

### Changed

- **Renamed to Valorant Editor**: product name, window title, tray, notifications, installer names (`ValorantEditor-Setup-<version>.exe`),
  app id `com.valoranteditor.app`, data folder `%APPDATA%\Valorant Editor`, default recording/export folder `Videos\Valorant Editor`.
- **English is the default language**: new installs start in English instead of Traditional Chinese, and the language menu lists
  English first. Leftover hard-coded Chinese text (log messages, development fixtures, a settings search keyword and a
  date format that was fixed to `zh-TW`) is now English or follows the active locale.
- **Diagnostics are off by default** and no Sentry DSN is bundled, so no crash data is sent anywhere unless you configure your own project.
- **Updates** now point at `Fairoz007/valorant-edit` GitHub Releases.

### Fixed

- The overlay preload no longer shares a module with the main preload. A shared chunk would be `require`d by the
  sandboxed main preload, which cannot load it, so `window.api` disappeared. This came in with the overlay and was
  caught by the e2e run before release; `overlay-preload.test.ts` guards it.
- **Mouse stops working after a recording starts** (details in `docs/recording-mouse-input-fix.md`):
  - The game watcher no longer opens the game process. It used `process.kill(pid, 0)` every 3 s, which on Windows is
    `OpenProcess(PROCESS_TERMINATE | …)` on the Vanguard-protected VALORANT process; it now only asks `tasklist` by image name.
  - Nothing may show, focus or raise an app window, or open a dialog, while the game is the foreground window; such calls wait
    until the game loses focus or exits (`main/focus-guard.ts`, foreground read with `aditorrec --foreground`, no process handle).
  - `ready-to-show` is handled once, so reloading a tray-hidden window can no longer pop it over the game.
  - The recorder only lifts its frame thread back to normal priority when its process is below normal.
  - Measured: recording with WGC and with DDA, cursor capture on, never changed the foreground window, cursor clip or
    cursor visibility (new ignored e2e tests). Not yet checked in a real VALORANT match.
- **A Sage resurrect of the player is no longer counted as a death** (`valorant-feed@11`, so cached analyses are redone).
  Measured on 6 newly labelled 960×720 30 fps clips (21 events, ±1 s):
  - before: 17 correct / 2 false / 4 missed;
  - after: 18 / 1 / 3. Deaths are 12/12 at precision 1.0.
  The remaining misses are long kill rows wider than the kill-feed crop, so the killer-side chevron is cut off; a wider
  capture area is not part of this change. The 720p reference clip's fixtures still pass; the clip itself was not re-run.
- **Recorder test fixtures** (`init-*.mp4`) are committed with their generator, so the recorder tests run on a clean checkout.
- **Windows build and tests:**
  - `scripts\build.ps1` / `test.ps1` find `vcvars64.bat` when `vswhere` lists no Visual Studio, and print which one they use.
  - Engine debug builds and tests find the pinned FFmpeg in `build\ffmpeg` without it being on PATH.
  - `tools\evaluate_valorant.py` and `icon_accept.py` start under `py -3 -I`.
- **No console windows**: `aditor.exe` and `ffmpeg -encoders` are spawned hidden. The AppUserModelId matches the installer, so
  toasts carry the app identity.
- **Own kills and deaths on compressed footage**: the kill-feed detector (`engine/src/valorant/feed.rs`) now finds the player's
  rows when the thin yellow row outline blurs away (e.g. 720p uploads), using the solid yellow chevron plus ally teal on the
  player's side. It accepts small death-side chevrons, death chevrons under the red death-screen tint, and faint kill-side
  chevrons; a fill limit (0.35–0.80) rejects solid yellow blocks. Measured on one hand-labelled 720p 60 fps clip
  (19 kills, 12 deaths, ±1.0 s):

  | Build | Kills detected / correct | Deaths detected / correct | Precision | Recall |
  |---|---|---|---|---|
  | Before (Aditor import, 67d211e) | 4 detected (not scored) | 1 detected (not scored) | — | — |
  | fa348ce (first chevron fix) | 19 / 17 | 10 / 10 | 0.931 | 0.871 |
  | This change | 19 / 19 | 12 / 12 | 1.000 | 1.000 |

  `templates_version` is now `valorant-feed@10`, so cached analyses are redone. Only one clip is labelled; native 1080p is
  covered by single-frame fixtures only. Details in `docs/VALORANT-EDITOR-AUDIT.md`.

### Added

- `app/src/shared/english-default.test.ts`: checks the English defaults, scans every English string for untranslated text and
  renders each Settings page in English.
- `docs/VALORANT-EDITOR-AUDIT.md`: technical audit, feature-gap report and roadmap.
- `tools/eval_feed_labels.py` and hand labels in `tools/labels/videoplayback.json`: score kill/death detection against labels
  (±1.0 s, per type, one-to-one).
- Engine tests `own_rows_on_compressed_footage_are_confirmed`, `rows_that_are_not_the_players_are_rejected` and
  `native_1080p_player_rows_stay_detected`, with real kill-feed crops in `engine/tests/fixtures/valorant_feed/`.

### Kept unchanged (internal names)

- Engine/recorder executables (`aditor.exe`, `aditorrec.exe`), `ADITOR_*` environment variables and the `.aditor.json` analysis
  cache format are internal and were not renamed, so the Windows build scripts and existing caches keep working.

---

The history below is inherited from upstream Aditor (Traditional Chinese).

## Aditor

## v0.4.6

### 修正

- **VALORANT 分局檔改以正確遊戲分析**：將一支含多場對戰的影片「分局」後，切出的檔不再一律標為 Apex，而是沿用原影片的遊戲；同時保留遊戲與畫面比例標籤，4:3 等非 16:9 的 VALORANT 分局檔不再被當成 16:9 分析。
- **無法錄影的混合顯示卡筆電可改用視窗擷取**：部分混合 GPU 筆電的螢幕擷取（DDA）回報不支援（`0x887A0004`），而 Windows 10 的自動擷取一律選擇 DDA，導致完全無法錄影。現在遇到此錯誤會對同一遊戲程序改用視窗擷取（WGC）重試一次並提示使用者。
- **錄影不再因空的第一段卡住**：錄影器等待第一個影格逾時後，只留下空的第一段的工作現在會直接丟棄，不再回報收尾失敗、封鎖錄影直到重新啟動，也不會讓下次啟動的補收尾一直失敗。
- **遊戲重新啟動時改為等待新視窗**：視窗擷取開始的瞬間若遊戲視窗已被關閉，現在會等待遊戲的新視窗，不再當成擷取失敗。
- **遊戲偵測不再失敗**：遊戲行程查詢改為一次只執行一個 `tasklist`；先前同時執行多個時，部分電腦會出現 `0xC0000142`（DLL 初始化失敗）而無法偵測遊戲。
- **防毒或同步程式短暫鎖檔不再中斷逐局剪檔**：錄影工作的狀態檔被暫時鎖住時，會短暫重試（約 1.5 秒）後再放棄。
- **在檔案總管刪除的錄影可重新產生**：已收尾的影片若在程式外被刪除（檔案總管、防毒），只要錄影段落還在，下次啟動會重新剪出，不再每次啟動都補收尾失敗。
- **持續交戰畫面不再切斷對局**：Apex 對局切分時，畫面上仍有小地圖與血條等交戰介面就不會誤判為開場畫面，避免把一場對局切成兩段。
- **網路路徑影片不再匯入後無法儲存**：`\\伺服器\共用資料夾` 這類網路路徑的影片與監看資料夾現在會在匯入時就被拒絕；先前可以匯入與分析，但編輯內容、重新分析與匯出都會失敗。請改用對應的磁碟代號。
- **存檔更可靠**：分析快取與設定檔改為寫入完整並同步到磁碟後才取代舊檔（與媒體庫、專案相同），避免存檔後立刻斷電或磁碟已滿時留下空白或不完整的檔案。
- **移除影片時一併清除代理檔與縮圖**：先前從媒體庫移除的影片，其預覽用代理檔與縮圖會一直留在應用程式資料夾。分析快取仍刻意保留，因為其中包含編輯內容。
- **清除中斷的匯出暫存檔**：合併匯出中途當機或被強制結束時留在匯出資料夾的 `.aditor-seg-*` 中間檔，會在下次匯出開始時清除。

### 錯誤回報改善

- 已不存在的麥克風或輸出裝置改歸類為「找不到音訊裝置」，不再回報為「音訊來源意外停止」。
- 影片解碼完全失敗時附帶 ffmpeg 的結束代碼。
- 硬體編碼送出或接收失敗時保留 FFmpeg 的錯誤原因（僅限可列印 ASCII、最多 200 字元，不含路徑）。
- OBS WebSocket 連線失敗時保留關閉代碼，可區分驗證失敗與無法連線。
- 錄影服務失敗附帶失敗的系統呼叫名稱（不含路徑）。

### 已知限制

- 尚未驗證：以真實 VALORANT 多場錄影實際分局、1440p／超寬螢幕錄影的分析準確度、遊戲 FPS 影響。
- Windows 執行檔未進行程式碼簽章。

### 更新方式

- **0.2.2 至 0.4.5 安裝版**可透過自動更新升級。
- **0.2.0／0.2.1 安裝版**請手動下載並執行 `Aditor-Setup-0.4.6.exe`。
- **免安裝版**請下載 `Aditor-0.4.6-Portable.exe` 手動更新。

## v0.4.5

### 新增與改善

- **分析引擎影像運算加速**：縮放、HSV、白色遮罩與長核形態學運算改為位元層級等價的更快實作。非 16:9 來源的縮放（1080p 縮至 720p）由 146.6 毫秒降至 13.0 毫秒（11.3 倍）；480×118 白色遮罩由 550 微秒降至 72 微秒（7.7 倍）；長核形態學由 11.0 毫秒降至 4.9 毫秒（2.3 倍）。1080p 即時偵測每影格約快 3%（16.19 → 15.67 毫秒）。
- **觀戰畫面與分析前置加速**：
  - 觀戰影格不再執行會被丟棄的 Mixtape 偵測並預先準備樣板，觀戰影格偵測由 21.99 毫秒降至 5.26 毫秒（4.2 倍），一般影格約快 4.7%。
  - 平行分析的分段改為平衡「實際解碼長度」：226 秒影片最長解碼段由 88.5 秒降至 80.6 秒（−9%），整體分析中位數 22.18 → 21.66 秒。
  - 未帶遊戲標籤的影片（匯入檔）其遊戲與畫面比例取樣改在同一解碼視窗內完成：前置階段由 4.38 秒降至 3.64 秒（−17%），整體分析 14.86 → 14.17 秒（−4.7%）。取樣影格逐位元相同，分析結果與修改前一致。
- **錄影器喚醒次數降低**：音訊混音迴圈由每秒 271 次喚醒降至 98 次，WGC 管理迴圈由每秒 9.0 次降至 0.99 次，讓筆電在錄影時 CPU 更容易進入深層閒置。
- **遊戲偵測更省電**：遊戲未執行時改為針對各遊戲的篩選查詢（約 31 毫秒），不再每 3 秒列出全部行程（約 500 毫秒 CPU，約佔單一核心 16.7%）；遊戲執行中以輕量存活檢查取代，並每 30 秒完整比對一次以防範 PID 重用。
- **匯入與編輯器儲存加速**：內容未變的資料庫更新不再重寫並同步整份資料庫，也不再廣播更新。500 筆資料庫中，500 次未變更狀態更新由 1,350.6 毫秒降至 281.2 毫秒，100 次未變更精華更新由 206.6 毫秒降至 9.6 毫秒。

### 修正

- **錄影啟動不再執行編碼器探測**：錄影啟動時不再對每張 GPU 的每個編碼器做試編碼與音訊裝置列舉。先前在負載高的 Intel Arc 機器上，該探測會於 30 秒期限內在不同階段逾時，導致錄影重試持續失敗。
- **監看失敗後可自動恢復**：資料夾監看器失敗後會重新建立；Studio 相關 Hook 補齊遺漏的相依項目，避免使用過時狀態。
- **錯誤回報涵蓋已攔截的錄影服務失敗**：已被攔截處理的錄影服務失敗現在也會回報，協助診斷。

### 已知限制

- 效能數據來自本機基準測試（AMD Ryzen 7 7700 與負載不一的開發機），不代表所有硬體；分析整體加速幅度僅約 2% 至 5%。
- 遊戲行程查詢改為快取後，若 PID 被重用且查詢持續成功，「遊戲結束」的判定最多可能延遲約 30 秒外加一次防抖間隔。
- 尚未驗證：1440p／超寬螢幕錄影的分析準確度、21:9／4:3 匯入影片的比例偵測、60 秒硬體錄影量測與遊戲 FPS 影響。
- Windows 執行檔未進行程式碼簽章。

### 更新方式

- **0.2.2 至 0.4.4 安裝版**可透過自動更新升級。
- **0.2.0／0.2.1 安裝版**請手動下載並執行 `Aditor-Setup-0.4.5.exe`。
- **免安裝版**請下載 `Aditor-0.4.5-Portable.exe` 手動更新。

## v0.4.4

### 新增與改善

- 啟用錯誤回報時，於本機應用程式資料夾產生隨機 UUID v4 安裝識別碼（`user.id`），用於統計各問題影響的安裝數量（不衍生自硬體、帳號或路徑，仍不收集 IP；未啟用時不建立，關閉錯誤回報時立即刪除；既有已啟用者亦可隨時於「設定」關閉以刪除）。
- 分析引擎、錄影器或即時辨識執行檔缺失或無法啟動時，顯示多語系說明提示並保留安全的系統錯誤碼（`spawn_errno`）。
- 改善錯誤回報分組與診斷：以穩定英文分類歸併子程序錯誤、區分音訊配置錯誤與時間戳缺口、忽略外部強制終止（`0x40010004`、`0xC000013A`），並於解碼失敗、錄影索引讀寫失敗與即時引擎異常結束時附帶去識別化診斷摘要。

### 修正

- 修正追補固定影格率（CFR）影格時未先排空音訊佇列，導致已排隊音訊被靜音覆蓋的問題。
- 改善錄影暫時卡頓後的恢復能力：超過 2 秒的視訊缺口改以稀疏補幀降級、超過 5 秒的音訊缺口改以每次最多 0.5 秒分批補齊靜音；封裝佇列等待上限提高至 10 秒並加上 64 MiB 記憶體上限；編碼連續 5 秒無輸出時發送單次警告，滿 60 秒才判定失敗。
- 音訊裝置開啟失敗或錄影中途失效時，保留時間軸並以靜音填補，同時每秒自動重試原裝置。

### 更新方式

- **0.2.2 至 0.4.3 安裝版**可透過應用程式內的自動更新下載並安裝。
- **0.2.0／0.2.1 安裝版**請手動下載並執行 `Aditor-Setup-0.4.4.exe`。
- **免安裝版**請下載 `Aditor-0.4.4-Portable.exe`。

## v0.4.3

### 新增與改善

- 新增錄影擷取方式的遊戲 FPS 影響標示，協助選擇擷取方式。

### 修正

- 修正錄影啟動與執行期間的音訊遺失：保留麥克風音訊、回報擷取中斷，並在混音器延遲啟動時保留 AAC 仍可接收的音訊。
- 修正多聲道音訊轉成立體聲時，後方與側邊環繞聲道遭丟棄的問題。
- 修正靜音後音訊時間戳、DDA 擷取可見性計時，以及 Riot Client 斷線時誤刪錄影分段的問題。
- 修正遊戲視窗結束時 Hook 擷取的等待行為，以及缺少引擎或錄影器執行檔時重複回報錯誤的問題。

### 更新方式

- 安裝版可透過應用程式內的更新功能下載並安裝。
- 免安裝版請下載 `Aditor-0.4.3-Portable.exe`。

---

# Aditor Changelog

## v0.4.4

### Improvements

- Send a random UUID v4 install ID (`user.id`) stored in the local app data directory when error reporting is enabled so issues show how many installs they affect (not derived from hardware, account or path data, IP addresses are still never collected, never created while disabled, and deleted immediately on opt-out; existing opted-in users can disable error reporting in Settings at any time to delete it).
- Show localized guidance and preserve a safe `spawn_errno` when the analysis engine, recorder or live-detection executable is missing or cannot start.
- Improve telemetry grouping and diagnostics: group child faults by stable English categories, separate audio allocation errors from timestamp gaps, ignore external termination exits (`0x40010004`, `0xC000013A`), and include redacted `stderr` tails or distinct messages for decode, recording-index and live-engine faults.

### Fixes

- Drain queued audio between CFR catch-up frames so queued audio is not overwritten with silence during catch-up.
- Recover bounded recordings after temporary stalls: degrade video gaps over 2 seconds to sparse catch-up frames, fill audio gaps over 5 seconds in 0.5-second chunks, raise the mux queue full timeout to 10 seconds with 64 MiB payload caps, and warn once after 5 seconds of encoder stall before failing at 60 seconds.
- Preserve the audio timeline with silence and retry the audio source every second when an audio device fails to open or drops out during recording.

### Updating

- **0.2.2 through 0.4.3 installs** can download and install this update from within the app.
- **0.2.0/0.2.1 installs** need to download and run `Aditor-Setup-0.4.4.exe` manually.
- **Portable builds**: download `Aditor-0.4.4-Portable.exe`.

## v0.4.3

### Improvements

- Show the measured game FPS impact of recording capture methods to help users choose a method.

### Fixes

- Prevent audio loss during recording startup and capture interruptions; preserve microphone audio, report capture failures, and retain startup audio that AAC can still accept when mixing starts late.
- Preserve rear and side surround channels when downmixing multichannel audio to stereo.
- Fix audio timestamps after silence, DDA capture visibility timing, and accidental deletion of recording segments after a Riot Client disconnect.
- Improve Hook capture shutdown when the game window closes and avoid duplicate error reports when the engine or recorder executable is missing.

### Updating

- Installed builds can download and install this update from within the app.
- For the portable build, download `Aditor-0.4.3-Portable.exe`.
