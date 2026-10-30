; Windows 安裝檔（Inno Setup 6）：把插件和本機程式複製到使用者的程式資料夾，再執行 install.ps1 建環境、下載模型、註冊。
; 不需要系統管理員權限。GitHub Actions（.github/workflows/install.yml）用 ISCC 編譯：
;   ISCC /DAppVersion=0.6.3 installer\TabTranscriber.iss   → installer\Output\TabTranscriberSetup.exe
; 這個檔案存成 UTF-8 加 BOM，Inno Setup 才會把中文當 UTF-8 讀。

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif
#ifexist AddBackslash(CompilerPath) + "Languages\ChineseTraditional.isl"
  #define HaveChinese
#endif

[Setup]
AppId={{0E90572B-B7C6-4A7C-8E83-4888546C7C7C}
AppName=Tab Transcriber
AppVerName=Tab Transcriber {#AppVersion}
AppVersion={#AppVersion}
AppPublisherURL=https://github.com/EdwardLeeee/ai-realtime-speech-extension
DefaultDirName={localappdata}\Programs\TabTranscriber
PrivilegesRequired=lowest
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputBaseFilename=TabTranscriberSetup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
UninstallDisplayName=Tab Transcriber（AI 即時語音辨識插件）
; Inno Setup 6.7 起預設開著 RedirectionGuard：不走一般使用者建的 junction，而且 Setup 啟動的子程式都會繼承。
; install.ps1 裡的 uv 會在 %APPDATA%\uv\python 建 cpython-3.12 junction 再走它，被擋下就是 os error 448（issue #1）。
; ExecAsOriginalUser 只有 Setup 提升了權限時才不繼承（6.7.4 更新說明；CI 用一般使用者實測也一樣被擋）。
; 這個安裝檔不提升權限、只裝在使用者自己的資料夾，關掉不會讓任何程式多拿到權限（2026-10-30 使用者同意）。
#if VER >= EncodeVer(6, 7, 0)
RedirectionGuard=no
#endif

[Languages]
#ifdef HaveChinese
Name: "zh"; MessagesFile: "compiler:Languages\ChineseTraditional.isl"
#endif
Name: "en"; MessagesFile: "compiler:Default.isl"

[CustomMessages]
#ifdef HaveChinese
zh.Preparing=正在下載 Whisper 和翻譯模型、建立環境（第一次約 5–15 分鐘，進度顯示在另一個視窗）…
zh.Failed=安裝沒有完成。詳細原因在：%1%n%n可以重新執行安裝檔再試一次。
zh.OpenFolder=打開插件資料夾
zh.Finished=最後一步：在 Brave（或 Chrome、Edge）打開 brave://extensions，打開右上角的「開發人員模式」，按「載入未封裝項目」，選這個資料夾：%n%n%1%n%n完成後把 Tab Transcriber 釘選到工具列，到播放影片的分頁點它就會開始。
#endif
en.Preparing=Downloading the Whisper and translation models and setting up (5–15 minutes the first time; progress is shown in a separate window)…
en.Failed=Setup did not finish. Details are in:%n%1%n%nYou can run the installer again to retry.
en.OpenFolder=Open the extension folder
en.Finished=Last step: open brave://extensions in Brave (or Chrome / Edge), turn on "Developer mode" in the top right, click "Load unpacked" and choose this folder:%n%n%1%n%nThen pin Tab Transcriber to the toolbar and click it on the tab that is playing.

[Files]
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: recursesubdirs ignoreversion
Source: "..\host\transcriber_host.py"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "..\host\run_host.bat"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "..\host\pyproject.toml"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "..\host\uv.lock"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "..\host\.python-version"; DestDir: "{app}\host"; Flags: ignoreversion
Source: "..\install.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\uninstall.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\README.zh-TW.md"; DestDir: "{app}"; Flags: ignoreversion

[Run]
Filename: "{app}\extension"; Description: "{cm:OpenFolder}"; Flags: postinstall shellexec skipifsilent

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{app}\uninstall.ps1"""; Flags: runhidden; RunOnceId: "Unregister"

[UninstallDelete]
; 安裝後才產生的東西。下載到 %USERPROFILE%\.cache 的模型不動（和 Linux 版一樣，README 寫了怎麼刪）
Type: filesandordirs; Name: "{app}\host\.venv"
Type: filesandordirs; Name: "{app}\host\vendor"
Type: filesandordirs; Name: "{app}\host\__pycache__"
Type: files; Name: "{app}\host\com.tab_transcriber.host.json"
Type: files; Name: "{app}\install.log"

[Code]
var
  InstallOk: Boolean;

// 檔案複製完才執行 install.ps1；PowerShell 視窗顯示下載進度（靜默安裝時不顯示）。
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  ShowCmd: Integer;
begin
  if CurStep <> ssPostInstall then Exit;
  WizardForm.StatusLabel.Caption := CustomMessage('Preparing');
  if WizardSilent then ShowCmd := SW_HIDE else ShowCmd := SW_SHOWNORMAL;
  InstallOk := Exec('powershell.exe',
    '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\install.ps1') + '"',
    ExpandConstant('{app}'), ShowCmd, ewWaitUntilTerminated, ResultCode) and (ResultCode = 0);
  if not InstallOk then
    SuppressibleMsgBox(FmtMessage(CustomMessage('Failed'), [ExpandConstant('{app}\install.log')]), mbError, MB_OK, IDOK);
end;

// install.ps1 失敗時 Setup.exe 回 10（不是 0），靜默安裝和 CI 才看得出來
function GetCustomSetupExitCode: Integer;
begin
  if InstallOk then Result := 0 else Result := 10;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if (CurPageID = wpFinished) and InstallOk then
    WizardForm.FinishedLabel.Caption := FmtMessage(CustomMessage('Finished'), [ExpandConstant('{app}\extension')]);
end;
