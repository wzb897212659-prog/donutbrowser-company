import { spawn } from "node:child_process";
import path from "node:path";

const HARDEN_FILE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  $encoded = [Console]::In.ReadToEnd()
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($encoded))
  $info = New-Object IO.FileInfo($path)
  $info.Refresh()
  if (-not $info.Exists -or $info.Attributes.HasFlag([IO.FileAttributes]::ReparsePoint)) { throw 'invalid file' }
  $current = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $system = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::LocalSystemSid, $null)
  $administrators = New-Object Security.Principal.SecurityIdentifier([Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid, $null)
  $owner = $info.GetAccessControl([Security.AccessControl.AccessControlSections]::Owner).GetOwner([Security.Principal.SecurityIdentifier])
  if ($owner.Value -ne $current.Value) { throw 'unexpected owner' }
  $security = New-Object Security.AccessControl.FileSecurity
  $security.SetAccessRuleProtection($true, $false)
  $inheritance = [Security.AccessControl.InheritanceFlags]::None
  $propagation = [Security.AccessControl.PropagationFlags]::None
  $allow = [Security.AccessControl.AccessControlType]::Allow
  foreach ($sid in @($current, $system, $administrators)) {
    $security.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, [Security.AccessControl.FileSystemRights]::FullControl, $inheritance, $propagation, $allow)))
  }
  $info.SetAccessControl($security)
  $applied = $info.GetAccessControl([Security.AccessControl.AccessControlSections]::Access)
  if (-not $applied.AreAccessRulesProtected) { throw 'ACL not protected' }
  $expected = @($current.Value, $system.Value, $administrators.Value) | Select-Object -Unique
  $rules = @($applied.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
  if ($rules.Count -ne $expected.Count) { throw 'unexpected ACL count' }
  foreach ($rule in $rules) {
    if ($expected -notcontains $rule.IdentityReference.Value -or $rule.AccessControlType -ne $allow -or [uint32]$rule.FileSystemRights -ne [uint32][Security.AccessControl.FileSystemRights]::FullControl -or $rule.IsInherited) { throw 'unexpected ACL' }
  }
  exit 0
} catch { exit 23 }
`;

export async function hardenSingleUserFile(target: string): Promise<void> {
  const powershell = path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const encodedScript = Buffer.from(HARDEN_FILE_SCRIPT, "utf16le").toString(
    "base64",
  );
  const encodedPath = Buffer.from(target, "utf8").toString("base64");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      powershell,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodedScript,
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "ignore", "ignore"],
      },
    );
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("本地安全文件 ACL 加固超时"));
    }, 30_000);
    child.once("error", () => {
      clearTimeout(timer);
      reject(new Error("无法启动 Windows ACL 加固"));
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error("本地安全文件 ACL 加固失败"));
    });
    child.stdin.end(encodedPath, "utf8");
  });
}
