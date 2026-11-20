// Win32 credential adapter for Antigravity login state.
// Antigravity keeps its Google OAuth token in Windows Credential Manager under
// the generic credential "gemini:antigravity" (plain JSON blob), plus the
// active account pointer in %APPDATA%\Antigravity\credential-user-scope.
const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const CREDENTIAL_TARGET = 'gemini:antigravity';
const USER_SCOPE_FILE = 'credential-user-scope';
const APP_STORAGE_FILE = 'app_storage.json';
const LAST_LOGIN_KEY = 'agy.onboarding.lastLoginUsername';

// One PowerShell script, four modes (read|write|protect|unprotect) so the
// Add-Type P/Invoke definition is compiled once per invocation mode.
// Payload travels over stdin as JSON to avoid argument quoting pitfalls; the
// mode is baked into the script because -EncodedCommand swallows the rest of
// the command line, so it cannot travel as a trailing argument.
const POWERSHELL_SOURCE = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class NativeCred {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    public struct CREDENTIAL {
        public int Flags; public int Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
        public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredReadW(string target, int type, int reservedFlag, out IntPtr credentialPtr);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern bool CredWriteW(ref CREDENTIAL credential, int flags);
    [DllImport("advapi32.dll")]
    public static extern void CredFree(IntPtr cred);
    [StructLayout(LayoutKind.Sequential)]
    public struct DATA_BLOB { public int cbData; public IntPtr pbData; }
    [DllImport("crypt32.dll", SetLastError = true)]
    public static extern bool CryptProtectData(ref DATA_BLOB inBlob, string description, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB outBlob);
    [DllImport("crypt32.dll", SetLastError = true)]
    public static extern bool CryptUnprotectData(ref DATA_BLOB inBlob, string description, ref DATA_BLOB entropy, IntPtr reserved, IntPtr prompt, int flags, ref DATA_BLOB outBlob);
    public static byte[] ReadCred(string target, out int type, out int persist, out string userName, out int err) {
        IntPtr ptr; type = 0; persist = 0; userName = null;
        if (!CredReadW(target, 1, 0, out ptr)) { err = Marshal.GetLastWin32Error(); return null; }
        err = 0;
        try {
            CREDENTIAL cred = (CREDENTIAL)Marshal.PtrToStructure(ptr, typeof(CREDENTIAL));
            type = cred.Type; persist = cred.Persist; userName = cred.UserName;
            byte[] blob = new byte[cred.CredentialBlobSize];
            if (cred.CredentialBlob != IntPtr.Zero && cred.CredentialBlobSize > 0)
                Marshal.Copy(cred.CredentialBlob, blob, 0, cred.CredentialBlobSize);
            return blob;
        } finally { CredFree(ptr); }
    }
    public static int WriteCred(string target, string userName, int persist, byte[] blob) {
        CREDENTIAL cred = new CREDENTIAL();
        cred.Flags = 0; cred.Type = 1; cred.TargetName = target; cred.UserName = userName;
        cred.CredentialBlobSize = blob.Length;
        cred.CredentialBlob = Marshal.AllocHGlobal(blob.Length);
        cred.Persist = persist;
        try {
            Marshal.Copy(blob, 0, cred.CredentialBlob, blob.Length);
            if (!CredWriteW(ref cred, 0)) return Marshal.GetLastWin32Error();
            return 0;
        } finally { Marshal.FreeHGlobal(cred.CredentialBlob); }
    }
    public static byte[] Transform(byte[] input, bool protect) {
        DATA_BLOB inBlob = new DATA_BLOB(); DATA_BLOB outBlob = new DATA_BLOB(); DATA_BLOB entropy = new DATA_BLOB();
        inBlob.cbData = input.Length; inBlob.pbData = Marshal.AllocHGlobal(input.Length);
        try {
            Marshal.Copy(input, 0, inBlob.pbData, input.Length);
            bool ok = protect
                ? CryptProtectData(ref inBlob, "EasyAG account profile", ref entropy, IntPtr.Zero, IntPtr.Zero, 0, ref outBlob)
                : CryptUnprotectData(ref inBlob, null, ref entropy, IntPtr.Zero, IntPtr.Zero, 0, ref outBlob);
            if (!ok) throw new Exception("DPAPI transform failed, error " + Marshal.GetLastWin32Error());
            byte[] output = new byte[outBlob.cbData];
            Marshal.Copy(outBlob.pbData, output, 0, outBlob.cbData);
            return output;
        } finally { Marshal.FreeHGlobal(inBlob.pbData); }
    }
}
"@
$mode = '__EASYAG_MODE__'
$raw = [Console]::In.ReadToEnd()
$payload = if ($raw.Trim()) { $raw | ConvertFrom-Json } else { $null }
switch ($mode) {
  'read' {
    $type = 0; $persist = 0; $userName = $null; $err = 0
    $blob = [NativeCred]::ReadCred('${CREDENTIAL_TARGET}', [ref]$type, [ref]$persist, [ref]$userName, [ref]$err)
    if ($null -eq $blob) {
      if ($err -eq 1168) { @{ found = $false } | ConvertTo-Json -Compress }
      else { throw "CredReadW failed, error $err" }
    } else {
      @{ found = $true; userName = $userName; type = $type; persist = $persist; blobB64 = [Convert]::ToBase64String($blob) } | ConvertTo-Json -Compress
    }
  }
  'write' {
    $bytes = [Convert]::FromBase64String($payload.blobB64)
    $err = [NativeCred]::WriteCred('${CREDENTIAL_TARGET}', $payload.userName, [int]$payload.persist, $bytes)
    if ($err -ne 0) { throw "CredWriteW failed, error $err" }
    @{ ok = $true } | ConvertTo-Json -Compress
  }
  'protect' {
    $bytes = [Convert]::FromBase64String($payload.dataB64)
    @{ dataB64 = [Convert]::ToBase64String([NativeCred]::Transform($bytes, $true)) } | ConvertTo-Json -Compress
  }
  'unprotect' {
    $bytes = [Convert]::FromBase64String($payload.dataB64)
    @{ dataB64 = [Convert]::ToBase64String([NativeCred]::Transform($bytes, $false)) } | ConvertTo-Json -Compress
  }
  default { throw "Unknown mode: $mode" }
}
`;

function encodeCommand(script) {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const MODES = ['read', 'write', 'protect', 'unprotect'];

// execFile with a writable stdin; payload travels over stdin, never argv.
function executeWithInput(file, args, options, input) {
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, options, (error, stdout, stderr) => {
      if (error) reject(new Error(`${error.message}${stderr ? `: ${stderr.trim()}` : ''}`));
      else resolve({ stdout, stderr });
    });
    child.stdin.end(input === undefined ? '' : input);
  });
}

async function runMode(mode, payload, { execute = executeWithInput, platform = process.platform } = {}) {
  if (platform !== 'win32') throw new Error('账号功能当前仅支持 Windows（凭据存储走 Windows 凭据管理器）');
  if (!MODES.includes(mode)) throw new Error(`未知凭据操作: ${mode}`);
  const script = POWERSHELL_SOURCE.replace('__EASYAG_MODE__', mode);
  const { stdout } = await execute('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encodeCommand(script)],
    { windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 },
    payload === null || payload === undefined ? undefined : JSON.stringify(payload)
  );
  const text = stdout.trim().replace(/^\uFEFF/, '');
  if (!text) throw new Error(`凭据操作无输出（${mode}）`);
  return JSON.parse(text);
}

// Read the live credential. Returns null when Antigravity has not logged in.
async function readAntigravityCredential({ execute = executeWithInput, platform = process.platform } = {}) {
  const result = await runMode('read', null, { execute, platform });
  if (!result.found) return null;
  return { userName: result.userName, type: result.type, persist: result.persist, blobB64: result.blobB64 };
}

// Overwrite the live credential with a previously captured one.
async function writeAntigravityCredential(credential, { execute = executeWithInput, platform = process.platform } = {}) {
  if (!credential?.blobB64) throw new Error('缺少凭据内容');
  const result = await runMode('write', {
    userName: credential.userName ?? 'antigravity',
    persist: Number.isFinite(credential.persist) ? credential.persist : 2,
    blobB64: credential.blobB64
  }, { execute, platform });
  if (!result.ok) throw new Error('写入凭据失败');
  return true;
}

async function protectData(buffer, { execute = executeWithInput, platform = process.platform } = {}) {
  const result = await runMode('protect', { dataB64: buffer.toString('base64') }, { execute, platform });
  return Buffer.from(result.dataB64, 'base64');
}

async function unprotectData(buffer, { execute = executeWithInput, platform = process.platform } = {}) {
  const result = await runMode('unprotect', { dataB64: buffer.toString('base64') }, { execute, platform });
  return Buffer.from(result.dataB64, 'base64');
}

function antigravityUserDataDir() {
  const appData = process.env.APPDATA || path.join(require('node:os').homedir(), 'AppData', 'Roaming');
  return path.join(appData, 'Antigravity');
}

function readUserScope() {
  try {
    return fs.readFileSync(path.join(antigravityUserDataDir(), USER_SCOPE_FILE), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function writeUserScope(scope) {
  fs.mkdirSync(antigravityUserDataDir(), { recursive: true });
  fs.writeFileSync(path.join(antigravityUserDataDir(), USER_SCOPE_FILE), scope, 'utf8');
}

// Antigravity 2.33+ stopped persisting id_token_email inside the credential blob
// (the field is omitempty in the language server's StoredToken). The last
// completed login is still recorded in the app's own storage, which lets us
// identify a fresh login without asking the user.
function readLastLoginEmail() {
  try {
    const raw = fs.readFileSync(path.join(antigravityUserDataDir(), APP_STORAGE_FILE), 'utf8').replace(/^\uFEFF/, '');
    const value = JSON.parse(raw)?.[LAST_LOGIN_KEY];
    return typeof value === 'string' && value.includes('@') ? value.trim() : null;
  } catch {
    return null;
  }
}

module.exports = {
  CREDENTIAL_TARGET,
  readAntigravityCredential,
  writeAntigravityCredential,
  protectData,
  unprotectData,
  antigravityUserDataDir,
  readUserScope,
  writeUserScope,
  readLastLoginEmail
};
