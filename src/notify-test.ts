import { spawn } from 'node:child_process';

const title = 'ADY monitor testi';
const message = 'Windows notification işləyir.';

const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$notify = New-Object System.Windows.Forms.NotifyIcon
$notify.Icon = [System.Drawing.SystemIcons]::Information
$notify.BalloonTipTitle = ${toPowerShellString(title)}
$notify.BalloonTipText = ${toPowerShellString(message)}
$notify.Visible = $true
$notify.ShowBalloonTip(10000)
Start-Sleep -Seconds 10
$notify.Dispose()
`;

const child = spawn(
  'powershell.exe',
  ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { detached: true, stdio: 'ignore', windowsHide: true },
);

child.unref();
console.log('Test notification göndərildi.');

function toPowerShellString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}
