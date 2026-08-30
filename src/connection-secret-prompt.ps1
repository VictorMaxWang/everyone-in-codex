[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$RouterScript,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9][a-z0-9-]{0,62}$')]
    [string]$ConnectionId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = [System.Windows.Forms.Form]::new()
$form.Text = 'Everyone in Codex - API Key'
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MinimizeBox = $false
$form.MaximizeBox = $false
$form.ClientSize = [System.Drawing.Size]::new(520, 150)
$form.TopMost = $true

$label = [System.Windows.Forms.Label]::new()
$label.Text = "Enter the API Key for '$ConnectionId'. It is sent directly to Codex Router."
$label.AutoSize = $true
$label.Location = [System.Drawing.Point]::new(18, 18)

$input = [System.Windows.Forms.TextBox]::new()
$input.UseSystemPasswordChar = $true
$input.Location = [System.Drawing.Point]::new(18, 50)
$input.Size = [System.Drawing.Size]::new(482, 27)

$ok = [System.Windows.Forms.Button]::new()
$ok.Text = 'Save'
$ok.DialogResult = [System.Windows.Forms.DialogResult]::OK
$ok.Location = [System.Drawing.Point]::new(330, 100)

$cancel = [System.Windows.Forms.Button]::new()
$cancel.Text = 'Cancel'
$cancel.DialogResult = [System.Windows.Forms.DialogResult]::Cancel
$cancel.Location = [System.Drawing.Point]::new(420, 100)

$form.AcceptButton = $ok
$form.CancelButton = $cancel
$form.Controls.AddRange(@($label, $input, $ok, $cancel))
$form.Add_Shown({ $input.Focus() })

$plain = $null
try {
    if ($form.ShowDialog() -ne [System.Windows.Forms.DialogResult]::OK) {
        exit 2
    }
    $plain = [string]$input.Text
    $input.Text = ''
    if ([string]::IsNullOrWhiteSpace($plain)) {
        throw 'API Key must not be empty.'
    }
    # 凭据只经 stdin 进入 Router；不会成为命令参数、环境变量或普通 JSON。
    $plain | & $RouterScript connections secret-set $ConnectionId | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw "Codex Router rejected the API Key (exit $LASTEXITCODE)."
    }
} finally {
    $input.Text = ''
    $plain = $null
    $form.Dispose()
}

