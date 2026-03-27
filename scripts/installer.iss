; MötesSkribent — Inno Setup installer script
; Replaces Tauri's NSIS bundler (NSIS 32-bit crashes on payloads >1.8 GB)
;
; Usage:
;   iscc scripts\installer.iss
;   iscc /DMyAppVersion=0.4.2 scripts\installer.iss   (override version)

#ifndef MyAppVersion
  #define MyAppVersion "0.4.4"
#endif

#define MyAppName "MötesSkribent"
#define MyAppPublisher "MötesSkribent"
#define MyAppExeName "motesskribent-app.exe"

[Setup]
AppId={{B8A3D5E1-7F42-4C19-9E6A-2D1F8B3C5E7A}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
DefaultDirName={localappdata}\{#MyAppName}
DefaultGroupName={#MyAppName}
PrivilegesRequired=lowest
OutputDir=..\output
OutputBaseFilename=MötesSkribent_{#MyAppVersion}_x64-setup
Compression=lzma2/ultra64
SolidCompression=yes
SetupIconFile=..\src-tauri\icons\icon.ico
UninstallDisplayIcon={app}\{#MyAppExeName}
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
WizardStyle=modern
DisableProgramGroupPage=yes

[Languages]
Name: "swedish"; MessagesFile: "compiler:Languages\Swedish.isl"

[Tasks]
Name: "desktopicon"; Description: "Skapa genväg på skrivbordet"; GroupDescription: "Ytterligare ikoner:"; Flags: unchecked

[Files]
; Main Tauri app executable
Source: "..\src-tauri\target\release\{#MyAppExeName}"; DestDir: "{app}"; Flags: ignoreversion

; Sidecar (PyInstaller bundle + models)
Source: "..\src-tauri\sidecar\*"; DestDir: "{app}\sidecar"; Flags: ignoreversion recursesubdirs createallsubdirs

; WebView2 offline installer (installed if needed)
Source: "..\src-tauri\MicrosoftEdgeWebView2RuntimeInstallerX64.exe"; DestDir: "{tmp}"; Flags: deleteafterinstall nocompression

[Icons]
Name: "{group}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"
Name: "{group}\Avinstallera {#MyAppName}"; Filename: "{uninstallexe}"
Name: "{autodesktop}\{#MyAppName}"; Filename: "{app}\{#MyAppExeName}"; Tasks: desktopicon

[Run]
Filename: "{app}\{#MyAppExeName}"; Description: "Starta {#MyAppName}"; Flags: nowait postinstall skipifsilent

[Code]
function IsWebView2Installed: Boolean;
var
  Version: String;
begin
  // Check both HKLM (system-wide) and HKCU (per-user) for WebView2 Runtime
  Result := RegQueryStringValue(HKLM,
    'SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEF-ED47D884521C}',
    'pv', Version) or
    RegQueryStringValue(HKLM,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEF-ED47D884521C}',
    'pv', Version) or
    RegQueryStringValue(HKCU,
    'SOFTWARE\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BEF-ED47D884521C}',
    'pv', Version);
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    if not IsWebView2Installed then
    begin
      Log('WebView2 Runtime saknas, installerar...');
      if not Exec(ExpandConstant('{tmp}\MicrosoftEdgeWebView2RuntimeInstallerX64.exe'),
        '/silent /install', '', SW_HIDE, ewWaitUntilTerminated, ResultCode) then
      begin
        MsgBox('Kunde inte starta WebView2-installern. ' +
          'MötesSkribent kräver WebView2 för att fungera.' + #13#10 + #13#10 +
          'Ladda ner WebView2 manuellt från:' + #13#10 +
          'https://developer.microsoft.com/en-us/microsoft-edge/webview2/',
          mbError, MB_OK);
      end
      else if ResultCode <> 0 then
      begin
        MsgBox('WebView2-installationen misslyckades (felkod: ' +
          IntToStr(ResultCode) + ').' + #13#10 + #13#10 +
          'MötesSkribent kräver WebView2 för att fungera.' + #13#10 +
          'Ladda ner WebView2 manuellt från:' + #13#10 +
          'https://developer.microsoft.com/en-us/microsoft-edge/webview2/',
          mbError, MB_OK);
      end
      else if not IsWebView2Installed then
      begin
        MsgBox('WebView2 verkar inte ha installerats korrekt.' + #13#10 + #13#10 +
          'MötesSkribent kräver WebView2 för att fungera.' + #13#10 +
          'Ladda ner WebView2 manuellt från:' + #13#10 +
          'https://developer.microsoft.com/en-us/microsoft-edge/webview2/',
          mbError, MB_OK);
      end;
    end else
    begin
      Log('WebView2 Runtime redan installerat.');
    end;
  end;
end;
